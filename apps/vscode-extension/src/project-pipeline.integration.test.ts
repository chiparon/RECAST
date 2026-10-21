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
it.skipIf(process.platform !== 'win32')('accepts VS Code lowercase drive paths without widening the managed output boundary', () => {
  const files = new ProjectPipelineFiles('C:\\Storage');
  const id = '11111111-2222-3333-4444-555555555555';
  const expected = path.join(files.directory(id), 'project');
  expect(files.output({ id, outputRoot: expected.toLowerCase() } as ProjectPipelineRun)).toBe(expected);
  expect(() => files.output({ id, outputRoot: path.join(files.directory(id), 'other') } as ProjectPipelineRun)).toThrow('受管副本');
});
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

it('restores a restarted run as interrupted with recovery instructions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-project-recovery-')); roots.push(root);
  const files = new ProjectPipelineFiles(root);
  const run = { id: '11111111-2222-3333-4444-555555555555', status: 'running', modules: [], events: [] } as unknown as ProjectPipelineRun;
  Object.assign(run, { requirement: 'spec', projectId: 'project', });
  await files.save(run);
  const restored = await files.read(run.id); expect(restored.status).toBe('interrupted');
  expect(() => files.directory('../outside')).toThrow('无效');
});

it('recreates the runner from disk, retries only the failed module, and runs real final tests before committing the same output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-project-resume-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'first.mjs'), 'export const first = 0;');
  await writeFile(path.join(source, 'second.mjs'), 'export const second = 0;');
  await writeFile(path.join(source, 'acceptance.mjs'), 'import assert from "node:assert/strict"; import {first} from "./first.mjs"; import {second} from "./second.mjs"; assert.equal(first + second, 42); console.log("resumed behavior verified");');
  const files = new ProjectPipelineFiles(path.join(root, 'storage'));
  let prepares = 0, validations = 0;
  const generated: string[] = [];
  const units: ProjectPipelineModule[] = ['first', 'second'].map(id => ({ id, name: id, status: 'pending', dependsOn: id === 'second' ? ['first'] : [], candidates: [],
    target: { id, name: id, kind: 'module', path: `${id}.mjs`, language: 'TypeScript', signature: '', module: { sourceFiles: [`${id}.mjs`], coreApis: [id], dependsOn: [] } } }));
  const create = (fail: boolean) => {
    let pipeline!: ProjectPipeline;
    pipeline = new ProjectPipeline({
      prepare: async (_input, signal) => { prepares++; return { projectName: 'Resume', analysisRevision: 'r1', analysisHash: 'h1', modules: structuredClone(units), ...await files.snapshot(source, pipeline.current!.id, signal) }; },
      restore: async run => { await files.assertResumable(run); }, checkpoint: run => files.checkpoint(run), search: async () => [],
      generate: async (module, run, hooks) => {
        generated.push(module.id); module.authorizedFiles = module.target.module!.sourceFiles; await hooks.onCheckpoint?.();
        const file = `${module.id}.mjs`, before = await readFile(path.join(run.outputRoot!, file), 'utf8');
        const failed = fail && module.id === 'second', after = `export const ${module.id} = ${module.id === 'first' ? 40 : failed ? 1 : 2};`;
        await writeFile(path.join(run.outputRoot!, file), after);
        return { id: `translation-${generated.length}`, request: { spec: run.requirement, context: [], sourceLanguage: 'TypeScript', targetLanguage: 'TypeScript', workspaceFiles: [file], writeFiles: [file] },
          workspaceRoot: run.outputRoot!, status: failed ? 'failed' : 'completed', error: failed ? 'temporary model outage' : undefined, createdAt: '', updatedAt: '', modelTurns: 1,
          acceptance: 'compilation-only', completedSteps: [], compilations: [], changes: [{ path: file, before, after, applied: true }] };
      },
      validate: async (run, signal) => {
        validations++; const check = await compileWorkspace(run.outputRoot!, { executable: process.execPath, args: ['acceptance.mjs'] }, signal);
        return { compilation: check, verification: check, protectedFilesUnchanged: true, coverage: null, sourceHash: await files.sourceHash(run) };
      },
      sourceHash: run => files.sourceHash(run), publish: (run, signal) => files.publish(run, signal), save: run => files.save(run), changed: () => {},
    }); return pipeline;
  };
  const first = create(true); first.start({ repositoryId: 'repo', projectId: 'project', requirement: 'The two exports sum to 42.', topK: 4 }); await first.idle();
  const persisted = await files.read(first.current!.id);
  expect(persisted.status).toBe('failed'); expect(persisted.checkpoint?.sourceHash).toBe(await files.sourceHash(persisted));
  const resumed = create(false); resumed.resume(persisted, 'second'); await resumed.idle();
  expect(resumed.current).toMatchObject({ id: persisted.id, outputRoot: persisted.outputRoot, status: 'completed', acceptance: 'behavior-verified', resumeCount: 1 });
  expect(prepares).toBe(1); expect(validations).toBe(1); expect(generated).toEqual(['first', 'second', 'second']);
  expect(resumed.current!.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(await readFile(path.join(source, 'first.mjs'), 'utf8')).toBe('export const first = 0;');
  expect((await files.read(persisted.id)).validation?.verification?.output).toContain('resumed behavior verified');
  await writeFile(path.join(persisted.outputRoot!, 'second.mjs'), 'export const second = 999;');
  await expect(files.assertResumable({ ...resumed.current!, status: 'failed' })).rejects.toThrow('未记录的修改');
}, 20_000);

