// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyGlobalProtocol, type SearchCandidate } from '@forexplore/contracts';
import { ProjectPipeline } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import type { CodexRuntime, ProjectPipelineBackend as Backend } from './project-pipeline-backend';
import type { ProjectPipelineModule } from './project-pipeline-types';

it.each([false, true])('packages the adapter and runs real Codex staging, compiler, proactive Integration and isolated Git delivery (history: %s)', async withHistory => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-codex-pipeline-'));
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(path.resolve(import.meta.dirname, '../../../services/code-indexer/package.json'));
  let backend: Backend | undefined;
  try {
    const backendPath = path.join(import.meta.dirname, 'project-pipeline-backend.ts');
    const runtimePath = path.resolve(import.meta.dirname, '../../../services/adaptation-service/src/codex-workspace-translation-runtime.ts');
    const compilerPath = path.resolve(import.meta.dirname, '../../../services/adaptation-service/src/workspace-compiler.ts');
    const bundle = path.join(root, 'pipeline.cjs');
    await build({ stdin: { contents: `export { ProjectPipelineBackend } from ${JSON.stringify(backendPath)}; export { CodexWorkspaceTranslationRuntime } from ${JSON.stringify(runtimePath)}; export { compileWorkspace } from ${JSON.stringify(compilerPath)};`, resolveDir: import.meta.dirname },
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'native-grammars', setup(build) {
        build.onResolve({ filter: /^(tree-sitter|@tree-sitter-grammars)/ }, args => ({ path: nativeRequire.resolve(args.path), external: true }));
      } }] });
    const packaged = require(bundle) as { ProjectPipelineBackend: typeof Backend; CodexWorkspaceTranslationRuntime: new (options: unknown) => CodexRuntime;
      compileWorkspace: typeof import('../../../services/adaptation-service/src/workspace-compiler').compileWorkspace };
    const source = path.join(root, 'source'); await mkdir(source); await mkdir(path.join(source, 'src'));
    const skeleton = 'export function answer() { return 0; }\n';
    await writeFile(path.join(source, 'src/main.mjs'), skeleton);
    await writeFile(path.join(source, 'package.json'), '{"name":"fixture","type":"module"}');
    const cli = path.join(root, 'codex-fixture.mjs');
    await writeFile(cli, `import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (!prompt.includes('answer must return 42')) throw new Error('lost public requirement');
if (existsSync('history-view/source/Legacy.java')) {
  if (!readFileSync('history-view/source/Legacy.java', 'utf8').includes('return 42')) throw new Error('history source was not staged');
  if (!readFileSync('history-view/manifest.json', 'utf8').includes('legacy-module')) throw new Error('history manifest was not staged');
}
if (existsSync('history-view/source/Legacy.java') && !prompt.includes('one coding session') &&
    !existsSync('CODEX_IMPLEMENTATION_PLAN.md') && !existsSync('CODEX_IMPLEMENTATION_PLAN.json')) {
  writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'Implement answer from Legacy.java.');
  process.exit(0);
}
writeFileSync('target/src/main.mjs', 'export function answer() { return 42; }\\n');
if (prompt.includes('one coding session')) {
  writeFileSync('target/src/extra.mjs', 'export const integrated = true;\\n');
  mkdirSync('.agent-tmp/integration-checks', { recursive: true });
  writeFileSync('.agent-tmp/integration-checks/execution.log', 'fixture check executed');
}
writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'Implementation finished.');
`);
    const command = { executable: process.execPath, args: ['--check', 'src/main.mjs'] };
    // VS Code's globalStorage URI uses a lowercase drive; async realpath used
    // by the history producer returns an uppercase drive on Windows.
    const storage = path.join(root, 'storage');
    const files = new ProjectPipelineFiles(process.platform === 'win32' ? storage.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : storage);
    const candidate: SearchCandidate = { id: 'reference', kind: 'module', repository: 'History', language: 'Java', path: 'Legacy.java',
      preview: 'int answer() { return 42; }', dependencies: [], title: 'Legacy', license: 'MIT', signature: 'answer()', summary: 'Legacy answer',
      compatibility: [], risks: [], score: { overall: 1, semantic: 1, symbol: 1, contract: 1 }, sourceModule: {
        repositoryId: 'history', analysisRevision: 'r1', projectId: 'legacy', projectPath: '', moduleId: 'legacy-module', name: 'Legacy',
        sourceFiles: ['Legacy.java'], coreApis: ['answer()'] } };
    const unit: ProjectPipelineModule = { id: 'answer', name: 'Answer', dependsOn: [], status: 'pending', candidates: [],
      target: { id: 'answer', name: 'Answer', kind: 'module', language: 'TypeScript', path: 'src/main.mjs', signature: 'answer()',
        module: { sourceFiles: ['src/main.mjs'], coreApis: ['answer'], dependsOn: [] } } };
    backend = new packaged.ProjectPipelineBackend({ codeIntelligence: { searchHistoricalImplementations: async () => [], createHistoryModulesView: async input => {
      const runId = randomUUID(), history = path.join(await realpath(input.workspaceRoot!), '.forexpore', 'history-views', runId);
      await mkdir(path.join(history, 'source'), { recursive: true });
      const content = 'class Legacy { int answer() { return 42; } }';
      const sha256 = createHash('sha256').update(content).digest('hex');
      const manifestHash = createHash('sha256').update(JSON.stringify([['Legacy.java', sha256]])).digest('hex');
      const identity = { repositoryId: 'history', analysisRevision: 'r1', projectId: 'legacy', moduleId: 'legacy-module', runId };
      await writeFile(path.join(history, 'source', 'Legacy.java'), content);
      await writeFile(path.join(history, 'manifest.json'), JSON.stringify({ ...identity, files: [{ path: 'Legacy.java', sha256 }] }));
      return { ...identity, root: history, files: ['Legacy.java'], manifestHash };
    } },
      endpoint: () => 'http://localhost:8788', ensureStarted: async () => {}, model: async () => ({ apiKey: 'fixture', model: 'fixture', apiBase: 'https://example.test/v1' }),
      compileCommand: () => command, protectedFiles: () => [], codexCommand: cli, codexHome: root,
    }, { runtime: options => new packaged.CodexWorkspaceTranslationRuntime(options), plan: async () => ({ protocol: emptyGlobalProtocol() }),
      // Only model judgments are deterministic; process, staging, compilation and delivery are real.
      verify: async input => {
        expect(await readFile(path.join(input.root, 'src/main.mjs'), 'utf8')).toContain('return 42');
        return { disposition: 'verified', mode: 'requirement', attempts: [] };
      } });
    let pipeline!: ProjectPipeline;
    pipeline = new ProjectPipeline({ proactiveIntegration: true,
      prepare: async (_input, signal) => ({ projectName: 'Fixture', analysisRevision: 'r1', analysisHash: 'hash', modules: [unit], ...await files.snapshot(source, pipeline.current!.id, signal) }),
      initialize: (run, signal, log) => backend!.prepare(run, signal, log), search: (module, input, signal) => {
        if (withHistory) { module.selectedCandidateIds = [candidate.id]; return Promise.resolve([candidate]); }
        return backend!.search(module, input, signal);
      },
      generate: (module, run, hooks) => backend!.generate(module, run, hooks), finish: () => backend!.close(),
      validate: async (run, signal) => {
        await files.assertWriteScope(run); const compilation = await packaged.compileWorkspace(run.outputRoot!, command, signal);
        const sourceHash = await files.sourceHash(run);
        const modules = (await backend!.verifyFinal(run, sourceHash, signal, () => {})).map(module => ({ id: module.id, verification: module.moduleVerification! }));
        return { compilation, sourceHash, coverage: null, protectedFilesUnchanged: true, modules };
      },
      sourceHash: run => files.sourceHash(run), publish: (run, signal) => files.publish(run, signal), save: run => files.save(run), changed: () => {},
    });
    pipeline.start({ repositoryId: 'target', projectId: 'fixture', requirement: 'answer must return 42', topK: 4 });
    await pipeline.idle(); const result = pipeline.current!;
    expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.modules.map(module => module.translation?.agent?.kind)).toEqual(['codex', 'codex']);
    if (withHistory) {
      expect(result.modules[0]?.translation?.agent?.stages?.map(stage => stage.stage)).toEqual(['analyzer', 'translator']);
      expect(result.modules[0]?.translation?.agent?.historyView?.files).toBe(1);
    }
    expect(await readFile(path.join(result.outputRoot!, 'src/extra.mjs'), 'utf8')).toContain('integrated');
    expect(await readFile(path.join(source, 'src/main.mjs'), 'utf8')).toBe(skeleton);
    expect(await readFile(path.join(files.directory(result.id), 'acceptance-report.md'), 'utf8')).toContain('fixture check executed');
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
