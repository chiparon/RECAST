// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { TargetImportTasks, finishTargetImportModel } from './target-import-tasks';
import { isHostToWebviewMessage, isWebviewToHostMessage } from './protocol/messages';
import type { TargetImportTask } from './target-import-task-types';

function setup() {
  const values = new Map<string, unknown>();
  let now = Date.parse('2026-10-21T12:00:00Z');
  const store = { get: <T,>(key: string) => values.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }) };
  const publish = vi.fn(), errors = vi.fn();
  const create = (key = 'journal', previousKey?: string) => new TargetImportTasks({ store, key, previousKey, publish,
    onPersistenceError: errors, now: () => now });
  return { values, store, publish, errors, create, advance: (ms: number) => { now += ms; } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('keeps index success pending until the selected project model has actually finished', async () => {
  const { create, values, advance } = setup(), tasks = create(), id = tasks.begin('browse');
  tasks.directory(id, '/repos/orders');
  tasks.indexing(id, { repositoryId: 'orders', displayName: 'Orders', stage: 'parse', filesCompleted: 128, filesTotal: 460 });
  advance(2500);
  const gate = deferred(), ensureModel = vi.fn(() => gate.promise);
  const operation = finishTargetImportModel(tasks, id, { scope: async () => ({ repositoryId: 'orders', analysisRevision: 'r1' }),
    selectedProject: async () => 'core', ensureModel }, new AbortController().signal);
  await vi.waitFor(() => expect(ensureModel).toHaveBeenCalledOnce());
  expect(tasks.get(id)).toMatchObject({ status: 'running', stage: 'modeling', indexReady: true, modelReady: false, progress: undefined });
  gate.resolve(); await operation;
  expect(tasks.get(id)).toMatchObject({ status: 'completed', stage: 'complete', modelReady: true });
  const saved = values.get('journal') as TargetImportTask[];
  expect(saved[0]!.events.map(event => event.message).join('\n')).toContain('128/460');
  expect(saved[0]!.endedAt).toBe('2026-10-21T12:00:02.500Z');
});

it('restores history after workspace migration and resumes the same interrupted task without duplicating it', async () => {
  const { create, advance } = setup(), first = create('empty-window'), id = first.begin('input');
  first.directory(id, '/repos/orders'); first.update(id, { stage: 'attaching', message: '正在加入工作区' });
  await first.flush(); advance(1000);
  const restored = create('orders-workspace', 'empty-window');
  expect(restored.get(id)).toMatchObject({ status: 'interrupted', directory: '/repos/orders' });
  expect(restored.begin('input', id)).toBe(id);
  expect(restored.snapshot()).toHaveLength(1);
  restored.finish(id, 'failed', '模型服务不可用'); await restored.flush();
  const reopened = create('orders-workspace');
  expect(reopened.get(id)).toMatchObject({ status: 'failed', message: '模型服务不可用' });
  expect(reopened.get(id)!.events.map(event => event.message)).toContain('正在加入工作区');
});

it('retains completed index evidence on model failure, rejects duplicate workers and ignores unrelated progress', async () => {
  const { create } = setup(), tasks = create(), id = tasks.begin('workspace');
  tasks.directory(id, '/repos/orders'); tasks.update(id, { repositoryId: 'orders' });
  expect(() => tasks.begin('browse')).toThrow('已有目标工程');
  tasks.indexing(id, { repositoryId: 'other', displayName: 'Other', stage: 'parse', completed: 99, total: 100 });
  expect(tasks.get(id)!.displayName).toBe('orders');
  await expect(finishTargetImportModel(tasks, id, { scope: async () => ({ repositoryId: 'orders', analysisRevision: 'r1' }),
    selectedProject: async () => 'core', ensureModel: async () => { throw new Error('模型响应无效'); } }, new AbortController().signal)).rejects.toThrow('模型响应无效');
  tasks.finish(id, 'failed', '模型响应无效');
  expect(tasks.get(id)).toMatchObject({ status: 'failed', stage: 'modeling', indexReady: true, modelReady: false });
  tasks.indexing(id, { repositoryId: 'orders', displayName: 'Orders', stage: 'activation' });
  expect(tasks.get(id)!.stage).toBe('modeling');
});

it('never turns a stopped modeling wait green when a late model response arrives', async () => {
  const { create } = setup(), tasks = create(), id = tasks.begin('browse');
  tasks.directory(id, '/repos/orders');
  const gate = deferred(), controller = new AbortController(), ensureModel = vi.fn(() => gate.promise);
  const operation = finishTargetImportModel(tasks, id, { scope: async () => ({ repositoryId: 'orders', analysisRevision: 'r1' }),
    selectedProject: async () => 'core', ensureModel }, controller.signal);
  await vi.waitFor(() => expect(ensureModel).toHaveBeenCalledOnce());
  controller.abort(new DOMException('用户取消', 'AbortError')); tasks.finish(id, 'cancelled', '已停止等待');
  gate.resolve(); await expect(operation).rejects.toThrow('用户取消');
  expect(tasks.get(id)).toMatchObject({ status: 'cancelled', modelReady: false });
});

it('coalesces slow persistence writes, bounds history and validates task actions and snapshots', async () => {
  const { store, create } = setup();
  const gate = deferred(); store.update.mockImplementationOnce(async () => gate.promise);
  const tasks = create(), id = tasks.begin('browse');
  for (let index = 0; index < 300; index++) tasks.update(id, { message: `解析 ${index}` });
  gate.resolve(); await tasks.flush();
  expect(store.update.mock.calls.length).toBeLessThan(5);
  expect(tasks.get(id)!.events).toHaveLength(200);
  expect(isHostToWebviewMessage({ type: 'TARGET_IMPORT_TASKS', tasks: tasks.snapshot() })).toBe(true);
  expect(isHostToWebviewMessage({ type: 'TARGET_IMPORT_TASKS', tasks: [{ ...tasks.get(id), events: 'bad' }] })).toBe(false);
  expect(isWebviewToHostMessage({ type: 'TARGET_IMPORT_ACTION', taskId: id, action: 'retry' })).toBe(true);
  expect(isWebviewToHostMessage({ type: 'TARGET_IMPORT_ACTION', taskId: '../path', action: 'retry' })).toBe(false);
  expect(isWebviewToHostMessage({ type: 'TARGET_IMPORT_ACTION', taskId: id, action: 'retry', command: 'arbitrary' })).toBe(false);
  tasks.finish(id, 'completed', '完成');
  for (let index = 0; index < 35; index++) tasks.finish(tasks.begin('browse'), 'cancelled', '取消');
  expect(tasks.snapshot()).toHaveLength(30); await tasks.flush();
});

it('fails a durability checkpoint visibly instead of continuing a workspace mutation with no saved task', async () => {
  const { create, store, errors } = setup(), tasks = create(); await tasks.flush();
  store.update.mockRejectedValueOnce(new Error('disk full'));
  tasks.begin('browse');
  await expect(tasks.flush()).rejects.toThrow('disk full');
  expect(errors).toHaveBeenCalledOnce();
});

it('excludes offline time from resumed elapsed time and keeps credentials out of persisted failure messages', async () => {
  const { create, advance, values } = setup(), first = create(), id = first.begin('browse');
  advance(10_000); first.update(id, { message: '正在解析' }); await first.flush();
  advance(3_600_000);
  const restored = create();
  expect(restored.get(id)!.elapsedMs).toBe(10_000);
  restored.begin('browse', id); advance(5000);
  const token = 'sk-' + 'x'.repeat(24);
  restored.finish(id, 'failed', `请求失败 ${token}`); await restored.flush();
  expect(restored.get(id)!.elapsedMs).toBe(15_000);
  expect(JSON.stringify(values.get('journal'))).not.toContain(token);
});
