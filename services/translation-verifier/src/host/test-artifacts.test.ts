import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createAgentHost } from './runtime.js';
import { createWriteTargetTestTool } from './tools/write-target-test.js';
import { createTestArtifactRecorder } from './test-artifact-recorder.js';
import { copyRetainedTestSuite, readRetainedTestSuite, recoverRetainedTestDelivery, retainedTestDirectory } from './test-artifacts.js';
import type { ToolRuntimeContext, ToolState } from './tools/common.js';

const roots: string[] = [], exec = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary(inRepository = false) {
  const root = await mkdtemp(join(inRepository ? process.cwd() : tmpdir(), '.recast-retention-')); roots.push(root); return root;
}
async function fixture() {
  const root = await temporary(true), source = join(root, 'source'), output = join(root, 'output');
  await mkdir(source); await mkdir(output);
  const directory = retainedTestDirectory('prices'), testRoot = `${directory}/tests`, testPath = `${testRoot}/price.test.mjs`;
  await mkdir(join(source, testRoot), { recursive: true });
  await writeFile(join(source, 'price.mjs'), 'export const price = value => value * 2;\n');
  await writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: '*' } }));
  await writeFile(join(source, testPath), `import { expect, test } from 'vitest'; import { price } from '../../../price.mjs'; test('doubles a price',()=>expect(price(3)).toBe(6));\n`);
  const runtime: ToolRuntimeContext = { sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript', sourceProjectPath: source, targetProjectPath: source,
    sourcePath: 'price.mjs', targetPath: 'price.mjs', targetFunction: { path: 'price.mjs', name: 'price' }, sourceDirectory: '.', targetDirectory: '.',
    testRoots: [testRoot], testRunner: 'vitest', targetTest: { executable: 'npm', args: ['test', '--'] } };
  const state: ToolState = { functionGroupTests: [{ status: 'success', testPaths: [testPath], tests: { executed: 1, passed: 1, failed: 0, skipped: 0 }, functions: [], failures: [], stdout: '', stderr: '', exitCode: 0 }] };
  const record = createTestArtifactRecorder(runtime, state, { id: 'prices' });
  await record(); const suite = (await readRetainedTestSuite(source, 'prices'))!;
  return { root, source, output, testPath, directory, record, suite, state };
}

it('retains tests through a model interruption, isolates existing tests and checkpoints every write', async () => {
  const root = await temporary(), output = join(root, 'output'); await mkdir(output);
  await mkdir(join(root, 'tests')); await writeFile(join(root, 'tests', 'enterprise_test.py'), 'DO NOT CHANGE');
  let turn = 0, testPath = '', updates = 0;
  const host = createAgentHost({ retainTests: { id: 'module', onUpdate: async (from, suite) => { updates++; await copyRetainedTestSuite(from, output, suite); } },
    modelClient: { complete: async messages => {
      if (turn++ > 0) throw new Error('model interrupted');
      const prompt = messages.find(message => message.role === 'user')!.content;
      testPath = `${prompt.match(/Authorized test roots: ([^\n]+)/)![1]}/test_price.py`;
      return { toolCalls: [{ id: 'write', name: 'write_target_test', arguments: JSON.stringify({ path: testPath, content: 'def test_price():\n    assert 2 == 2\n' }) }] };
    } },
  });
  await expect(host.run({ subject: { requirement: 'double', sourceFunction: { path: 'price.py', name: 'price' }, targetFunction: { path: 'price.py', name: 'price' } },
    taskContext: { sourceLanguage: 'Python', targetLanguage: 'Python', sourceProjectPath: root, targetProjectPath: root, sourcePath: 'price.py', targetPath: 'price.py', targetFunction: { path: 'price.py', name: 'price' } },
    systemPrompt: 'test', userPrompt: 'test', tools: [createWriteTargetTestTool()], terminalTools: [] })).rejects.toThrow('model interrupted');
  expect(await readFile(join(root, 'tests', 'enterprise_test.py'), 'utf8')).toBe('DO NOT CHANGE');
  expect(await readFile(join(output, testPath), 'utf8')).toContain('assert 2 == 2');
  expect((await readRetainedTestSuite(output, 'module'))?.status).toBe('not-run'); expect(updates).toBeGreaterThanOrEqual(2);
});

