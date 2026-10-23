// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { compileWorkspace } from '@forexplore/adaptation-service/workspace-compiler';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { retainedTestDirectory, RETAINED_TEST_README, RETAINED_TEST_RUNNER } from '../../../services/translation-verifier/src/host/test-artifacts';
import type { RetainedTestSuite } from '../../../services/translation-verifier/src/types';
import { ProjectPipeline } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import type { ProjectPipelineModule } from './project-pipeline-types';

const exec = promisify(execFile);
it.each([42, 7])('delivers code and runnable tests in one commit; retained-test failures block delivery and allow module retry (value=%s)', async initial => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-delivery-'));
  try {
    const original = path.join(root, 'original'); await mkdir(original);
    await writeFile(path.join(original, 'answer.mjs'), 'export const answer=()=>0;');
    const files = new ProjectPipelineFiles(path.join(root, 'storage'));
    const module: ProjectPipelineModule = { id: 'answer', name: 'Answer', status: 'pending', candidates: [], dependsOn: [], target: { id: 'answer', kind: 'module', name: 'Answer', language: 'TypeScript', path: 'answer.mjs', signature: 'answer()', module: { sourceFiles: ['answer.mjs'], coreApis: ['answer()'], dependsOn: [] } } };
    let pipeline!: ProjectPipeline, value = initial;
    pipeline = new ProjectPipeline({
      prepare: async (_input, signal) => ({ projectName: 'Fixture', analysisRevision: 'r1', analysisHash: 'fixture-hash', modules: [module], ...await files.snapshot(original, pipeline.current!.id, signal) }),
      restore: async run => files.assertResumable(run), checkpoint: run => files.checkpoint(run), search: async () => [],
      generate: async (module, run, hooks) => {
        const root = files.output(run), directory = retainedTestDirectory(module.id), testPath = `${directory}/tests/answer.test.cjs`;
        const test = "const assert=require('node:assert/strict'); import('../../../answer.mjs').then(({answer})=>assert.equal(answer(),42));";
        const runner = "require('./tests/answer.test.cjs');";
        await writeFile(path.join(root, 'answer.mjs'), `export const answer=()=>${value};`);
        await mkdir(path.join(root, directory, 'tests'), { recursive: true });
        await writeFile(path.join(root, testPath), test); await writeFile(path.join(root, directory, 'run.cjs'), runner);
        const suite: RetainedTestSuite = { schemaVersion: 1, id: module.id, directory, framework: 'vitest', testRoots: [`${directory}/tests`], testPaths: [testPath],
          files: [{ path: testPath, sha256: createHash('sha256').update(test).digest('hex') }, { path: `${directory}/run.cjs`, sha256: createHash('sha256').update(runner).digest('hex') }], status: 'passed', command: `node ${directory}/run.cjs` };
        await writeFile(path.join(root, directory, 'manifest.json'), JSON.stringify(suite));
        await writeFile(path.join(root, '.recast-tests/run.cjs'), RETAINED_TEST_RUNNER); await writeFile(path.join(root, '.recast-tests/README.md'), RETAINED_TEST_README);
        module.retainedTests = suite;
        const compilation = await compileWorkspace(root, { executable: process.execPath, args: ['--check', 'answer.mjs'] }, hooks.signal);
        return { id: 'generated', status: 'completed', workspaceRoot: root, createdAt: '', updatedAt: '', request: { spec: run.requirement, sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript', context: [], workspaceFiles: ['answer.mjs'], writeFiles: ['answer.mjs'] },
          changes: [{ path: 'answer.mjs', before: '', after: '', applied: true }], completedSteps: [], compilations: [compilation], modelTurns: 1, acceptance: 'compilation-only' } as WorkspaceTranslationRun;
      },
      validate: async (run, signal) => {
        await files.assertWriteScope(run); const before = await files.sourceHash(run);
        const compilation = await compileWorkspace(run.outputRoot!, { executable: process.execPath, args: ['--check', 'answer.mjs'] }, signal);
        const retainedTests = await compileWorkspace(run.outputRoot!, { executable: process.execPath, args: ['.recast-tests/run.cjs'] }, signal);
        expect(await files.sourceHash(run)).toBe(before);
        return { compilation, retainedTests, retainedTestFailures: retainedTests.success ? [] : ['answer'], protectedFilesUnchanged: true, sourceHash: before, coverage: null };
      },
      sourceHash: run => files.sourceHash(run), publish: (run, signal) => files.publish(run, signal), save: run => files.save(run), changed: () => {},
    });
    pipeline.start({ repositoryId: 'fixture', projectId: 'fixture', requirement: 'answer returns 42', topK: 4 }); await pipeline.idle();
    if (initial !== 42) {
      const failed = pipeline.current!; expect(failed.status).toBe('failed'); expect(failed.commit).toBeUndefined();
      expect(failed.error).toContain('生成测试未通过'); expect(failed.modules[0]?.retainedTests?.testPaths.length).toBe(1);
      value = 42; pipeline.resume(failed, 'answer'); await pipeline.idle();
    }
    const result = pipeline.current!; expect(result.error).toBeUndefined(); expect(result.status).toBe('completed');
    const tracked = (await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: result.outputRoot, windowsHide: true })).stdout;
    expect(tracked).toContain('answer.mjs'); expect(tracked).toContain('/tests/answer.test.cjs'); expect(tracked).toContain('.recast-tests/run.cjs');
    const before = await files.productionHash(result), testPath = result.modules[0]!.retainedTests!.testPaths[0]!;
    await writeFile(path.join(result.outputRoot!, testPath), 'weakened');
    await expect(files.assertWriteScope(result)).rejects.toThrow('changed');
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(original, 'answer.mjs'), 'utf8')).toBe('export const answer=()=>0;');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
