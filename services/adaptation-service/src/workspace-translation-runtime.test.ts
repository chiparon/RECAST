import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceTranslationRequest, WorkspaceTranslationRun } from '@forexplore/contracts';
import { WorkspaceTranslationRuntime } from './workspace-translation-runtime.js';
import type { WorkspaceTranslationModelClient } from './workspace-translation-agent.js';
import type { DeepSeekToolCompletion, DeepSeekToolMessage } from './deepseek-client.js';
import { createHttpServer } from './http-server.js';

const roots: string[] = [], runtimes: WorkspaceTranslationRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const call = (name: string, args = {}): DeepSeekToolCompletion => ({ content: '', toolCalls: [{ id: `tool-${name}`, name, arguments: JSON.stringify(args) }] });
const good = 'export function limit(value) { if (value < 0) throw new Error("negative"); return value + 1; }\n';
const bad = 'export function limit(value) { return value + 1; }\n';
const request: WorkspaceTranslationRequest = { spec: 'Increment nonnegative input and reject negative input.', sourceLanguage: 'Java', targetLanguage: 'JavaScript',
  context: [{ id: 'source', kind: 'source', content: 'int limit(int value) { if (value < 0) throw new IllegalArgumentException(); return value + 1; }' }],
  workspaceFiles: ['target.mjs', 'verify.mjs'], writeFiles: ['target.mjs'] };
const plan = { summary: 'Preserve boundary behavior', mappings: [{ source: 'limit', targetPath: 'target.mjs', targetSymbol: 'limit' }], dependencies: [],
  steps: [{ id: 'implement', description: 'Implement and validate limit', files: ['target.mjs'], dependsOn: [] }] };
function scripted(steps: Array<DeepSeekToolCompletion | ((messages: readonly DeepSeekToolMessage[]) => DeepSeekToolCompletion)>): WorkspaceTranslationModelClient {
  let turn = 0;
  return { complete: async messages => { const next = steps[turn++]; if (!next) throw new Error('Unexpected model turn'); return typeof next === 'function' ? next(messages) : next; } };
}
const prefix = (content = good) => [call('submit_plan', plan), call('read_file', { path: 'target.mjs' }),
  call('write_file', { path: 'target.mjs', expectedHash: hash('// original\n'), content }), call('complete_step', { stepId: 'implement' }), call('compile')];
