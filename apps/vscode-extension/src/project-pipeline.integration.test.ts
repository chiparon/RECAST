// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceTranslationRuntime } from '@forexplore/adaptation-service/workspace-translation-runtime';
import { compileWorkspace } from '@forexplore/adaptation-service/workspace-compiler';
import type { WorkspaceTranslationModelClient } from '@forexplore/adaptation-service/module-patch-preparer';
import { ProjectPipeline } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import type { ProjectPipelineModule, ProjectPipelineRun } from './project-pipeline-types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
it('runs real file generation, compiler, immutable tests, report persistence and an atomic isolated Git commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-project-e2e-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  const original = 'export const answer = () => 0;\n', implemented = 'export const answer = () => 42;\n';
  await writeFile(path.join(source, 'target.mjs'), original);
  const test = 'import assert from "node:assert/strict"; import { answer } from "./target.mjs"; assert.equal(answer(), 42); console.log("one acceptance test passed");';
  await writeFile(path.join(source, 'acceptance.mjs'), test);
  const files = new ProjectPipelineFiles(path.join(root, 'storage'));
  const unit: ProjectPipelineModule = { id: 'answer', name: 'Answer', status: 'pending', dependsOn: [], candidates: [], target: { id: 'answer', name: 'Answer', kind: 'module', path: 'target.mjs', language: 'TypeScript', signature: '', module: { sourceFiles: ['target.mjs'], coreApis: ['answer'], dependsOn: [] } } };
  const command = { executable: process.execPath, args: ['--check', 'target.mjs'] };
  let pipeline!: ProjectPipeline;
  pipeline = new ProjectPipeline({
    prepare: async (_input, signal) => ({ projectName: 'Fixture', analysisRevision: 'revision', analysisHash: 'hash', modules: [unit], ...await files.snapshot(source, pipeline.current!.id, signal) }),
    search: async () => [],
    generate: async (_module, run, hooks) => {
      const plan = { summary: 'Implement answer', mappings: [{ source: 'answer', targetPath: 'target.mjs', targetSymbol: 'answer' }], dependencies: [], steps: [{ id: 'implement', description: 'Return required value', files: ['target.mjs'], dependsOn: [] }] };
      const calls: Array<[string, unknown]> = [['submit_plan', plan], ['read_file', { path: 'target.mjs' }], ['write_file', { path: 'target.mjs', expectedHash: hash(original), content: implemented }], ['complete_step', { stepId: 'implement' }], ['compile', {}], ['finish', {}]];
      let step = 0;
      const client: WorkspaceTranslationModelClient = { complete: async () => { const [name, args] = calls[step++]!; return { content: '', toolCalls: [{ id: `turn-${step}`, name, arguments: JSON.stringify(args) }] }; } };
      const runtime = new WorkspaceTranslationRuntime({ workspaceRoot: files.output(run), compileCommand: command, client });
      try {
        const start = runtime.start({ spec: run.requirement, sourceLanguage: 'Java', targetLanguage: 'TypeScript', context: [{ id: 'spec', kind: 'summary', content: run.requirement }], workspaceFiles: ['target.mjs'], writeFiles: ['target.mjs'] });
        for (let iteration = 0; iteration < 500; iteration++) {
          const result = runtime.get(start.id);
          if (['completed', 'failed', 'cancelled'].includes(result.status)) return result;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Generation did not finish');
      } finally { await runtime.shutdown(); }
    },
    validate: async (run, signal) => {
      await files.assertWriteScope(run);
      const compilation = await compileWorkspace(files.output(run), command, signal);
      const verification = await compileWorkspace(files.output(run), { executable: process.execPath, args: ['acceptance.mjs'] }, signal);
      return { compilation, verification, protectedFilesUnchanged: await readFile(path.join(files.output(run), 'acceptance.mjs'), 'utf8') === test, sourceHash: await files.sourceHash(run), coverage: null };
    },
    sourceHash: run => files.sourceHash(run), publish: (run, signal) => files.publish(run, signal), save: run => files.save(run), changed: () => {},
  });
  pipeline.start({ repositoryId: 'fixture-repo', projectId: 'fixture-project', topK: 4, requirement: 'answer must return 42' });
  await pipeline.idle(); const completed = pipeline.current!;
  expect(completed).toMatchObject({ status: 'completed', acceptance: 'behavior-verified', reportAvailable: true });
  expect(completed.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(await readFile(path.join(source, 'target.mjs'), 'utf8')).toBe(original);
  expect(await readFile(path.join(completed.outputRoot!, 'target.mjs'), 'utf8')).toBe(implemented);
  expect((await files.read(completed.id)).validation?.verification?.output).toContain('one acceptance test passed');
  expect(await readFile(path.join(files.directory(completed.id), 'acceptance-report.md'), 'utf8')).toContain(completed.commit!);
  expect(await files.sourceHash(completed)).toBe(completed.validation?.sourceHash);
  await writeFile(path.join(completed.outputRoot!, 'acceptance.mjs'), 'weakened');
  await expect(files.assertWriteScope(completed)).rejects.toThrow('超出已批准');
}, 20_000);

it('restores a restarted run as interrupted and invalidates all outstanding approval tokens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-project-recovery-')); roots.push(root);
  const files = new ProjectPipelineFiles(root);
  const run = { id: '11111111-2222-3333-4444-555555555555', status: 'running', modules: [], events: [] } as unknown as ProjectPipelineRun;
  Object.assign(run, { requirement: 'spec', projectId: 'project', });
  await files.save(run);
  const restored = await files.read(run.id); expect(restored.status).toBe('interrupted');
  expect(() => files.directory('../outside')).toThrow('无效');
});
