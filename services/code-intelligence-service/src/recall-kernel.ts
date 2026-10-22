import type { RepositoryRevisionScope, SearchDocumentRecord } from '@forexplore/contracts';
import type { IndexStore, SearchDocumentQuery, SearchDocumentsByView } from './index-store.js';

/**
 * Shared recall kernel for both retrieval projections.
 *
 * A projection owns the *question* (what a code identity or a natural-language
 * requirement means) and the *interpretation* (which entity a recalled document
 * resolves to, and how candidates are ranked). The kernel owns only the part
 * that used to be implemented twice: multi-view recall over the indexed
 * documents and the weighted reciprocal-rank fusion of the results.
 *
 * Fusion is deliberately identical to the inline implementation it replaces, so
 * switching a projection onto the kernel is not supposed to move its ranking.
 */
export const recallViews = ['symbol', 'source-fragment', 'summary'] as const;
export type RecallView = SearchDocumentRecord['kind'];
/** Rank offset that keeps the first hit from dominating the fused score. */
export const reciprocalRankOffset = 61;
const defaultLimitPerView = 32;

export interface RecallPlan {
  /** Stable label such as `code-identity`, `requirement` or `expanded`. */
  label: string;
  query: string;
  /** Relative contribution of this plan's channels to the fused score. */
  weight: number;
  /** Restrict this question to the views it describes; otherwise use request views. */
  views?: readonly RecallView[];
}

export interface RecallChannel {
  planLabel: string;
  view: RecallView;
  documents: number;
}

export interface RecallProvenance {
  planLabel: string;
  view: RecallView;
  /** Zero-based rank inside that channel. */
  rank: number;
  weight: number;
}

export interface RecallOutcome {
  /**
   * Every channel's documents concatenated in channel order (plan-major, then
   * view), duplicates preserved because callers reason about per-hit context.
   */
  documents: SearchDocumentRecord[];
  /** Weighted reciprocal-rank fusion per search document id. */
  fusedRanks: Map<string, number>;
  /** Which plans and views matched a document, and at which rank. */
  provenance: Map<string, RecallProvenance[]>;
  channels: RecallChannel[];
}

export interface RecallRequest {
  scope: RepositoryRevisionScope;
  plans: readonly RecallPlan[];
  /** Views to recall from; defaults to every indexed view. */
  views?: readonly RecallView[];
  /** One limit for all views, or a per-view limit. */
  limitPerView?: number | Partial<Record<RecallView, number>>;
  signal?: AbortSignal;
}

export class RecallKernel {
  constructor(private readonly store: Pick<IndexStore, 'searchSearchDocuments' | 'searchSearchDocumentsByViews' | 'searchSearchDocumentsBatch'>) {}