it('allows crash-time writes only inside the persisted in-flight module scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-project-crash-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'first.mjs'), 'export const first = 40;'); await writeFile(path.join(source, 'second.mjs'), 'export const second = 0;');
  const files = new ProjectPipelineFiles(path.join(root, 'storage'));
  const run = { id: '11111111-2222-3333-4444-555555555555', repositoryId: 'repo', projectId: 'project', analysisRevision: 'r1', requirement: 'sum to 42', projectName: 'Crash',
    status: 'running', stage: 'generating', currentModuleId: 'second', createdAt: '', updatedAt: '', events: [], acceptance: 'unverified', reportAvailable: false,
    modules: ['first', 'second'].map(id => ({ id, name: id, status: id === 'first' ? 'completed' : 'running', dependsOn: [], candidates: [], authorizedFiles: [`${id}.mjs`],
      target: { id, name: id, kind: 'module', path: `${id}.mjs`, language: 'TypeScript', signature: '', module: { sourceFiles: [`${id}.mjs`], coreApis: [], dependsOn: [] } } })),
    ...await files.snapshot(source, '11111111-2222-3333-4444-555555555555', new AbortController().signal),
  } as ProjectPipelineRun;
  run.checkpoint = await files.checkpoint(run); await files.save(run);
  await writeFile(path.join(run.outputRoot!, 'second.mjs'), 'export const second = 1;');
  const interrupted = await files.read(run.id); expect(interrupted.status).toBe('interrupted');
  await expect(files.assertResumable(interrupted)).resolves.toBeUndefined();
  // A temporary service/credential error on the first resume cannot revoke the
  // original in-flight authorization and make the next retry unrecoverable.
  await expect(files.assertResumable({ ...interrupted, status: 'failed' })).resolves.toBeUndefined();
  await writeFile(path.join(run.outputRoot!, 'first.mjs'), 'export const first = 999;');
  await expect(files.assertResumable(interrupted)).rejects.toThrow('first.mjs');
}, 20_000);

it('recovers a bounded Integration source added before its progress notification while refusing new configuration files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-integration-crash-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source); await mkdir(path.join(source, 'src')); await writeFile(path.join(source, 'src/main.mjs'), 'export const value = 42;');
  const files = new ProjectPipelineFiles(path.join(root, 'storage'));
  const run = { id: '11111111-2222-3333-4444-555555555555', status: 'running', stage: 'generating', currentModuleId: 'pipeline-integration', requirement: 'spec', projectId: 'project', events: [],
    modules: [{ id: 'pipeline-integration', name: 'Integration', status: 'running', taskKind: 'project-integration', candidates: [], dependsOn: [], authorizedFiles: ['src/main.mjs'],
      target: { module: { sourceFiles: ['src/main.mjs'] } } }],
    ...await files.snapshot(source, '11111111-2222-3333-4444-555555555555', new AbortController().signal),
  } as unknown as ProjectPipelineRun;
  run.checkpoint = await files.checkpoint(run); await files.save(run);
  await writeFile(path.join(run.outputRoot!, 'src/added.mjs'), 'export const added = 42;');
  const interrupted = await files.read(run.id); await files.assertResumable(interrupted);
  expect(interrupted.modules[0]!.changedFiles).toContain('src/added.mjs');
  expect(interrupted.modules[0]!.authorizedFiles).toContain('src/added.mjs');
  await writeFile(path.join(run.outputRoot!, 'package.json'), '{}');
  await expect(files.assertResumable(interrupted)).rejects.toThrow('package.json');
}, 20_000);
