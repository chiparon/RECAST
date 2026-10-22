// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { HistoryImportTasks } from './history-import-tasks';
import { isHostToWebviewMessage } from './protocol/messages';
import type { CodeIntelligenceRepositoryPresentation as Repository } from './ui-types';

function setup() {
  const values = new Map<string, unknown>();
  let now = Date.parse('2026-10-21T12:00:00Z');
  const store = { get: <T,>(key: string) => values.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }) };
  const publish = vi.fn(), errors = vi.fn();
  const create = () => new HistoryImportTasks({ store, key: 'history', publish, onPersistenceError: errors, now: () => now });
  const tasks = create();
  const observe = (...repositories: Repository[]) => tasks.observe({ status: 'ready', storage: 'seekdb', repositories });
  return { tasks, observe, values, create, publish, advance: (ms: number) => { now += ms; } };
}
function repository(id: string, patch: Partial<Repository> = {}): Repository {
  return { repositoryId: id, displayName: id, role: 'history', analysisStatus: 'registered', activeRevision: null,
    selectedRevision: null, revisions: [], languages: [], projects: [], selectedProjectId: null, summary: { status: 'missing' }, ...patch };
}
function project(id: string, state = 'analyzing', projection = 'pending'): Repository['projects'][number] {
  return { projectId: id, displayName: id, kind: 'node', relativePath: id, languageIds: ['typescript'],
    analysis: { repositoryId: 'orders', analysisRevision: 'r1', projectId: id, analysisProfile: 'profile', updatedAt: '',
      state, projection } as NonNullable<Repository['projects'][number]['analysis']> };
}
const indexed = (projects = [project('core')]) => repository('orders', { analysisStatus: 'ready', activeRevision: 'r1', selectedRevision: 'r1', projects });

it('persists serial queue/file progress and waits for every subproject and projection', async () => {
  const { tasks, observe, advance, values, publish } = setup();
  const first = repository('orders', { indexing: { stage: 'queued', position: 1, count: 2 } });
  const second = repository('stock', { indexing: { stage: 'queued', position: 2, count: 2 } });
  observe(first, second);
  expect(tasks.snapshot()).toHaveLength(2);
  advance(1000);
  tasks.indexing({ repositoryId: 'orders', displayName: 'orders', stage: 'parse', filesCompleted: 12, filesTotal: 20 });
  expect(tasks.snapshot().find(task => task.repositoryId === 'orders')).toMatchObject({ stage: 'parse', progress: { completed: 12, total: 20 } });
  observe(indexed([project('core', 'ready', 'ready'), project('api', 'ready')]), second);
  expect(tasks.snapshot().find(task => task.repositoryId === 'orders')).toMatchObject({ status: 'running', indexReady: true, modelReady: false, stage: 'modeling', progress: { completed: 1, total: 2 } });
  advance(5000);
  observe(indexed([project('core', 'ready', 'ready'), project('api', 'ready', 'ready')]), second);
  const done = tasks.snapshot().find(task => task.repositoryId === 'orders')!;
  expect(done).toMatchObject({ status: 'completed', indexReady: true, modelReady: true, elapsedMs: 6000 });
  expect(done.events.some(event => event.message.includes('12/20'))).toBe(true);
  await tasks.flush();
  expect(values.get('history')).toEqual(tasks.snapshot());
  expect(publish.mock.calls.every(([tasks]) => isHostToWebviewMessage({ type: 'HISTORY_IMPORT_TASKS', tasks }))).toBe(true);
});

it('retains scoped model failures, retries without losing history, and ignores stale failure snapshots', () => {
  const { tasks, observe } = setup();
  observe(indexed());
  const original = tasks.snapshot()[0]!.id;
  tasks.fail('orders', new Error('模型服务拒绝了请求 sk-testsecret123456789'), 'r1');
  observe(indexed()); // A sibling can still be analyzing after one model request failed.
  expect(tasks.snapshot()).toHaveLength(1);
  expect(tasks.snapshot()[0]).toMatchObject({ id: original, status: 'failed', indexReady: true, modelReady: false });
  expect(tasks.snapshot()[0]!.message).not.toContain('sk-testsecret');
  observe(indexed([project('core', 'failed')]));
  const retry = tasks.retry('orders');
  observe(indexed([project('core', 'failed')]));
  expect(tasks.snapshot()[0]).toMatchObject({ id: retry, status: 'running' });
  observe(indexed());
  observe(indexed([project('core', 'ready', 'ready')]));
  expect(tasks.snapshot()[0]).toMatchObject({ id: retry, status: 'completed', modelReady: true });
  expect(tasks.snapshot().find(task => task.id === original)?.status).toBe('failed');
});

it('records an early credential failure even if it precedes repository presentation, then resumes after saving settings', () => {
  const { tasks, observe } = setup();
  tasks.fail('orders', new Error('请配置 API Key'), 'r1');
  observe(indexed());
  expect(tasks.snapshot()[0]).toMatchObject({ status: 'failed', message: '请配置 API Key' });
  tasks.resumeModels();
  observe(indexed());
  expect(tasks.snapshot()[0]?.status).toBe('running');
  observe(indexed([project('core', 'ready', 'ready')]));
  expect(tasks.snapshot()[0]?.status).toBe('completed');
});

