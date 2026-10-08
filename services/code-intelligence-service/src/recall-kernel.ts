import type { RepositoryRevisionScope, SearchDocumentRecord } from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';

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
  constructor(private readonly store: Pick<IndexStore, 'searchSearchDocuments' | 'searchSearchDocumentsByViews'>) {}

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
    const perPlan = await Promise.all(request.plans.map(async (plan) => {
      if (searchByViews) {
        const batched = await searchByViews.call(this.store, request.scope, plan.query,
          Object.fromEntries([...limits]), views, request.signal);
        return views.map((view) => ({ plan, view, documents: batched[view] ?? [] }));
      }
      return Promise.all(views.map(async (view) => ({ plan, view,
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
