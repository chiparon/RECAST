// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { compileWorkspace } from '@forexplore/adaptation-service/workspace-compiler';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { retainedTestDirectory, RETAINED_TEST_README, RETAINED_TEST_RUNNER } from '@forexplore/translation-verifier-service/test-artifacts';
import type { RetainedTestSuite } from '@forexplore/translation-verifier-service/types';
import { ProjectPipeline, type ProjectPipelinePorts } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import type { ProjectPipelineModule, ProjectPipelineRun } from './project-pipeline-types';
import { LegacyProjectPipeline } from './test/fixtures/project-pipeline-legacy';

type Pipeline = Pick<ProjectPipeline, 'start' | 'resume' | 'cancel' | 'idle' | 'flush' | 'current'>;
type Constructor = new (ports: ProjectPipelinePorts) => Pipeline;
type Failure = 'failed' | 'cancelled' | 'interrupted' | 'integration-failed';
const exec = promisify(execFile), roots: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function retainSuite(root: string, id: string): Promise<RetainedTestSuite> {
  const directory = retainedTestDirectory(id), testPath = `${directory}/tests/${id}.test.cjs`;
  const expected = id === 'first' ? 40 : 2;
  const test = `const assert=require('node:assert/strict'); import('../../../${id}.mjs').then(mod=>assert.equal(mod.${id},${expected}));`;
  const runner = `require('./tests/${id}.test.cjs');`;
  await mkdir(path.join(root, directory, 'tests'), { recursive: true });
  await writeFile(path.join(root, testPath), test); await writeFile(path.join(root, directory, 'run.cjs'), runner);
  const suite: RetainedTestSuite = { schemaVersion: 1, id, directory, framework: 'vitest', testRoots: [`${directory}/tests`], testPaths: [testPath],
    files: [{ path: testPath, sha256: hash(test) }, { path: `${directory}/run.cjs`, sha256: hash(runner) }], status: 'unverified', command: `node ${directory}/run.cjs` };
  await writeFile(path.join(root, directory, 'manifest.json'), JSON.stringify(suite));
  await writeFile(path.join(root, '.recast-tests/run.cjs'), RETAINED_TEST_RUNNER); await writeFile(path.join(root, '.recast-tests/README.md'), RETAINED_TEST_README);
  return suite;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'lg-compat-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'first.mjs'), 'export const first = 0;');
  await writeFile(path.join(source, 'second.mjs'), 'export const second = 0;');
  const fixedTest = 'import assert from "node:assert/strict"; import {first} from "./first.mjs"; import {second} from "./second.mjs"; assert.equal(first + second,42); console.log("cross-version acceptance passed");';
  await writeFile(path.join(source, 'acceptance.mjs'), fixedTest);
  const storage = path.join(root, 'storage'), generated: string[] = [];
  let prepares = 0, validations = 0, crashCheckpoint: ProjectPipelineRun | undefined;
  const create = (Class: Constructor, failure?: Failure) => {
    // Each process incarnation constructs fresh persistence and execution objects.
    const files = new ProjectPipelineFiles(storage);
    let pipeline!: Pipeline;
    const modules: ProjectPipelineModule[] = ['first', 'second'].map(id => ({ id, name: id, status: 'pending', candidates: [], dependsOn: id === 'second' ? ['first'] : [],
      target: { id, name: id, kind: 'module', path: `${id}.mjs`, language: 'TypeScript', signature: '', module: { sourceFiles: [`${id}.mjs`], coreApis: [id], dependsOn: [] } } }));
    pipeline = new Class({
      proactiveIntegration: failure === 'integration-failed' || !failure,
      prepare: async (_input, signal) => {
        prepares++;
        return { projectName: 'Compatibility', analysisRevision: 'r1', analysisHash: 'h1', modules,
          ...await files.snapshot(source, pipeline.current!.id, signal) };
      },
      restore: run => files.assertResumable(run), checkpoint: run => files.checkpoint(run), search: async () => [],
      generate: async (item, run, hooks) => {
        generated.push(item.id);
        const file = item.taskKind ? 'second.mjs' : `${item.id}.mjs`;
        item.authorizedFiles = [...item.target.module!.sourceFiles]; await hooks.onCheckpoint?.();
        const shouldFail = failure === 'integration-failed' ? Boolean(item.taskKind) : Boolean(failure && item.id === 'second');
        if (shouldFail && failure === 'interrupted') crashCheckpoint = pipeline.current;
        const before = await readFile(path.join(run.outputRoot!, file), 'utf8');
        const value = file === 'first.mjs' ? 40 : shouldFail ? 1 : 2;
        const after = `export const ${file.split('.')[0]} = ${value};`;
        await writeFile(path.join(run.outputRoot!, file), after);
        if (!item.taskKind) item.retainedTests = await retainSuite(run.outputRoot!, item.id);
        // Cancel after applied production/test writes but before the completion callback.
        if (shouldFail && (failure === 'cancelled' || failure === 'interrupted')) pipeline.cancel(run.id);
        return { id: `translation-${generated.length}`, workspaceRoot: run.outputRoot!, status: shouldFail ? 'failed' : 'completed',
          error: shouldFail ? 'temporary transport failure' : undefined, createdAt: '', updatedAt: '', completedSteps: [], compilations: [], modelTurns: 1,
          acceptance: 'compilation-only', request: { spec: run.requirement, context: [], sourceLanguage: 'TypeScript', targetLanguage: 'TypeScript', workspaceFiles: [file], writeFiles: [file] },
          changes: [{ path: file, before, after, applied: true }] } as WorkspaceTranslationRun;
      },
      validate: async (run, signal) => {
        validations++; await files.assertWriteScope(run);
        const compilation = await compileWorkspace(run.outputRoot!, { executable: process.execPath, args: ['--check', 'second.mjs'] }, signal);
        const verification = await compileWorkspace(run.outputRoot!, { executable: process.execPath, args: ['acceptance.mjs'] }, signal);
        const retainedTests = await compileWorkspace(run.outputRoot!, { executable: process.execPath, args: ['.recast-tests/run.cjs'] }, signal);
        return { compilation, verification, retainedTests, retainedTestFailures: retainedTests.success ? [] : ['second'],
          protectedFilesUnchanged: await readFile(path.join(run.outputRoot!, 'acceptance.mjs'), 'utf8') === fixedTest,
          sourceHash: await files.sourceHash(run), coverage: null };
      },
      sourceHash: run => files.sourceHash(run), publish: (run, signal) => files.publish(run, signal), save: run => files.save(run), changed: () => {},
    });
    return { pipeline, files };
  };
  return { source, generated, create, counts: () => ({ prepares, validations }), crash: () => crashCheckpoint };
}

