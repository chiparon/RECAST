import type { WorkspaceEvidenceScope } from "@forexplore/contracts";
import { MAX_RETRIEVAL_SCOPES } from '@forexplore/contracts';
import type {
  WorkspaceEvidenceExcerpt,
  WorkspaceEvidencePort,
  WorkspaceEvidenceQueryRequest,
  WorkspaceEvidenceResult,
} from "./workspace-evidence-port";

export interface HttpWorkspaceEvidencePortOptions {
  /** Host-owned read-only semantic query endpoint, without a required trailing slash. */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  /** Optional bearer credential issued by the local VS Code host. */
  bearerToken?: string;
  /** Content budget for one query; the host enforces its own ceiling as well. */
  maxTokensPerQuery?: number;
  timeoutMs?: number;
}

interface ErrorPayload {
  error?: { message?: unknown };
}

/**
 * Uses the host's revision-scoped semantic query routes. The migration Agent
 * asks for a bounded requirement and receives source excerpts from the
 * explicitly published history revisions.
 */
export class HttpWorkspaceEvidencePort implements WorkspaceEvidencePort {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bearerToken?: string;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;

  constructor(options: HttpWorkspaceEvidencePortOptions) {
    const endpoint = options.endpoint.trim();
    if (!/^https?:\/\//i.test(endpoint)) throw new Error("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
    this.#endpoint = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bearerToken = options.bearerToken?.trim() || undefined;
    this.#maxTokens = options.maxTokensPerQuery ?? 6_000;
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    if (!Number.isInteger(this.#maxTokens) || this.#maxTokens < 256 || this.#maxTokens > 32_000) {
      throw new Error("Workspace evidence tokens per query must be 256..32000.");
    }
  }

  async query(request: WorkspaceEvidenceQueryRequest, signal?: AbortSignal): Promise<WorkspaceEvidenceResult> {
    if (request.scopes.length > MAX_RETRIEVAL_SCOPES) throw new Error(`At most ${MAX_RETRIEVAL_SCOPES} evidence scopes are supported; no repositories were dropped.`);
    const scopes = request.scopes;
    if (scopes.length === 0) return { evidence: [], characters: 0, notes: ["No history revision is in scope."] };
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#timeoutMs)]);
    const headers = { "content-type": "application/json", ...(this.#bearerToken ? { authorization: `Bearer ${this.#bearerToken}` } : {}) };
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await this.#fetch(new URL(path, this.#endpoint), { method: "POST", headers, body: JSON.stringify(body), signal: combined });
      if (!response.ok) {
        let detail: ErrorPayload | undefined;
        try { detail = await response.json() as ErrorPayload; } catch { /* a host error need not be JSON */ }
        throw new Error((typeof detail?.error?.message === "string" ? detail.error.message : `Semantic evidence query failed with status ${response.status}.`).slice(0, 512));
      }
      return await response.json() as T;
    };
    type SymbolHit = { repositoryId: string; analysisRevision: string; evidenceId: string; relativePath: string; sourceRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number }; value: { name?: string; relativePath: string; sourceRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } } };
    type SymbolResponse = { symbols?: SymbolHit[] };
    type ExcerptResponse = { excerpt?: { repositoryId: string; analysisRevision: string; evidenceId: string; relativePath: string; value: { text: string; truncated: boolean } } | null };
    const evidence: WorkspaceEvidenceExcerpt[] = [];
    const notes: string[] = [];
    // searchSymbols is a structural symbol lookup and matches a contiguous
    // substring.  Passing the whole natural-language requirement (for example
    // "tenant retry idempotency audit") therefore returns nothing even when
    // each named symbol exists.  Search a small, deterministic set of concrete
    // identifier terms and deduplicate the returned evidence.
    const terms = evidenceQueryTerms(request.requirement);
    const seenSymbols = new Set<string>();
    let searchCalls = 0;
    const maxSearchCalls = Math.min(32, Math.max(8, scopes.length * 2));
    let searchBudgetTruncated = false;
    for (const scope of scopes) {
      for (const term of terms) {
        if (evidence.length >= request.limit) break;
        if (searchCalls >= maxSearchCalls) {
          searchBudgetTruncated = true;
          break;
        }
        searchCalls += 1;
        const result = await post<SymbolResponse>("v1/semantic-query/searchSymbols", {
          ...scope,
          query: term,
          ...(scope.projectId ? { projectIds: [scope.projectId] } : {}),
          limit: Math.min(Math.max(request.limit * 2, 4), 20),
        });
        for (const hit of result.symbols ?? []) {
          if (evidence.length >= request.limit) break;
          const range = hit.value?.sourceRange;
          if (!range) continue;
          const symbolId = `${scope.repositoryId}:${scope.analysisRevision}:${hit.evidenceId}`;
          if (seenSymbols.has(symbolId)) continue;
          seenSymbols.add(symbolId);
          try {
            const excerpt = await post<ExcerptResponse>("v1/semantic-query/readSourceExcerpt", {
              repositoryId: scope.repositoryId,
              analysisRevision: scope.analysisRevision,
              relativePath: hit.value.relativePath,
              sourceRange: range,
              maxChars: Math.min(8_000, this.#maxTokens * 4),
            });
            const value = excerpt.excerpt;
            if (!value) continue;
            evidence.push({ id: symbolId, repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, relativePath: hit.value.relativePath, content: value.value.text, truncated: value.value.truncated });
          } catch {
            // A stale symbol hit should not discard valid hits from the same
            // revision. The revision is immutable, but its provider may still
            // omit an excerpt for an unparsable range.
            notes.push("SOURCE_EXCERPT_UNAVAILABLE");
          }
        }
      }
      if (searchBudgetTruncated) break;
      if (evidence.length >= request.limit) break;
    }
    if (searchBudgetTruncated) notes.push("EVIDENCE_SEARCH_BUDGET_TRUNCATED");
    if (evidence.some((item) => item.truncated)) notes.push("SOURCE_EXCERPT_TRUNCATED");
    if (!evidence.length) notes.push(`NO_MATCHING_HISTORY_SYMBOLS:${terms.slice(0, 6).join(",")}`);
    return {
      evidence,
      characters: evidence.reduce((sum, item) => sum + item.content.length, 0),
      ...(notes.length ? { notes: [...new Set(notes)] } : {}),
    };
  }
}

const evidenceStopWords = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "is", "of", "on", "or", "the", "to", "with",
  "this", "that", "these", "those", "target", "module", "implementation", "implement", "source", "history", "types", "type",
]);

function evidenceQueryTerms(value: string): string[] {
  const identifiers = value.split(/[^A-Za-z0-9_]+/).map((item) => item.trim()).filter(Boolean);
  const raw = identifiers.flatMap((identifier) => [
    identifier,
    ...identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/),
  ]).filter((item) => item.length >= 3 && !evidenceStopWords.has(item.toLowerCase()));
  const unique = [...new Set(raw)];
  // Prefer concrete longer identifiers, then preserve the model's order for
  // equally specific terms. At most eight searches are made per revision.
  return unique.sort((left, right) => right.length - left.length).slice(0, 8);
}
