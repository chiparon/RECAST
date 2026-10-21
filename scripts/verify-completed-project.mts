/**
 * Run only requirement verification on an isolated copy of an already-built project.
 * Reads public requirements and source ownership from a pipeline report, never plans,
 * historical answers, evaluator output or hidden tests.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { discoverExecutableFunctions } from './module-function-mapping.js';
import { createAgentHost } from '../services/translation-verifier/src/host/runtime.js';
import { createTranslationVerifierModelClient } from '../services/translation-verifier/src/host/model-client.js';
import { resolveTestEnvironment } from '../services/translation-verifier/src/host/test-environment.js';
import { createFunctionGroupVerifier } from '../services/translation-verifier/src/function-group-verify.js';
import type { SingleAgentFunctionGroupTerminalResult } from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy.js';
import type { FunctionGroupTestRun } from '../services/translation-verifier/src/host/tools/common.js';

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error('Missing --' + name);
  return value;
}
const reportPath = resolve(argument('report'));
const projectPath = resolve(argument('project'));
const output = resolve(argument('output'));
if (existsSync(output)) throw new Error('Output directory must be new: ' + output);
const outputRelative = relative(projectPath, output);
if (!outputRelative || !outputRelative.startsWith('..') && !isAbsolute(outputRelative)) throw new Error('Output must be outside the input project.');
mkdirSync(output, { recursive: true });
const project = join(output, 'project');
const excluded = new Set(['.git', '.forexpore', '.forexplore', '.translation-verifier-tests', 'node_modules']);
cpSync(projectPath, project, { recursive: true, filter: path => !excluded.has(basename(path)) });
const report: { modules: Array<{ moduleId: string; module: string; language: string;
  sourceFiles: string[]; changedPaths?: string[]; requirement: string }> } = JSON.parse(readFileSync(reportPath, 'utf8'));
const selected = process.argv.includes('--modules') ? new Set(argument('modules').split(',')) : undefined;
const modules = report.modules.filter(module => !selected || selected.has(module.moduleId));
if (!modules.length) throw new Error('No selected modules.');
const inventory = modules.map(module => {
  const files = [...new Set<string>([...module.sourceFiles, ...(module.changedPaths ?? [])])];
  const functions = discoverExecutableFunctions(Object.fromEntries(files.map(file => {
    const absolute = resolve(project, file);
    const sourceRelative = relative(project, absolute);
    if (!sourceRelative || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) throw new Error('Source path escapes project: ' + file);
    return [file, existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''];
  })));
  return { moduleId: module.moduleId, module: module.module, language: module.language,
    requirement: module.requirement, functions };
});
writeFileSync(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2));
const functionPattern = process.argv.includes('--function-pattern') ? new RegExp(argument('function-pattern')) : undefined;
for (const item of inventory) if (functionPattern) item.functions = item.functions.filter(fn => functionPattern.test(fn.signature ?? fn.name));
writeFileSync(join(output, 'verification-targets.json'), JSON.stringify(inventory, null, 2));
for (const item of inventory) console.log(item.moduleId + ': ' + item.functions.length + ' executable targets');
if (process.argv.includes('--discover-only')) process.exit(0);
if (process.argv.includes('--compile-command') || process.argv.includes('--compile-command-file')) {
  const command = JSON.parse(process.argv.includes('--compile-command-file')
    ? readFileSync(argument('compile-command-file'), 'utf8') : argument('compile-command'));
  const build = spawnSync(command.executable, command.args, { cwd: project, encoding: 'utf8', timeout: 300_000 });
  writeFileSync(join(output, 'compile.log'), (build.stdout ?? '') + (build.stderr ?? ''));
  if (build.status !== 0) throw new Error('Isolated project compile failed. See compile.log');
}
const envPath = resolve('services/adaptation-service/.env');
if (existsSync(envPath)) for (const [key, value] of Object.entries(parse(readFileSync(envPath)))) process.env[key] ||= value;
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('Configured verifier model credential is required.');
const results: unknown[] = [];
for (const item of inventory) {
  console.log('Verifying ' + item.moduleId);
  const evidencePath = join(output, item.moduleId + '.jsonl');
  const runs: FunctionGroupTestRun[] = [];
  let testVersion = 0;
  const host = createAgentHost<SingleAgentFunctionGroupTerminalResult>({
    modelClient: createTranslationVerifierModelClient({ apiKey: key,
      apiBase: process.env.DEEPSEEK_API_BASE, model: process.env.DEEPSEEK_MODEL }),
    limits: { maxDurationMs: 900_000, maxTurns: 64 },
    resolveToolContext: async task => {
      const environment = await resolveTestEnvironment(task);
      return { ...task, sourceDirectory: '.', targetDirectory: '.', testRoots: environment.testRoots,
        testRunner: environment.framework, targetTest: environment.targetTest,
        cleanup: async () => {
          // Save the actual runnable harness before the Host removes its disposable copy.
          for (const testRoot of environment.testRoots) {
            const harnessRoot = dirname(join(project, testRoot));
            if (testRoot.startsWith('.translation-verifier-tests/')) cpSync(harnessRoot,
              join(output, 'tests', item.moduleId, basename(harnessRoot)), { recursive: true });
            else cpSync(join(project, testRoot), join(output, 'tests', item.moduleId), { recursive: true });
          }
          await environment.cleanup?.();
        },
      };
    },
    traceLogger: event => {
      if (!['tool.started', 'tool.completed', 'tool.failed', 'run.completed', 'run.failed'].includes(event.event)) return;
      if (event.event.startsWith('tool.') && !['write_target_test', 'run_function_group_tests', 'finish_function_group', 'report_uncertain'].includes(String(event.toolName))) return;
      appendFileSync(evidencePath, JSON.stringify(event, (_, value) => typeof value === 'string' ? value.split(key).join('[REDACTED]') : value) + '\n');
      if (event.event === 'tool.started' && event.toolName === 'write_target_test') {
        const write = JSON.parse(String(event.arguments));
        const versionRoot = join(output, 'test-versions', item.moduleId, String(++testVersion));
        mkdirSync(versionRoot, { recursive: true });
        writeFileSync(join(versionRoot, basename(write.path)), write.content);
      }
      if (event.event === 'tool.completed' && event.toolName === 'run_function_group_tests') {
        const run = event.output as FunctionGroupTestRun;
        runs.push(run);
        console.log(item.moduleId + ': tests=' + run.tests.executed + ' failed=' + run.tests.failed +
          ' covered=' + run.functions.filter(fn => fn.executed).length + '/' + run.functions.length);
      }
    },
  });
  let result: unknown;
  try {
    result = item.functions.length ? await createFunctionGroupVerifier(host)({
      schemaVersion: '3.1', mode: 'requirement', sourceLanguage: item.language,
      targetLanguage: item.language, targetProjectPath: project,
      requirement: item.requirement,
      functions: item.functions.map(target => ({ target })),
    }, 'requirement-function-group', 'verify') : { status: 'failure', reason: 'mapping-invalid', functions: [] };
  } catch (error) {
    result = { status: 'failure', error: error instanceof Error ? error.message : String(error) };
  }
  results.push({ moduleId: item.moduleId, result, testRuns: runs });
  writeFileSync(join(output, 'verification.json'), JSON.stringify(results, null, 2));
  console.log(item.moduleId + ': ' + JSON.stringify(result));
}
