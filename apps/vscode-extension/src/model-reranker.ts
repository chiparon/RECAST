import type { ModuleReranker } from '@forexplore/code-intelligence-service';
import { localFetch } from './local-fetch';
import type { ImplementationReferenceSelection } from '@forexplore/adaptation-service/project-pipeline';

/** The transport obtains fresh SecretStorage credentials on every call. */
export class ConfiguredModelReranker implements ModuleReranker {
  readonly model = 'configured-model';
  private readonly identity: () => string;
  constructor(private readonly endpoint: () => string, private readonly ensureStarted: () => Promise<unknown>,
    private readonly transport: typeof localFetch = localFetch, identity: () => string = () => endpoint(),
    private readonly selectionOptions?: { onSelection: (selection: ImplementationReferenceSelection) => void }) {
    this.identity = identity;
  }

  cacheKey(): string { return this.identity() + (this.selectionOptions ? ':implementation-references-v2' : ''); }

  /** Compatibility adapter for callers that still provide structured module candidates. */
  async rerank(requirement: string, candidates: readonly RerankCandidate[], signal?: AbortSignal): Promise<RerankCandidate[]> {
    return this.requestRanking(requirement, candidates, signal);
  }

  private async requestRanking(requirement: string, candidates: readonly RerankCandidate[], signal?: AbortSignal,
    selectionOptions?: { onSelection: (selection: ImplementationReferenceSelection) => void }): Promise<RerankCandidate[]> {
    if (candidates.length < 2 && !selectionOptions) return [...candidates];
    signal?.throwIfAborted();
    await this.ensureStarted();
    const url = new URL(this.endpoint());
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/retrieval-rerank`;
    url.search = ''; url.hash = '';
    const response = await this.transport(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requirement: requirement.slice(0, 8000), candidates, ...(selectionOptions ? { selectReferences: true } : {}) }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new Error(`模型重排后端返回 HTTP ${response.status}`);
    const payload = await response.json() as { order?: unknown; selection?: ImplementationReferenceSelection };
    const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
    if (!Array.isArray(payload.order) || payload.order.length !== candidates.length || new Set(payload.order).size !== candidates.length ||
        payload.order.some(id => typeof id !== 'string' || !byId.has(id))) throw new Error('模型重排返回了无效候选顺序');
    const order: string[] = payload.order;
    if (selectionOptions) {
      const selection = payload.selection;
      if (!selection || !Array.isArray(selection.selected) || selection.selected.length < 1 || selection.selected.length > 3 ||
          new Set(selection.selected.map(choice => choice.id)).size !== selection.selected.length ||
          selection.selected.some((choice, i) => order[i] !== choice.id ||
            [choice.reason, choice.evidence, choice.incrementalValue].some(value => typeof value !== 'string' || !value.trim()))) {
        throw new Error('Automatic reference selection is missing or inconsistent with ranking');
      }
      selectionOptions.onSelection(structuredClone(selection));
    }
    return order.map(id => byId.get(id)!);
  }

  async rank(query: string, documents: readonly string[], signal: AbortSignal): Promise<Array<{ index: number; score: number }>> {
    const candidates = documents.map((text, index) => ({ id: `c${index}`, name: text.split('\n')[0]!.slice(0, 2048),
      granularity: 'module', relativePath: '', preview: text.slice(0, 8000) }));
    const ordered = await this.requestRanking(query, candidates, signal, this.selectionOptions);
    return ordered.map((candidate, rank) => ({
      index: Number(candidate.id.slice(1)),
      score: 1 - rank / documents.length,
    }));
  }
}

export interface RerankCandidate {
  readonly id: string;
  readonly name: string;
  readonly granularity: string;
  readonly relativePath: string;
  readonly signature?: string;
  readonly preview?: string;
}
