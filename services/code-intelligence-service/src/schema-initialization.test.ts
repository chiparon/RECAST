import type { Pool, PoolConnection } from 'mysql2/promise';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeSchema, isSchemaBusy, schemaLockName } from './schema-initialization.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
    return [[]];
  });
  const connection = { query, release: vi.fn(), destroy: vi.fn() };
  const pool = { getConnection: vi.fn(async () => connection), query: vi.fn() };
  return { query, connection, pool: pool as unknown as Pool };
}

it('holds the database lock on the session that executes all schema work', async () => {
  const { pool, connection, query } = fixture();
  const operation = vi.fn(async (session: PoolConnection) => {
    expect(session).toBe(connection);
    expect(query.mock.calls.some(([sql]) => sql.includes('GET_LOCK'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes('RELEASE_LOCK'))).toBe(false);
  });
  await initializeSchema(pool, 'shared', operation);
  expect(operation).toHaveBeenCalledOnce();
  expect(pool.query).not.toHaveBeenCalled();
  expect(query.mock.calls.at(-1)?.[0]).toContain('RELEASE_LOCK');
  expect(connection.release).toHaveBeenCalledOnce();
  expect(schemaLockName('shared')).toBe(schemaLockName('SHARED'));
  expect(schemaLockName('shared')).not.toBe(schemaLockName('other'));
});

it('waits for another host before inspecting or changing the schema', async () => {
  const { pool, query } = fixture();
  query.mockResolvedValueOnce([[{ acquired: 0 }]]);
  const progress = vi.fn();
  const operation = vi.fn(async () => {});
  await initializeSchema(pool, 'shared', operation, { onProgress: progress });
  expect(operation).toHaveBeenCalledOnce();
  expect(progress.mock.calls.some(([p]) => p.stage === 'waiting')).toBe(true);
  expect(progress.mock.calls.at(-1)?.[0].stage).toBe('ready');
});

it('rechecks the schema after a disconnected predecessor finishes its DDL', async () => {
  vi.useFakeTimers();
  const { pool } = fixture();
  let columnExists = false;
  const addColumn = vi.fn(() => { columnExists = true; throw Object.assign(new Error('Operation not allowed now'), { errno: 1148 }); });
  const markApplied = vi.fn();
  const operation = vi.fn(async () => { if (!columnExists) addColumn(); markApplied(); });
  const result = initializeSchema(pool, 'shared', operation);
  await vi.runAllTimersAsync();
  await result;
  expect(operation).toHaveBeenCalledTimes(2);
  expect(addColumn).toHaveBeenCalledOnce();
  expect(markApplied).toHaveBeenCalledOnce();
});

it('bounds waiting for an unfinished DDL operation and releases the lock', async () => {
  vi.useFakeTimers();
  const { pool, connection } = fixture();
  const error = Object.assign(new Error('Operation not allowed now'), { errno: 1148 });
  const result = initializeSchema(pool, 'shared', async () => { throw error; }, { timeoutMs: 2000 });
  const assertion = expect(result).rejects.toThrow('等待超时');
  await vi.runAllTimersAsync();
  await assertion;
  expect(connection.release).toHaveBeenCalledOnce();
});

it('does not run schema work when another owner holds the lock past the wait budget', async () => {
  const { pool, query, connection } = fixture();
  query.mockResolvedValue([[{ acquired: 0 }]]);
  const operation = vi.fn();
  await expect(initializeSchema(pool, 'shared', operation, { timeoutMs: 1 })).rejects.toThrow('等待索引数据库升级超时');
  expect(operation).not.toHaveBeenCalled();
  expect(connection.destroy).toHaveBeenCalledOnce();
});

it('fails fast on permission errors, preserves the cause and releases the lock', async () => {
  const { pool, connection } = fixture();
  const error = Object.assign(new Error('access denied'), { errno: 1142 });
  const operation = vi.fn(async () => { throw error; });
  await expect(initializeSchema(pool, 'shared', operation)).rejects.toMatchObject({ cause: error, message: expect.stringContaining('1142') });
  expect(operation).toHaveBeenCalledOnce();
  expect(connection.release).toHaveBeenCalledOnce();
  expect(isSchemaBusy(error)).toBe(false);
});

it('destroys a session if releasing its lock fails', async () => {
  const { pool, query, connection } = fixture();
  query.mockImplementation(async sql => {
    if (sql.includes('RELEASE_LOCK')) throw new Error('connection lost');
    return [[{ acquired: 1 }]];
  });
  await initializeSchema(pool, 'shared', async () => {});
  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(connection.release).not.toHaveBeenCalled();
});
