/**
 * Run the additive project-level Integration Agent without replaying the
 * module pipeline. The target is expected to contain the assembled result of a
 * previous module run. Hidden tests are intentionally absent from this script;
 * they are run by the external evaluator after this process exits.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseEnvironmentFile } from 'dotenv';
import type { AddressInfo } from 'node:net';
import type { WorkspaceCompileCommand } from '@forexplore/contracts';
import { prepareIntegrationTranslationScope } from '../apps/vscode-extension/src/module-translation-handoff.js';
import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';
import { createHttpServer } from '../services/adaptation-service/src/http-server.js';
import { CodexWorkspaceTranslationRuntime } from '../services/adaptation-service/src/codex-workspace-translation-runtime.js';
import { prepareDeepSeekCodexHome } from '../services/adaptation-service/src/codex-experiment-home.js';
import { prepareProjectIntegrationContext, type ProjectIntegrationModule } from '../services/adaptation-service/src/project-integration-context.js';
import { loadGlobalProtocol } from '../services/adaptation-service/src/protocol-sidecar.js';

const argument = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const targetRoot = resolve(argument('target') ?? '');
if (!targetRoot || !existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) throw new Error('--target must be a project directory.');
const outputPath = resolve(argument('out', join(targetRoot, '..', 'project-integration-pass.json'))!);
const reportPath = argument('module-report');
const protocolPath = resolve(argument('protocol', join(dirname(outputPath), 'global-protocol.json'))!);
const previous = reportPath && existsSync(resolve(reportPath))
  ? JSON.parse(readFileSync(resolve(reportPath), 'utf8')) as { modules?: ProjectIntegrationModule[] }
  : { modules: [] };

function compileCommand(): WorkspaceCompileCommand {
  const configured = process.env.ADAPTATION_WORKSPACE_COMPILE_COMMAND?.trim();
  if (configured) return JSON.parse(configured) as WorkspaceCompileCommand;
  const entries = readdirSync(targetRoot);
  const solution = entries.find(name => name.endsWith('.sln'));
  if (solution) return { executable: 'dotnet', args: ['build', solution, '--nologo', '--verbosity', 'quiet'], timeoutMs: 900_000 };
  if (entries.includes('pom.xml')) return { executable: 'mvn', args: ['-q', '-DskipTests', 'package'], timeoutMs: 1_200_000 };
  if (entries.includes('package.json')) return { executable: 'npm', args: ['run', '--silent', 'build'], timeoutMs: 900_000 };
  if (entries.includes('Cargo.toml')) return { executable: 'cargo', args: ['check'], timeoutMs: 900_000 };
  if (entries.includes('go.mod')) return { executable: 'go', args: ['build', './...'], timeoutMs: 900_000 };
  throw new Error('No compile command configured for the integration target.');
}

const context = await prepareProjectIntegrationContext(targetRoot, previous.modules ?? []);
const loadedProtocol = await loadGlobalProtocol(protocolPath, `${targetRoot}:${outputPath}`);
if (loadedProtocol.error) console.warn(`Integration protocol unavailable; continuing with empty protocol: ${loadedProtocol.error.slice(0, 300)}`);
const { writeFiles, readOnlyFiles } = context;
const extension = writeFiles[0]?.split('.').at(-1)?.toLowerCase();
const language = ({cs:'C#', java:'Java', py:'Python', go:'Go', rs:'Rust', ts:'TypeScript', tsx:'TypeScript', js:'TypeScript'} as Record<string,string>)[extension ?? ''] ?? 'Text';
const environmentFile = resolve('services/adaptation-service/.env');
if (existsSync(environmentFile)) for (const [key, value] of Object.entries(parseEnvironmentFile(readFileSync(environmentFile)))) if (!process.env[key]?.trim()) process.env[key] = value;
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const model = process.env.ADAPTATION_CODEX_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
const codexHome = await prepareDeepSeekCodexHome({
  explicitHome: process.env.ADAPTATION_CODEX_HOME?.trim() || undefined,
  apiKey,
  model,
  baseUrl: process.env.ADAPTATION_CODEX_BASE_URL?.trim() || process.env.DEEPSEEK_API_BASE?.trim(),
});
let server: ReturnType<typeof createHttpServer> | undefined;
let runtime: CodexWorkspaceTranslationRuntime | undefined;
try {
  runtime = new CodexWorkspaceTranslationRuntime({
    workspaceRoot: targetRoot,
    compileCommand: compileCommand(),
    codexCommand: process.env.ADAPTATION_CODEX_COMMAND?.trim() || 'codex',
    codexModel: model,
    codexHome: codexHome.path,
    environment: codexHome.environment,
    maxModelTurns: Number(process.env.ADAPTATION_WORKSPACE_MAX_TURNS ?? 4),
    timeoutMs: Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000),
  });
  const token = randomBytes(32).toString('hex');
  server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Not used by project integration pass'); } }, workspaceTranslation: { runtime, bearerToken: token } });
  await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as AddressInfo;
  const host = new WorkspaceTranslationHost(() => ({ url: `http://127.0.0.1:${address.port}`, token }));
  const scope = await prepareIntegrationTranslationScope({ workspaceRoot: targetRoot, targetLanguage: language, ...context, globalProtocol: loadedProtocol.protocol });
  const scopeId = host.rememberModuleScope(scope);
  const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'integration-describe', action: 'describe', moduleScopeId: scopeId });
  if (described.type !== 'WORKSPACE_TRANSLATION_RESULT' || !described.profile) throw new Error(`describe failed: ${JSON.stringify(described)}`);
  const started = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'integration-start', action: 'start', moduleScopeId: scopeId, profileId: described.profile.profileId });
  if (started.type !== 'WORKSPACE_TRANSLATION_RESULT' || !started.run) throw new Error(`start failed: ${JSON.stringify(started)}`);
  let run = started.run;
  let lastProgress = '';
  const deadline = Date.now() + Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000);
  while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 2_000));
    const response = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'integration-read', action: 'read', runId: run.id });
    if (response.type !== 'WORKSPACE_TRANSLATION_RESULT' || !response.run) throw new Error(`read failed: ${JSON.stringify(response)}`);
    run = response.run;
    const progress = `integration ${run.status} turns=${run.modelTurns} changes=${run.changes.length}`;
    if (progress !== lastProgress) { console.log(progress); lastProgress = progress; }
  }
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) run = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'integration-cancel', action: 'cancel', runId: run.id }).then(response => {
    if (response.type !== 'WORKSPACE_TRANSLATION_RESULT' || !response.run) throw new Error(`cancel failed: ${JSON.stringify(response)}`);
    return response.run;
  });
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), targetRoot, language, model, writeFiles, readOnlyFiles, moduleReport: reportPath ? resolve(reportPath) : undefined, status: run.status, runId: run.id, changedPaths: run.changes.map(change => change.path), run, hiddenEvaluator: 'not run by integration Agent' };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Integration result: ${outputPath}`);
  if (run.status !== 'completed') process.exitCode = 1;
} finally {
  await runtime?.shutdown().catch(() => undefined);
  await runtimeShutdown(server);
  await codexHome.cleanup();
}

async function runtimeShutdown(httpServer: ReturnType<typeof createHttpServer> | undefined): Promise<void> {
  if (!httpServer) return;
  await new Promise<void>(resolveClose => httpServer.close(() => resolveClose()));
}