it('restores durable histories without inventing old durations or counting offline time', async () => {
  const { tasks, observe, advance, create } = setup();
  observe(indexed()); advance(2000);
  observe(indexed([project('core', 'validating')]));
  await tasks.flush(); advance(3_600_000);
  const reopened = create();
  expect(reopened.snapshot()[0]).toMatchObject({ status: 'interrupted', elapsedMs: 2000 });
  reopened.observe({ status: 'ready', storage: 'seekdb', repositories: [indexed([project('core', 'ready', 'ready')])] });
  // Recovered artifacts get a new result; the interrupted attempt keeps its true duration.
  expect(reopened.snapshot()[0]).toMatchObject({ status: 'completed', durationUnknown: true });
  expect(reopened.snapshot().find(task => task.status === 'interrupted')?.elapsedMs).toBe(2000);
  const restored = create();
  const cachedProject = project('core', 'ready', 'ready');
  cachedProject.analysis = { ...cachedProject.analysis!, repositoryId: 'cached', analysisRevision: 'cached-r1' };
  restored.observe({ status: 'ready', storage: 'seekdb', repositories: [repository('cached', {
    analysisStatus: 'ready', activeRevision: 'cached-r1', selectedRevision: 'cached-r1', projects: [cachedProject],
  })] });
  expect(restored.snapshot().find(task => task.repositoryId === 'cached')).toMatchObject({ status: 'completed', durationUnknown: true });
});

it('does not use historical selections, empty repositories or runtime errors as model acceptance', () => {
  const { tasks, observe } = setup();
  observe(indexed());
  tasks.observe({ status: 'error', runtimeStatus: 'error', storage: 'seekdb', repositories: [] });
  expect(tasks.snapshot()[0]?.status).toBe('running');
  observe({ ...indexed([project('core', 'ready', 'ready')]), selectedRevision: 'old-revision' });
  expect(tasks.snapshot()[0]?.status).toBe('running');
  observe({ ...indexed([project('core', 'ready', 'ready')]), activeRevision: 'r2', selectedRevision: 'r2' });
  expect(tasks.snapshot()[0]).toMatchObject({ status: 'running', modelReady: false });
  observe(indexed([]));
  expect(tasks.snapshot()[0]).toMatchObject({ status: 'failed', indexReady: true, modelReady: false });
  observe();
  expect(tasks.snapshot()[0]?.status).toBe('failed');
});

it('ignores old revision errors during a new index attempt and prevents duplicate retries', () => {
  const { tasks, observe } = setup();
  observe(indexed([project('core', 'ready', 'ready')]));
  const id = tasks.retry('orders', 'index');
  expect(() => tasks.retry('orders')).toThrow('正在导入');
  tasks.indexing({ repositoryId: 'orders', displayName: 'orders', stage: 'parse', completed: 1, total: 10 });
  tasks.fail('orders', new Error('旧版本失败'), 'r1');
  expect(tasks.snapshot()[0]).toMatchObject({ id, status: 'running', stage: 'parse' });
  observe({ ...indexed(), activeRevision: 'r2', selectedRevision: 'r2' });
  expect(tasks.snapshot()[0]).toMatchObject({ id, status: 'running', analysisRevision: 'r2' });
  tasks.fail('orders', new Error('旧版本失败'), 'r1');
  expect(tasks.snapshot()[0]?.status).toBe('running');
});

it('finishes a model retry immediately when validated cached models are reusable, while index retries wait for indexing', () => {
  const { tasks, observe } = setup();
  const ready = indexed([project('core', 'ready', 'ready')]);
  observe(ready);
  const modelRetry = tasks.retry('orders', 'model');
  observe(ready);
  expect(tasks.snapshot().find(task => task.id === modelRetry)?.status).toBe('completed');
  const indexRetry = tasks.retry('orders', 'index');
  observe(ready);
  expect(tasks.snapshot().find(task => task.id === indexRetry)?.status).toBe('running');
});

it('adopts a genuinely newer model job after restart while preserving the previous failure evidence', async () => {
  const { tasks, observe, create, advance } = setup();
  observe(indexed());
  tasks.fail('orders', new Error('原先的模型请求失败'), 'r1');
  const failedId = tasks.snapshot()[0]!.id;
  await tasks.flush(); advance(60_000);
  const reopened = create(), freshProject = project('core');
  freshProject.analysis!.updatedAt = '2026-10-21T12:01:00Z';
  reopened.observe({ status: 'ready', storage: 'seekdb', repositories: [indexed([freshProject])] });
  expect(reopened.snapshot()[0]?.status).toBe('running');
  expect(reopened.snapshot().find(task => task.id === failedId)?.status).toBe('failed');
  freshProject.analysis = { ...freshProject.analysis!, state: 'ready', projection: 'ready', updatedAt: '2026-10-21T12:01:02Z' };
  reopened.observe({ status: 'ready', storage: 'seekdb', repositories: [indexed([freshProject])] });
  expect(reopened.snapshot()[0]?.status).toBe('completed');
});