  /** Batch only within this request. The regular recall method still owns
   * validation, channel order and fusion; a scoped router supplies its results. */
  async recallBatch(requests: readonly RecallRequest[], concurrency = 4): Promise<RecallOutcome[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Recall concurrency must be in 1..32.');
    const searchBatch = this.store.searchSearchDocumentsBatch;
    if (!searchBatch) {
      const result: RecallOutcome[] = new Array(requests.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
        while (next < requests.length) {
          const index = next++;
          result[index] = await this.recall(requests[index]!);
        }
      }));
      return result;
    }
    const lookups: SearchDocumentQuery[] = [];
    const indices = new Map<string, number>();
    const keyFor = (scope: RepositoryRevisionScope, query: string) => JSON.stringify([scope.repositoryId, scope.analysisRevision, query]);
    // Planning uses the same validation as live recall and performs no I/O.
    const planner = new RecallKernel({ searchSearchDocumentsByViews: async (scope, query, limits, views) => {
      const key = keyFor(scope, query);
      const existing = indices.get(key);
      if (existing !== undefined) {
        const lookup = lookups[existing]!;
        lookup.views = [...new Set([...lookup.views, ...views])];
        for (const view of views) lookup.limits[view] = Math.max(lookup.limits[view] ?? 0, limits[view] ?? 0);
      } else {
        indices.set(key, lookups.length);
        lookups.push({ scope, query, limits: { ...limits }, views: [...views] });
      }
      return {};
    } });
    for (const request of requests) {
      request.signal?.throwIfAborted();
      await planner.recall(request);
    }
    if (!requests.length) return [];
    const signals = [...new Set(requests.flatMap(request => request.signal ? [request.signal] : []))];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    const results = await searchBatch.call(this.store, lookups, signal, concurrency);
    if (results.length !== lookups.length) throw new Error('Batch recall omitted a scoped result.');
    const router = new RecallKernel({ searchSearchDocumentsByViews: async (scope, query, limits, views) => {
      const index = indices.get(keyFor(scope, query));
      if (index === undefined) throw new Error('Batch recall received an unplanned query.');
      return Object.fromEntries(views.map(view => [view, (results[index]?.[view] ?? []).slice(0, limits[view])]));
    } });
    return Promise.all(requests.map(request => router.recall(request)));
  }

  async recall(request: RecallRequest): Promise<RecallOutcome> {
    const search = this.store.searchSearchDocuments;
    const searchByViews = this.store.searchSearchDocumentsByViews;
    if (!search && !searchByViews) throw new Error('Recall requires a bounded search-document query.');
    if (request.plans.length === 0) throw new Error('Recall requires at least one query plan.');
    for (const plan of request.plans) {
      if (!plan.label.trim() || !plan.query.trim()) throw new Error('Every recall plan needs a label and a query.');
      if (!Number.isFinite(plan.weight) || plan.weight <= 0) throw new Error('Every recall plan needs a positive weight.');
    }
    const views = request.views ?? recallViews;
    const limitFor = (view: RecallView): number => {
      const limit = typeof request.limitPerView === 'number'
        ? request.limitPerView
        : request.limitPerView?.[view] ?? defaultLimitPerView;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Recall per-view limit must be an integer in 1..200.');
      return limit;
    };
    // Validate every limit before issuing any query, so an invalid request never
    // reaches the store with a half-finished fan-out.
    const limits = new Map(views.map((view) => [view, limitFor(view)] as const));

    // One channel per (plan, view) pair, merged in a fixed plan-major order so
    // the fused result stays deterministic. A store that can batch the views is
    // asked once per plan: it can share one embedding and bounded hydration
    // while retaining an independent candidate budget for each view.
    const plannedViews = request.plans.map(plan => {
      if (plan.views?.some(view => !recallViews.includes(view))) throw new Error('Every recall plan needs valid views.');
      const selected = plan.views ? [...new Set(plan.views)].filter(view => views.includes(view)) : views;
      if (!selected.length || selected.some(view => !recallViews.includes(view))) throw new Error('Every recall plan needs valid views.');
      return selected;
    });
    // Plans with the same question can share an embedding and hydration while
    // keeping separate weights/provenance and an independent budget per view.
    const groups = new Map<string, number[]>();
    request.plans.forEach((plan, index) => groups.set(plan.query, [...(groups.get(plan.query) ?? []), index]));
    const batchedByQuery = new Map<string, Partial<Record<RecallView, SearchDocumentRecord[]>>>();
    if (searchByViews) await Promise.all([...groups].map(async ([query, indices]) => {
      const groupViews = [...new Set(indices.flatMap(index => plannedViews[index]!))];
      batchedByQuery.set(query, await searchByViews.call(this.store, request.scope, query,
        Object.fromEntries(groupViews.map(view => [view, limits.get(view)!])), groupViews, request.signal));
    }));
    const perPlan = await Promise.all(request.plans.map(async (plan, index) => {
      const planViews = plannedViews[index]!;
      if (searchByViews) {
        const batched = batchedByQuery.get(plan.query)!;
        return planViews.map((view) => ({ plan, view, documents: batched[view] ?? [] }));
      }
      return Promise.all(planViews.map(async (view) => ({ plan, view,
        documents: await search!.call(this.store, request.scope, plan.query, limits.get(view)!, view, request.signal) })));
    }));
    const channelSets = perPlan.flat();

    const documents: SearchDocumentRecord[] = [];
    const fusedRanks = new Map<string, number>();
    const provenance = new Map<string, RecallProvenance[]>();
    const channels: RecallChannel[] = [];
    for (const channel of channelSets) {
      channels.push({ planLabel: channel.plan.label, view: channel.view, documents: channel.documents.length });
      channel.documents.forEach((document, rank) => {
        if (document.repositoryId !== request.scope.repositoryId || document.analysisRevision !== request.scope.analysisRevision) {
          throw new Error('Search returned a document from another revision.');
        }
        fusedRanks.set(document.searchDocumentId, (fusedRanks.get(document.searchDocumentId) ?? 0) + channel.plan.weight / (reciprocalRankOffset + rank));
        const entries = provenance.get(document.searchDocumentId) ?? [];
        entries.push({ planLabel: channel.plan.label, view: channel.view, rank, weight: channel.plan.weight });
        provenance.set(document.searchDocumentId, entries);
      });
      documents.push(...channel.documents);
    }
    return { documents, fusedRanks, provenance, channels };
  }

  /** Highest fused score in an outcome, used to normalise a recall term to (0, 1]. */
  static normalise(outcome: RecallOutcome, documentId: string): number {
    const best = Math.max(...outcome.fusedRanks.values(), 0);
    if (best <= 0) return 0;
    return (outcome.fusedRanks.get(documentId) ?? 0) / best;
  }
}