const directions = [
  ['old to LangGraph', LegacyProjectPipeline, ProjectPipeline],
  ['LangGraph to old', ProjectPipeline, LegacyProjectPipeline],
] as const;

for (const [direction, First, Next] of directions) {
  it.each(['failed', 'cancelled', 'interrupted', 'integration-failed'] as const)(`${direction}: restores %s from real disk with partial code, retained tests and Git delivery`, async failure => {
    const fixture = await setup(), first = fixture.create(First, failure);
    first.pipeline.start({ repositoryId: 'repo', projectId: 'project', requirement: 'The two exports sum to 42.', topK: 4 }); await first.pipeline.idle();
    const id = first.pipeline.current!.id, output = first.pipeline.current!.outputRoot!;
    expect(await readFile(path.join(output, 'second.mjs'), 'utf8')).toBe('export const second = 1;');
    expect(first.pipeline.current!.commit).toBeUndefined();
    if (failure === 'interrupted') {
      // Restore the genuine pre-write running record to model a crash before final cleanup saved it.
      // The applied bytes and suite delivery stay on disk and must pass the original scope rules.
      expect(fixture.crash()?.checkpoint?.activeModuleId).toBe('second');
      await first.files.save(fixture.crash()!);
    }
    const next = fixture.create(Next), stored = await next.files.read(id);
    expect(stored.status).toBe(failure === 'integration-failed' ? 'failed' : failure);
    const suitesBefore = await next.files.testSuites(stored);
    expect(suitesBefore.map(suite => suite.id)).toEqual(['first', 'second']);
    if (failure === 'interrupted') expect(stored.checkpoint!.sourceHash).not.toBe(await next.files.sourceHash(stored));
    await next.files.assertResumable(stored);
    next.pipeline.resume(stored, failure === 'integration-failed' ? undefined : 'second'); await next.pipeline.idle();
    const completed = next.pipeline.current!;
    expect(completed.error).toBeUndefined();
    expect(completed).toMatchObject({ id, outputRoot: output, status: 'completed', acceptance: 'behavior-verified', resumeCount: 1, reportAvailable: true });
    expect(completed.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(fixture.counts()).toEqual({ prepares: 1, validations: 1 });
    expect(fixture.generated).toEqual(failure === 'integration-failed'
      ? ['first', 'second', 'pipeline-integration', 'pipeline-integration']
      : ['first', 'second', 'second', 'pipeline-integration']);
    expect(completed.modules.find(item => item.id === 'second')!.retainedTests?.testPaths).toEqual(suitesBefore[1]!.testPaths);
    expect(await next.files.sourceHash(completed)).toBe(completed.validation!.sourceHash);
    expect((await next.files.read(id)).validation?.verification?.output).toContain('cross-version acceptance passed');
    expect(await readFile(path.join(next.files.directory(id), 'acceptance-report.md'), 'utf8')).toContain(completed.commit!);
    const tracked = (await exec('git', ['-C', output, 'ls-tree', '-r', '--name-only', 'HEAD'], { windowsHide: true })).stdout;
    expect(tracked).toContain('.recast-tests/run.cjs');
    for (const suite of suitesBefore) expect(tracked).toContain(suite.testPaths[0]);
    const replay = await compileWorkspace(output, { executable: process.execPath, args: ['.recast-tests/run.cjs'] }, new AbortController().signal);
    expect(replay.success).toBe(true);
    expect(await readFile(path.join(fixture.source, 'second.mjs'), 'utf8')).toBe('export const second = 0;');
  }, 30_000);
}
