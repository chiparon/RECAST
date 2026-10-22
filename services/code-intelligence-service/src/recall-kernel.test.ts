import { describe, expect, it, vi } from 'vitest';
import type { RepositoryRevisionScope, SearchDocumentKind, SearchDocumentRecord } from '@forexplore/contracts';
import { RecallKernel, reciprocalRankOffset, recallViews } from './recall-kernel.js';
import type { IndexStore } from './index-store.js';

const scope: RepositoryRevisionScope = { repositoryId: 'repo', analysisRevision: 'rev' };

function document(id: string, kind: SearchDocumentKind, overrides: Partial<SearchDocumentRecord> = {}): SearchDocumentRecord {
  return { ...scope, searchDocumentId: id, kind, relativePath: `${id}.ts`, contentHash: `hash-${id}`, title: id, text: `${id} body`, ...overrides };
}

/** Corpus keyed by `query|view`; the fake honours the requested limit like the real store. */
function fakeStore(corpus: Record<string, SearchDocumentRecord[]>) {
  const calls: Array<{ query: string; limit: number; kind: SearchDocumentKind }> = [];
  const search = vi.fn(async (_scope: RepositoryRevisionScope, query: string, limit: number, kind: SearchDocumentKind = 'summary') => {
    calls.push({ query, limit, kind });
    return corpus[`${query}|${kind}`]?.slice(0, limit) ?? [];
  });
  return { store: { searchSearchDocuments: search } as Pick<IndexStore, 'searchSearchDocuments'>, calls, search };
}