it('replays a delivered Vitest suite after relocation and fails when the actual production behavior regresses', async () => {
  const f = await fixture();
  await cp(join(f.source, 'package.json'), join(f.output, 'package.json')); await cp(join(f.source, 'price.mjs'), join(f.output, 'price.mjs'));
  await copyRetainedTestSuite(f.source, f.output, f.suite);
  // No reference to the verifier temporary tree is needed by the project.
  await rm(f.source, { recursive: true, force: true });
  const result = await exec(process.execPath, ['.recast-tests/run.cjs'], { cwd: f.output, windowsHide: true, timeout: 30_000 });
  expect(result.stdout).toContain('Retained RECAST suite passed');
  await writeFile(join(f.output, 'price.mjs'), 'export const price = value => value;\n');
  await expect(exec(process.execPath, ['.recast-tests/run.cjs'], { cwd: f.output, windowsHide: true, timeout: 30_000 })).rejects.toMatchObject({ code: 1 });
}, 60_000);

it('updates a fixed suite without duplication and recovers a partially applied delivery from its staged bytes', async () => {
  const f = await fixture(); await copyRetainedTestSuite(f.source, f.output, f.suite);
  await writeFile(join(f.source, f.testPath), (await readFile(join(f.source, f.testPath), 'utf8')) + '// second attempt\n');
  await f.record(); const next = (await readRetainedTestSuite(f.source, 'prices'))!;
  const pending = join(f.output, '.recast-tests-delivery', f.directory.split('/')[1]!);
  await cp(f.source, join(pending, 'files'), { recursive: true }); await writeFile(join(pending, 'ready'), 'prices');
  await writeFile(join(f.output, f.testPath), 'partial update');
  await recoverRetainedTestDelivery(f.output, 'prices');
  expect(await readRetainedTestSuite(f.output, 'prices')).toEqual(next);
  expect(next.testPaths).toEqual([f.testPath]);
  await expect(readFile(join(pending, 'ready'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects changed artifacts, path escalation and collisions with existing enterprise tests', async () => {
  const f = await fixture();
  const manifest = join(f.source, f.directory, 'manifest.json');
  await writeFile(join(f.source, f.testPath), 'unexpected changed test');
  await expect(readRetainedTestSuite(f.source, 'prices')).rejects.toThrow('changed');
  await f.record();
  const forged = JSON.parse(await readFile(manifest, 'utf8'));
  forged.files.push({ path: 'price.mjs', sha256: createHash('sha256').update(await readFile(join(f.source, 'price.mjs'))).digest('hex') });
  await writeFile(manifest, JSON.stringify(forged));
  await expect(readRetainedTestSuite(f.source, 'prices')).rejects.toThrow('Invalid retained test file');
  // Existing roots receive a module namespace, and even a matching name cannot
  // overwrite an enterprise-owned file unless a prior Host manifest owns it.
  const testRoot = `tests/recast/${f.directory.split('/')[1]}`;
  const path = `${testRoot}/existing.test.mjs`;
  await mkdir(join(f.source, testRoot), { recursive: true }); await mkdir(join(f.output, testRoot), { recursive: true });
  await writeFile(join(f.source, path), 'generated'); await writeFile(join(f.output, path), 'enterprise');
  await rm(manifest);
  const runtime: ToolRuntimeContext = { sourceLanguage: 'JavaScript', targetLanguage: 'JavaScript', sourceProjectPath: f.source, targetProjectPath: f.source, sourcePath: 'price.mjs', targetPath: 'price.mjs', targetFunction: { path: 'price.mjs', name: 'price' }, sourceDirectory: '.', targetDirectory: '.', testRoots: [testRoot], testRunner: 'vitest', targetTest: { executable: 'npm', args: [] } };
  await createTestArtifactRecorder(runtime, {}, { id: 'prices' })();
  await expect(copyRetainedTestSuite(f.source, f.output, (await readRetainedTestSuite(f.source, 'prices'))!)).rejects.toThrow('overwrite');
  expect(await readFile(join(f.output, path), 'utf8')).toBe('enterprise');
});