async function setup(client: WorkspaceTranslationModelClient, verification = true, target = '// original\n') {
  const root = await mkdtemp(join(tmpdir(), 'huawei-translation-')); roots.push(root);
  await writeFile(join(root, 'target.mjs'), target);
  await writeFile(join(root, 'verify.mjs'), 'import assert from "node:assert/strict"; import { limit } from "./target.mjs"; assert.equal(limit(0), 1); assert.equal(limit(9), 10); assert.throws(() => limit(-1), /negative/);\n');
  const options = { workspaceRoot: root, compileCommand: { executable: process.execPath, args: ['--check', 'target.mjs'] }, client, maxModelTurns: 30,
    ...(verification ? { verification: { command: { executable: process.execPath, args: ['verify.mjs'] }, protectedFiles: ['verify.mjs'] } } : {}) };
  const runtime = new WorkspaceTranslationRuntime(options); runtimes.push(runtime);
  return { root, runtime, options };
}
async function finished(runtime: WorkspaceTranslationRuntime, id: string) {
  for (let i = 0; i < 250; i++) {
    const value = runtime.get(id);
    if (['completed', 'failed', 'cancelled'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Translation did not finish');
}

describe('workspace behavioral acceptance', () => {
  it('refuses idle shutdown while a run executes and closes admission after completion', async () => {
    const { runtime } = await setup(scripted([...prefix(), call('finish')]), false);
    const run = runtime.start(request);
    expect(await runtime.shutdownIfIdle()).toBe(false);
    expect((await finished(runtime, run.id)).status).toBe('completed');
    expect(await runtime.shutdownIfIdle()).toBe(true);
    expect(() => runtime.start(request)).toThrow('shutting down');
  });
  it('rejects compile-only completion, repairs a real failed behavior, and supports restart-safe rollback', async () => {
    const { runtime, root, options } = await setup(scripted([...prefix(bad), call('run_tests'), call('finish'), messages => {
      expect(messages.at(-1)?.content).toContain('passing behavioral verification');
      return call('read_file', { path: 'target.mjs' });
    }, call('write_file', { path: 'target.mjs', expectedHash: hash(bad), content: good }), call('complete_step', { stepId: 'implement' }),
    call('compile'), call('run_tests'), call('finish')]));
    const final = await finished(runtime, runtime.start(request).id);
    expect(final).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
    expect(final.verification?.runs.map(value => value.success)).toEqual([false, true]);
    expect(final.verification?.runs.every(value => value.filesUnchanged && value.sourceSnapshot.length === 64 && value.planHash.length === 64)).toBe(true);
    await runtime.shutdown();
    const restored = new WorkspaceTranslationRuntime(options); runtimes.push(restored);
    expect(restored.get(final.id).acceptance).toBe('behavior-verified');
    expect(restored.rollback(final.id).status).toBe('rolled-back');
    expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe('// original\n');
  });

  it('requires a new verification after source changes following successful tests', async () => {
    const { runtime } = await setup(scripted([...prefix(), call('run_tests'), call('read_file', { path: 'target.mjs' }),
      call('write_file', { path: 'target.mjs', expectedHash: hash(good), content: bad }), call('complete_step', { stepId: 'implement' }), call('compile'), call('finish'),
      messages => { expect(messages.at(-1)?.content).toContain('passing behavioral verification'); return call('report_blocker', { reason: 'Verification must be repeated' }); }]));
    const result = await finished(runtime, runtime.start(request).id);
    expect(result).toMatchObject({ status: 'failed', acceptance: 'compilation-only' });
  });

  it('rejects writes to criteria and detects criteria changes outside the task', async () => {
    let root = '';
    const state = await setup(scripted([...prefix(), call('run_tests'), asyncLast])); root = state.root;
    function asyncLast() { return call('finish'); }
    expect(() => state.runtime.start({ ...request, writeFiles: ['target.mjs', 'verify.mjs'] })).toThrow('criteria');
    const run = state.runtime.start(request);
    await writeFile(join(root, 'verify.mjs'), '// weakened suite\n');
    const result = await finished(state.runtime, run.id);
    expect(result.status).toBe('failed');
    expect(result.acceptance).toBe('compilation-only');
  });

  it('keeps unconfigured runs compilation-only', async () => {
    const { runtime } = await setup(scripted([...prefix(), call('finish')]), false);
    expect(await finished(runtime, runtime.start(request).id)).toMatchObject({ status: 'completed', acceptance: 'compilation-only' });
  });

  it('exposes real verification records and rollback through the authenticated HTTP route', async () => {
    const { runtime, root } = await setup(scripted([...prefix(), call('run_tests'), call('finish')]));
    const token = 'test-huawei-token'.repeat(3);
    const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Unused legacy route'); } }, workspaceTranslation: { runtime, bearerToken: token } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/workspace-translations`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    try {
      expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      expect(response.status).toBe(202);
      const started = await response.json() as WorkspaceTranslationRun;
      await finished(runtime, started.id);
      const result = await (await fetch(`${endpoint}/${started.id}`, { headers })).json() as WorkspaceTranslationRun;
      expect(result).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
      expect(result.verification?.runs[0]?.exitCode).toBe(0);
      expect((await fetch(`${endpoint}/${started.id}/rollback`, { method: 'POST', headers })).status).toBe(200);
      expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe('// original\n');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});

/**
 * A whole-file write is the only way to change a file today, so a one-line fix
 * resends the whole file and a regeneration can drop what the model did not
 * repeat. These cover the anchored alternative: same invariants, smaller change.
 */
describe('anchored file edits', () => {
  const stub = '// header\nexport function keep() { return 1; }\nexport function limit(value) { throw new Error("todo"); }\n';
  const fixed = '// header\nexport function keep() { return 1; }\nexport function limit(value) { if (value < 0) throw new Error("negative"); return value + 1; }\n';
  const editPrefix = [call('submit_plan', plan), call('read_file', { path: 'target.mjs' })];

  it('changes only the named text and keeps the rest of the file intact', async () => {
    const { runtime, root } = await setup(scripted([
      ...editPrefix,
      call('edit_file', {
        path: 'target.mjs', expectedHash: hash(stub),
        edits: [{ oldText: 'throw new Error("todo");', newText: 'if (value < 0) throw new Error("negative"); return value + 1;' }],
      }),
      call('complete_step', { stepId: 'implement' }), call('compile'), call('run_tests'), call('finish'),
    ]), true, stub);
    const result = await finished(runtime, runtime.start(request).id);
    expect(result).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
    expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe(fixed);
    // The change record carries the untouched header, so review sees a real diff.
    expect(result.changes[0]).toMatchObject({ path: 'target.mjs', before: stub, after: fixed, applied: true });
  });

  it('refuses an ambiguous or missing anchor and leaves the file unchanged', async () => {
    const ambiguous = '// header\nexport function limit(value) { throw new Error("todo"); }\nexport function other(value) { throw new Error("todo"); }\n';
    const { runtime, root } = await setup(scripted([
      ...editPrefix,
      messages => {
        expect(messages.at(-1)?.content).toContain('anchor matches 2 times');
        return call('edit_file', { path: 'target.mjs', expectedHash: hash(ambiguous), edits: [{ oldText: 'absent text', newText: 'x' }] });
      },
      messages => {
        expect(messages.at(-1)?.content).toContain('anchor was not found');
        return call('report_blocker', { reason: 'anchors unavailable' });
      },
    ]), false, ambiguous);
    const result = await finished(runtime, runtime.start(request).id);
    expect(result.status).toBe('failed');
    expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe(ambiguous);
  });

  it('requires a fresh read after an edit, and rejects files outside the plan', async () => {
    const { runtime, root } = await setup(scripted([
      ...editPrefix,
      call('edit_file', {
        path: 'target.mjs', expectedHash: hash(stub),
        edits: [{ oldText: 'export function keep() { return 1; }', newText: 'export function keep() { return 2; }' }],
      }),
      // The edit consumed the read, so this replay of the same hash must be refused.
      call('edit_file', {
        path: 'target.mjs', expectedHash: hash(stub),
        edits: [{ oldText: 'export function keep() { return 2; }', newText: 'export function keep() { return 3; }' }],
      }),
      messages => {
        expect(messages.at(-1)?.content).toContain('Read the file before writing and supply its hash');
        return call('edit_file', { path: 'verify.mjs', expectedHash: hash('unused'), edits: [{ oldText: 'assert', newText: 'assertion' }] });
      },
      messages => {
        expect(messages.at(-1)?.content).toContain('outside the implementation plan');
        return call('read_file', { path: 'target.mjs' });
      },
      messages => {
        const content = JSON.parse(messages.at(-1)!.content).content as string;
        return call('edit_file', {
          path: 'target.mjs', expectedHash: hash(content),
          edits: [{ oldText: 'throw new Error("todo");', newText: 'if (value < 0) throw new Error("negative"); return value + 1;' }],
        });
      },
      call('complete_step', { stepId: 'implement' }), call('compile'), call('run_tests'), call('finish'),
    ]), true, stub);
    const result = await finished(runtime, runtime.start(request).id);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
    // The refused replay left no trace: keep() keeps the first edit's value.
    expect(await readFile(join(root, 'target.mjs'), 'utf8'))
      .toBe(fixed.replace('return 1;', 'return 2;'));
  });
});