describe('shared recall kernel', () => {
  it('batches repository lookups without changing scoped fusion, channel weights or ordering', async () => {
    const requests = ['repo', 'other'].map(repositoryId => ({ scope: { repositoryId, analysisRevision: 'rev' }, plans: [
      { label: 'summary', query: 'behavior', views: ['summary'] as const, weight: 1 },
      { label: 'implementation', query: 'identity', views: ['source-fragment'] as const, weight: 0.9 },
      { label: 'symbol', query: 'identity', views: ['symbol'] as const, weight: 0.7 },
    ], limitPerView: 2 }));
    const lookup = (scope: RepositoryRevisionScope, views: readonly SearchDocumentKind[]) => Object.fromEntries(views.map(kind =>
      [kind, [document(`${scope.repositoryId}-${kind}`, kind, scope)]]));
    const searchSearchDocumentsByViews = vi.fn(async (scope: RepositoryRevisionScope, _query: string, _limits: unknown,
      views: readonly SearchDocumentKind[]) => lookup(scope, views));
    const searchSearchDocumentsBatch = vi.fn(async (queries) => queries.map((query: any) => lookup(query.scope, query.views)));
    const expected = await Promise.all(requests.map(request => new RecallKernel({ searchSearchDocumentsByViews }).recall(request)));
    const actual = await new RecallKernel({ searchSearchDocumentsBatch }).recallBatch(requests);
    expect(actual).toEqual(expected);
    expect(searchSearchDocumentsBatch).toHaveBeenCalledTimes(1);
    expect(searchSearchDocumentsBatch.mock.calls[0]![0]).toHaveLength(4);
  });

  it('validates all batch requests before I/O and refuses cross-revision batch results', async () => {
    const searchSearchDocumentsBatch = vi.fn(async (queries) => queries.map(() => ({ symbol: [document('bad', 'symbol', { analysisRevision: 'old' })] })));
    const kernel = new RecallKernel({ searchSearchDocumentsBatch });
    const good = { scope, plans: [{ label: 'api', query: 'identity', weight: 0.7, views: ['symbol'] as const }] };
    await expect(kernel.recallBatch([good, { ...good, plans: [] }])).rejects.toThrow('at least one query plan');
    expect(searchSearchDocumentsBatch).not.toHaveBeenCalled();
    await expect(kernel.recallBatch([good])).rejects.toThrow('another revision');
  });

  it('shares repeated scoped questions while retaining each callers limits and plan weights', async () => {
    const requests = [
      { scope, plans: [{ label: 'primary', query: 'identity', weight: 1, views: ['symbol'] as const }], limitPerView: 1 },
      { scope, plans: [{ label: 'secondary', query: 'identity', weight: 0.7, views: ['symbol', 'summary'] as const }], limitPerView: 2 },
    ];
    const lookup = (views: readonly SearchDocumentKind[], limits: Partial<Record<SearchDocumentKind, number>>) =>
      Object.fromEntries(views.map(kind => [kind, [document(`${kind}-0`, kind), document(`${kind}-1`, kind)].slice(0, limits[kind])]));
    const searchSearchDocumentsByViews = vi.fn(async (_scope: RepositoryRevisionScope, _query: string,
      limits: Partial<Record<SearchDocumentKind, number>>, views: readonly SearchDocumentKind[]) => lookup(views, limits));
    const searchSearchDocumentsBatch = vi.fn(async (queries) => queries.map((query: any) => lookup(query.views, query.limits)));
    const expected = await Promise.all(requests.map(request => new RecallKernel({ searchSearchDocumentsByViews }).recall(request)));
    const actual = await new RecallKernel({ searchSearchDocumentsBatch }).recallBatch(requests);
    expect(actual).toEqual(expected);
    expect(searchSearchDocumentsBatch.mock.calls[0]![0]).toEqual([
      { scope, query: 'identity', views: ['symbol', 'summary'], limits: { symbol: 2, summary: 2 } },
    ]);
  });
  it('shares identical questions across plans without changing view weights or provenance', async () => {
    const fragment = document('body', 'source-fragment');
    const symbol = document('api', 'symbol');
    const perView = fakeStore({ 'same|source-fragment': [fragment], 'same|symbol': [symbol] });
    const batched = { searchSearchDocumentsByViews: vi.fn(async () => ({ 'source-fragment': [fragment], symbol: [symbol] })) };
    const request = { scope, plans: [
      { label: 'implementation', query: 'same', views: ['source-fragment'], weight: 0.9 },
      { label: 'api', query: 'same', views: ['symbol'], weight: 0.7 },
    ], limitPerView: 32 } as const;
    const expected = await new RecallKernel(perView.store).recall(request);
    const actual = await new RecallKernel(batched).recall(request);
    expect(batched.searchSearchDocumentsByViews).toHaveBeenCalledTimes(1);
    expect(batched.searchSearchDocumentsByViews).toHaveBeenCalledWith(scope, 'same', { 'source-fragment': 32, symbol: 32 }, ['source-fragment', 'symbol'], undefined);
    expect(actual).toEqual(expected);
  });

  it('asks a batching store once per plan and keeps the fused ranking identical', async () => {
    const symbol = [document('a', 'symbol'), document('b', 'symbol')];
    const fragments = [document('c', 'source-fragment'), document('a', 'source-fragment')];
    const perView = fakeStore({ 'query|symbol': symbol, 'query|source-fragment': fragments });
    const batchedCalls: Array<{ query: string; views: readonly SearchDocumentKind[]; limits: Record<string, number> }> = [];
    const batched = {
      searchSearchDocuments: vi.fn(),
      searchSearchDocumentsByViews: vi.fn(async (_scope: RepositoryRevisionScope, query: string,
        limits: Partial<Record<SearchDocumentKind, number>>, views: readonly SearchDocumentKind[]) => {
        batchedCalls.push({ query, views, limits: limits as Record<string, number> });
        const byView: Partial<Record<SearchDocumentKind, SearchDocumentRecord[]>> = {};
        for (const view of views) byView[view] = (view === 'symbol' ? symbol : view === 'source-fragment' ? fragments : [])
          .slice(0, limits[view] ?? 0);
        return byView;
      }),
    } as unknown as Pick<IndexStore, 'searchSearchDocuments' | 'searchSearchDocumentsByViews'>;

    const request = { scope, plans: [{ label: 'code-identity', query: 'query', weight: 1 }], limitPerView: 10 } as const;
    const expected = await new RecallKernel(perView.store).recall(request);
    const actual = await new RecallKernel(batched).recall(request);

    expect(batchedCalls).toHaveLength(1);
    expect(batchedCalls[0]!.views).toEqual([...recallViews]);
    expect(batchedCalls[0]!.limits).toEqual({ symbol: 10, 'source-fragment': 10, summary: 10 });
    expect(batched.searchSearchDocuments).not.toHaveBeenCalled();
    // Switching a projection onto the batched query must not move its ranking.
    expect(actual.documents.map((item) => item.searchDocumentId)).toEqual(expected.documents.map((item) => item.searchDocumentId));
    expect([...actual.fusedRanks]).toEqual([...expected.fusedRanks]);
    expect([...actual.provenance]).toEqual([...expected.provenance]);
    expect(actual.channels).toEqual(expected.channels);
  });

  it('fuses one plan across every view in plan-major channel order', async () => {
    const { store, calls } = fakeStore({
      'query|symbol': [document('a', 'symbol'), document('b', 'symbol')],
      'query|source-fragment': [document('c', 'source-fragment'), document('a', 'source-fragment')],
    });
    const outcome = await new RecallKernel(store).recall({ scope, plans: [{ label: 'code-identity', query: 'query', weight: 1 }], limitPerView: 10 });
    expect(calls.map((call) => call.kind)).toEqual([...recallViews]);
    expect(outcome.channels).toEqual([
      { planLabel: 'code-identity', view: 'symbol', documents: 2 },
      { planLabel: 'code-identity', view: 'source-fragment', documents: 2 },
      { planLabel: 'code-identity', view: 'summary', documents: 0 },
    ]);
    // Duplicates are preserved for the caller, while the fusion accumulates.
    expect(outcome.documents.map((item) => item.searchDocumentId)).toEqual(['a', 'b', 'c', 'a']);
    expect(outcome.fusedRanks.get('a')).toBeCloseTo(1 / reciprocalRankOffset + 1 / (reciprocalRankOffset + 1), 12);
    expect(outcome.fusedRanks.get('b')).toBeCloseTo(1 / (reciprocalRankOffset + 1), 12);
    expect(outcome.fusedRanks.get('c')).toBeCloseTo(1 / reciprocalRankOffset, 12);
    expect(outcome.provenance.get('a')).toEqual([
      { planLabel: 'code-identity', view: 'symbol', rank: 0, weight: 1 },
      { planLabel: 'code-identity', view: 'source-fragment', rank: 1, weight: 1 },
    ]);
    // A document matched by two channels still normalises to 1, so a single-view
    // caller keeps exactly the rank fallback it had before the kernel existed.
    expect(RecallKernel.normalise(outcome, 'a')).toBe(1);
    const best = 1 / reciprocalRankOffset + 1 / (reciprocalRankOffset + 1);
    expect(RecallKernel.normalise(outcome, 'c')).toBeCloseTo((1 / reciprocalRankOffset) / best, 12);
  });

  it('scales each plan by its weight and keeps plan-major ordering', async () => {
    const { store } = fakeStore({
      'baseline|symbol': [document('x', 'symbol')],
      'expanded|symbol': [document('y', 'symbol')],
    });
    const outcome = await new RecallKernel(store).recall({
      scope,
      plans: [{ label: 'baseline', query: 'baseline', weight: 0.25 }, { label: 'expanded', query: 'expanded', weight: 1 }],
      limitPerView: 5,
    });
    expect(outcome.documents.map((item) => item.searchDocumentId)).toEqual(['x', 'y']);
    expect(RecallKernel.normalise(outcome, 'x')).toBeCloseTo(0.25, 12);
    expect(RecallKernel.normalise(outcome, 'y')).toBe(1);
    expect(outcome.provenance.get('x')).toEqual([{ planLabel: 'baseline', view: 'symbol', rank: 0, weight: 0.25 }]);
  });

  it('passes one limit to every view, or a per-view limit when given one', async () => {
    const { store, calls } = fakeStore({
      'query|symbol': [document('a', 'symbol'), document('b', 'symbol'), document('c', 'symbol')],
      'query|source-fragment': [document('d', 'source-fragment')],
    });
    const kernel = new RecallKernel(store);
    const uniform = await kernel.recall({ scope, plans: [{ label: 'p', query: 'query', weight: 1 }], limitPerView: 2 });
    expect(calls.map((call) => call.limit)).toEqual([2, 2, 2]);
    expect(uniform.documents.map((item) => item.searchDocumentId)).toEqual(['a', 'b', 'd']);
    calls.length = 0;
    const perView = await kernel.recall({
      scope,
      plans: [{ label: 'p', query: 'query', weight: 1 }],
      limitPerView: { symbol: 1, 'source-fragment': 3 },
    });
    expect(calls).toEqual([
      { query: 'query', limit: 1, kind: 'symbol' },
      { query: 'query', limit: 3, kind: 'source-fragment' },
      { query: 'query', limit: 32, kind: 'summary' },
    ]);
    expect(perView.documents.map((item) => item.searchDocumentId)).toEqual(['a', 'd']);
  });

  it('can be restricted to an explicit view list', async () => {
    const { store, calls } = fakeStore({ 'query|summary': [document('s', 'summary')] });
    const outcome = await new RecallKernel(store).recall({ scope, plans: [{ label: 'p', query: 'query', weight: 1 }], views: ['summary'], limitPerView: 4 });
    expect(calls).toEqual([{ query: 'query', limit: 4, kind: 'summary' }]);
    expect(outcome.channels).toEqual([{ planLabel: 'p', view: 'summary', documents: 1 }]);
  });

  it('routes behavior and symbol questions to their own views without multiplying recall work', async () => {
    const { store, calls } = fakeStore({
      'behavior|summary': [document('s', 'summary')],
      'behavior|source-fragment': [document('f', 'source-fragment')],
      'identity|symbol': [document('i', 'symbol')],
    });
    const outcome = await new RecallKernel(store).recall({ scope, plans: [
      { label: 'behavior', query: 'behavior', weight: 1, views: ['summary', 'source-fragment'] },
      { label: 'identity', query: 'identity', weight: 0.7, views: ['symbol'] },
    ], limitPerView: 4 });
    expect(calls).toEqual([
      { query: 'behavior', kind: 'summary', limit: 4 },
      { query: 'behavior', kind: 'source-fragment', limit: 4 },
      { query: 'identity', kind: 'symbol', limit: 4 },
    ]);
    expect(outcome.provenance.get('i')).toEqual([{ planLabel: 'identity', view: 'symbol', rank: 0, weight: 0.7 }]);
  });

  it('validates every view restriction before issuing any lookup', async () => {
    const { store, search } = fakeStore({});
    for (const views of [[], ['invalid'], ['symbol', 'invalid']] as any[]) {
      await expect(new RecallKernel(store).recall({ scope, plans: [
        { label: 'good', query: 'q', weight: 1 }, { label: 'invalid', query: 'q', weight: 1, views },
      ] })).rejects.toThrow('valid views');
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('refuses a document that belongs to another revision', async () => {
    const { store } = fakeStore({ 'query|symbol': [document('a', 'symbol', { analysisRevision: 'other' })] });
    await expect(new RecallKernel(store).recall({ scope, plans: [{ label: 'p', query: 'query', weight: 1 }] }))
      .rejects.toThrow('Search returned a document from another revision.');
  });

  it('rejects invalid plans, weights and limits before recalling', async () => {
    const { store, search } = fakeStore({});
    const kernel = new RecallKernel(store);
    await expect(kernel.recall({ scope, plans: [] })).rejects.toThrow('at least one query plan');
    await expect(kernel.recall({ scope, plans: [{ label: '  ', query: 'q', weight: 1 }] })).rejects.toThrow('needs a label and a query');
    await expect(kernel.recall({ scope, plans: [{ label: 'p', query: ' ', weight: 1 }] })).rejects.toThrow('needs a label and a query');
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(kernel.recall({ scope, plans: [{ label: 'p', query: 'q', weight }] })).rejects.toThrow('positive weight');
    }
    for (const limitPerView of [0, -3, 2.5, 201, { symbol: 0 }, { summary: 1.5 }] as const) {
      await expect(kernel.recall({ scope, plans: [{ label: 'p', query: 'q', weight: 1 }], limitPerView })).rejects.toThrow('per-view limit');
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('requires a bounded search-document query', async () => {
    await expect(new RecallKernel({}).recall({ scope, plans: [{ label: 'p', query: 'q', weight: 1 }] }))
      .rejects.toThrow('Recall requires a bounded search-document query.');
  });

  it('normalises an unknown or empty outcome to zero', async () => {
    const { store } = fakeStore({ 'query|symbol': [document('a', 'symbol')] });
    const outcome = await new RecallKernel(store).recall({ scope, plans: [{ label: 'p', query: 'query', weight: 1 }] });
    expect(RecallKernel.normalise(outcome, 'missing')).toBe(0);
    expect(RecallKernel.normalise({ documents: [], fusedRanks: new Map(), provenance: new Map(), channels: [] }, 'a')).toBe(0);
  });

  it('reproduces the historical single-view rank fallback exactly', async () => {
    const corpus = { 'query|summary': Array.from({ length: 4 }, (_, index) => document(`doc-${index}`, 'summary')) };
    const { store, calls } = fakeStore(corpus);
    const outcome = await new RecallKernel(store).recall({ scope, plans: [{ label: 'code-identity', query: 'query', weight: 1 }], views: ['summary'], limitPerView: 8 });
    expect(calls).toEqual([{ query: 'query', limit: 8, kind: 'summary' }]);
    // 61 / (61 + rank) is what both projections used before the kernel existed.
    outcome.documents.forEach((item, rank) => {
      expect(RecallKernel.normalise(outcome, item.searchDocumentId)).toBeCloseTo(reciprocalRankOffset / (reciprocalRankOffset + rank), 12);
    });
  });
});
