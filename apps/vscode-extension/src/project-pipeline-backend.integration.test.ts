// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyGlobalProtocol } from '@forexplore/contracts';
import { ProjectPipeline } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import type { CodexRuntime, ProjectPipelineBackend as Backend } from './project-pipeline-backend';
import type { ProjectPipelineModule } from './project-pipeline-types';

it('packages the adapter and runs real Codex staging, compiler, proactive Integration and isolated Git delivery with a deterministic CLI', async () => {
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
    await writeFile(cli, `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (!prompt.includes('answer must return 42')) throw new Error('lost public requirement');
writeFileSync('target/src/main.mjs', 'export function answer() { return 42; }\\n');
if (prompt.includes('one coding session')) {
  writeFileSync('target/src/extra.mjs', 'export const integrated = true;\\n');
  mkdirSync('.agent-tmp/integration-checks', { recursive: true });
  writeFileSync('.agent-tmp/integration-checks/execution.log', 'fixture check executed');
}
writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'Implementation finished.');
`);
    const command = { executable: process.execPath, args: ['--check', 'src/main.mjs'] };
    const files = new ProjectPipelineFiles(path.join(root, 'storage'));
    const unit: ProjectPipelineModule = { id: 'answer', name: 'Answer', dependsOn: [], status: 'pending', candidates: [],
      target: { id: 'answer', name: 'Answer', kind: 'module', language: 'TypeScript', path: 'src/main.mjs', signature: 'answer()',
        module: { sourceFiles: ['src/main.mjs'], coreApis: ['answer'], dependsOn: [] } } };
    backend = new packaged.ProjectPipelineBackend({ codeIntelligence: { searchHistoricalImplementations: async () => [], createHistoryModulesView: async () => { throw new Error('no history'); } },
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
      initialize: (run, signal, log) => backend!.prepare(run, signal, log), search: (module, input, signal) => backend!.search(module, input, signal),
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
    expect(await readFile(path.join(result.outputRoot!, 'src/extra.mjs'), 'utf8')).toContain('integrated');
    expect(await readFile(path.join(source, 'src/main.mjs'), 'utf8')).toBe(skeleton);
    expect(await readFile(path.join(files.directory(result.id), 'acceptance-report.md'), 'utf8')).toContain('fixture check executed');
  } finally { await backend?.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
