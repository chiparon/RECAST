import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { SearchQueryGate } from './search-query-gate.js';
import { SeekDbIndexStore } from './seekdb-index-store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('search SQL scheduling', () => {
  it('bounds active work across callers and starts waiting work as soon as a slot is released', async () => {
    const gate = new SearchQueryGate(2);
    const completions = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let active = 0;
    let maximum = 0;
    const results = completions.map((completion, index) => gate.run(async () => {
      started.push(index);
      maximum = Math.max(maximum, ++active);
      await completion.promise;
      active -= 1;
      return index;
    }));
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    completions[1]!.resolve();
    await results[1];
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    for (const completion of completions) completion.resolve();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(maximum).toBe(2);
  });

  it('removes cancelled waiters without starting SQL or losing capacity', async () => {
    const gate = new SearchQueryGate(1);
    const completion = deferred();
    const first = gate.run(() => completion.promise);
    const controller = new AbortController();
    const cancelledSql = vi.fn(async () => undefined);
    const cancelled = gate.run(cancelledSql, controller.signal);
    const nextSql = vi.fn(async () => 'next');
    const next = gate.run(nextSql);
    controller.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    expect(cancelledSql).not.toHaveBeenCalled();
    completion.resolve();
    await first;
    expect(await next).toBe('next');
    expect(nextSql).toHaveBeenCalledOnce();
  });

  it('releases capacity after SQL failure and rejects cancellation before starting', async () => {
    const gate = new SearchQueryGate(1);
    const failed = gate.run(async () => { throw new Error('SQL failed'); });
    const next = gate.run(async () => 'ready');
    await expect(failed).rejects.toThrow('SQL failed');
    expect(await next).toBe('ready');
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const execute = vi.fn(async () => undefined);
    await expect(gate.run(execute, controller.signal)).rejects.toThrow('already cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('shares the SQL budget across batches while allowing lightweight metadata reads', async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('MATCH(') && !sql.includes('cosine_distance')) return [[]];
      maximum = Math.max(maximum, ++active);
      const completion = deferred();
      releases.push(completion.resolve);
      await completion.promise;
      active -= 1;
      return [[]];
    });
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '',
      database: 'bounded_test', searchQueryConcurrency: 2 }, { query } as unknown as Pool);
    const requests = ['a', 'b'].map(repositoryId => store.searchSearchDocumentsByViews(
      { repositoryId, analysisRevision: 'revision' }, 'same capability',
      { summary: 2, symbol: 2, 'source-fragment': 2 }, ['summary', 'symbol', 'source-fragment']));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(await store.getRepository('metadata')).toBeNull();
    for (let completed = 0; completed < 8; completed++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(completed));
      releases[completed]!();
    }
    await Promise.all(requests);
    expect(maximum).toBe(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes('cosine_distance'))).toHaveLength(6);
  });

  it.each([0, -1, 1.5, 65, NaN])('rejects an invalid connection limit %s', (connectionLimit) => {
    expect(() => new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '',
      database: 'bounded_test', connectionLimit }, {} as Pool)).toThrow('connection limit');
  });

  it.each([-1, 1.5, 33, NaN])('rejects an invalid SQL budget %s', (searchQueryConcurrency) => {
    expect(() => new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '',
      database: 'bounded_test', searchQueryConcurrency }, {} as Pool)).toThrow('SQL concurrency');
  });
});
