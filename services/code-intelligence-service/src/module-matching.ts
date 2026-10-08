import { createHash } from 'node:crypto';
import { indexModuleHierarchy } from '@forexplore/contracts';
import type { ModuleTarget, ProjectAnalysisRecord, ProjectModule, RepositoryRevisionScope, SearchCandidate } from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import { projectPlanHash } from './project-analysis.js';
import type { ModuleReranker } from './module-reranker.js';
import { RecallKernel } from './recall-kernel.js';
import { moduleSearchBudgetMs } from './seekdb-timeouts.js';

export interface ModuleMatchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  repositoryIds: readonly string[];
}

export interface ModuleSearchTiming {
  queueMs: number;
  recallAndAggregateMs: number;
  candidatePrepareMs: number;
  rerankMs: number;
  revisionCheckMs: number;
  executionMs: number;
  totalMs: number;
  rerankCandidateCount: number;
  rerankFallback?: boolean;
  rerankError?: string;
  outcome: 'success' | 'error';
  failedStage?: ModuleSearchStage;
}

type ModuleSearchStage = 'queueMs' | 'recallAndAggregateMs' | 'candidatePrepareMs' | 'rerankMs' | 'revisionCheckMs';

/** The retrieval signals the shared kernel preserves for a recalled document. */
interface ScoredDocument {
  searchDocumentId: string;
  retrievalScore?: { semantic?: number; lexical?: number; fusion?: number };
}

interface ModuleHit extends RepositoryRevisionScope {
  repositoryName: string;
  projectId: string;
  projectPath: string;
  module: ProjectModule;
  score: number;
  semanticScore: number;
  semanticOrderScore: number;
}

function compareHits(a: ModuleHit, b: ModuleHit): number {
  return b.score - a.score || JSON.stringify([a.repositoryId, a.projectId, a.module.id])
    .localeCompare(JSON.stringify([b.repositoryId, b.projectId, b.module.id]));
}

/** Give the model both hybrid and semantic candidates, without duplicate manifests. */
function shortlistHits(hits: ModuleHit[], budget: number): ModuleHit[] {
  const hybrid = [...hits].sort(compareHits);
  const semantic = [...hits].sort((a, b) => b.semanticOrderScore - a.semanticOrderScore || compareHits(a, b));
  const selected: ModuleHit[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < hits.length && selected.length < budget; index++) {
    for (const hit of [hybrid[index], semantic[index]]) {
      if (!hit || selected.length >= budget) continue;
      const manifest = JSON.stringify([hit.repositoryId, hit.analysisRevision, hit.projectId, [...hit.module.sourceFiles].sort()]);
      if (seen.has(manifest)) continue;
      seen.add(manifest);
      selected.push(hit);
    }
  }
  return selected.sort(compareHits);
}

function hybridRelevance(document: ScoredDocument, fallback: number): number {
  const fusion = document.retrievalScore?.fusion;
  // SeekDB uses two-channel RRF with offset 61; its theoretical maximum is 2/61.
  // Other stores may expose raw lexical counts as fusion, so retain the kernel's
  // normalised ranking when the value is outside that RRF range.
  return fusion !== undefined && Number.isFinite(fusion) && fusion >= 0 && fusion <= 2 / 61
    ? fusion * 61 / 2 : fallback;
}

function normalizedApi(api: string): string {
  return api.replace(/\(.*$/s, '').split(/[\s.:]+/).at(-1)?.replaceAll('_', '').toLowerCase() ?? '';
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

/**
 * A process-wide admission gate for module searches.  A single search fans out
 * to four repositories and each repository issues a text and vector query; a
 * second caller must wait instead of making the eight-connection pool queue
 * dozens of statements behind a slow full-text scan.
 */
export class ModuleSearchConcurrencyGate {
  #active = 0;
  readonly #waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(readonly limit = 1) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Module search concurrency must be an integer in 1..32.');
  }

  get active(): number { return this.#active; }
  get queued(): number { return this.#waiters.length; }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#active < this.limit) {
      this.#active += 1;
      return this.release;
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve: () => { this.#active += 1; resolve(this.release); },
        reject,
        signal,
        onAbort: undefined as (() => void) | undefined,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  private readonly release = (): void => {
    if (this.#active < 1) throw new Error('Module search concurrency gate released too many times.');
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (!next) return;
    if (next.signal?.aborted) {
      next.onAbort?.();
      this.release();
      return;
    }
    if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
    next.resolve();
  };
}

function configuredModuleSearchConcurrency(): number {
  // One admitted request fans out to four repositories and each repository runs
  // text and vector SQL together (up to eight pool sessions).  A second request
  // would exceed the default eight-connection pool, so the safe default is one;
  // deployments with a larger database budget can opt into 2..32 explicitly.
  const value = Number(process.env.CODE_INTELLIGENCE_MODULE_SEARCH_CONCURRENCY ?? 1);
  return Number.isInteger(value) && value >= 1 && value <= 32 ? value : 1;
}

const moduleSearchGate = new ModuleSearchConcurrencyGate(configuredModuleSearchConcurrency());

/** Module metadata is fetched only for recalled IDs; no full structural index is hydrated. */
export async function searchModules(store: IndexStore, request: ModuleMatchRequest, parentSignal?: AbortSignal, reranker?: ModuleReranker,
  recall = new RecallKernel(store), observeTiming?: (timing: Readonly<ModuleSearchTiming>) => void): Promise<SearchCandidate[]> {
  const started = performance.now();
  const timing: ModuleSearchTiming = { queueMs: 0, recallAndAggregateMs: 0, candidatePrepareMs: 0, rerankMs: 0,
    revisionCheckMs: 0, executionMs: 0, totalMs: 0, rerankCandidateCount: 0, outcome: 'error' };
  let stage: ModuleSearchStage = 'queueMs';
  let stageStarted = started;
  const beginStage = (next: ModuleSearchStage): void => {
    const now = performance.now();
    timing[stage] += now - stageStarted;
    stage = next;
    stageStarted = now;
  };
  // The queue wait is outside the per-search 60s database budget. Once admitted,
  // one request still receives the same bounded search time as before.
  let release: (() => void) | undefined;
  const controller = new AbortController();
  let databaseSlotReleased = false;
  const releaseDatabaseSlot = (): void => {
    if (databaseSlotReleased) return;
    databaseSlotReleased = true;
    release?.();
    release = undefined;
  };
  try {
    release = await moduleSearchGate.acquire(parentSignal);
    beginStage('recallAndAggregateMs');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(moduleSearchBudgetMs), ...(parentSignal ? [parentSignal] : [])]);
    const result = await searchModuleSnapshot(store, request, signal, reranker, recall, beginStage, timing, releaseDatabaseSlot);
    timing.outcome = 'success';
    return result;
  } catch (error) {
    timing.failedStage = stage;
    throw error;
  } finally {
    const finished = performance.now();
    timing[stage] += finished - stageStarted;
    timing.totalMs = finished - started;
    timing.executionMs = timing.totalMs - timing.queueMs;
    controller.abort(new Error('Module search finished'));
    releaseDatabaseSlot();
    if (process.env.RECAST_SEARCH_PROFILE === '1') console.log(
      `      [profile] module=${request.target.id} timing=${JSON.stringify(timing)}`);
    // Diagnostics must never change the result or mask a search failure.
    try { observeTiming?.(Object.freeze(timing)); } catch { /* observer failure */ }
  }
}

async function searchModuleSnapshot(store: IndexStore, request: ModuleMatchRequest, signal: AbortSignal, reranker: ModuleReranker | undefined,
  recall: RecallKernel, beginStage: (stage: ModuleSearchStage) => void, timing: ModuleSearchTiming,
  releaseDatabaseSlot: () => void): Promise<SearchCandidate[]> {
  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 10) throw new Error('Module search topK must be between 1 and 10.');
  const repositoryIds = [...new Set(request.repositoryIds)];
  if (repositoryIds.length === 0 || repositoryIds.length > 32) throw new Error('Module search requires between 1 and 32 historical repositories.');
  if (!store.searchSearchDocuments || !store.getModuleArtifacts || !store.getProject || !store.getSourcePreview) throw new Error('Module search requires bounded index-store queries.');
  const query = [request.target.name, request.target.signature, request.target.documentation, request.requirement, ...(request.target.module?.coreApis ?? [])].filter(Boolean).join('\n');
  if (!query.trim() || query.length > 32_000) throw new Error('Module query must contain between 1 and 32000 characters.');
  const requiredApis = [...new Set(request.target.module?.coreApis ?? [])];
  const profile = process.env.RECAST_SEARCH_PROFILE === '1';
  const profileStart = profile ? Date.now() : 0;
  const allHits = (await mapBounded(repositoryIds, 4, async (repositoryId) => {
    signal.throwIfAborted();
    const repository = await store.getRepository(repositoryId, signal);
    if (!repository?.activeRevision || repository.role !== 'history') return [];
    const scope = { repositoryId, analysisRevision: repository.activeRevision };
    const revision = await store.getRevision(scope, signal);
    if (revision?.status !== 'ready') return [];
    // Shared kernel: the code identity is one plan, recall runs over every view.
    // A module can now be reached through a matching implementation fragment, not
    // only through a matching summary.
    const recallStart = profile ? Date.now() : 0;
    const outcome = await recall.recall({
      scope,
      plans: [{ label: 'code-identity', query, weight: 1 }],
      limitPerView: Math.min(120, Math.max(24, request.topK * 12)),
      signal,
    });
    // Older projections indexed whitespace gaps between declarations. They
    // contain no implementation evidence, even when their paths match the query.
    const documents = outcome.documents.filter((document) => document.kind !== 'source-fragment' || document.text.trim());
    const recallMs = profile ? Date.now() - recallStart : 0;
    if (profile) console.log(`      [profile]   ${repository.displayName}: recall=${recallMs}ms docs=${documents.length} 视图=${[...new Set(documents.map((d) => d.kind))].join('|') || '无'}`);
    // Summary documents carry their own module artifact. Implementation and
    // declaration hits do not, so their ownership is resolved against the module
    // artifacts recalled for this query - never by hydrating the whole revision.
    const recalledIds = [...new Set(documents.flatMap((doc) => doc.moduleArtifactId ? [doc.moduleArtifactId] : []))];
    const needsOwnership = documents.some((doc) => !doc.moduleArtifactId || !doc.moduleArtifactId.trim());
    const artifacts = await store.getModuleArtifacts!(scope, recalledIds, signal);
    const records = new Map(artifacts.flatMap((artifact) => {
      const record = artifact.payload as ProjectAnalysisRecord | undefined;
      if (artifact.kind !== 'module-summary' || artifact.status !== 'current' || artifact.analysisHash !== revision.analysisHash ||
        artifact.repositoryId !== repositoryId || artifact.analysisRevision !== scope.analysisRevision ||
        !artifact.planHash || !record?.proposal || record.state !== 'ready' ||
        record.repositoryId !== repositoryId || record.analysisRevision !== scope.analysisRevision ||
        record.proposal.analysisHash !== revision.analysisHash || artifact.planHash !== projectPlanHash(record.proposal)) return [];
      return [[artifact.moduleArtifactId, { ...record, planHash: artifact.planHash }] as const];
    }));
    const projects = new Map((await mapBounded([...new Set([...records.values()].map((r) => r.projectId))], 4,
      (id) => store.getProject!(scope, id, signal))).flatMap((project) => project ? [[project.projectId, project] as const] : []));
    const trees = new Map([...records].map(([id, record]) => [id, indexModuleHierarchy(record.proposal!.modules)]));
    // File ownership declared by the reviewed module artifacts; this is what
    // attributes a declaration or implementation hit to its module.
    const ownersByPath = new Map<string, Array<{ artifactId: string; moduleId: string }>>();
    if (needsOwnership) {
      for (const [artifactId, record] of records) {
        const tree = trees.get(artifactId)!;
        for (const node of record.proposal!.modules) {
          for (const file of tree.sourceFiles(node.id).files) {
            const list = ownersByPath.get(file);
            const entry = { artifactId, moduleId: node.id };
            if (list) list.push(entry); else ownersByPath.set(file, [entry]);
          }
        }
      }
    }
    const byModule = new Map<string, ModuleHit>();
    const scoreModule = (document: ScoredDocument, artifactId: string, moduleId: string, record: ProjectAnalysisRecord): void => {
      const tree = trees.get(artifactId)!;
      const node = tree.byId.get(moduleId);
      const project = projects.get(record.projectId);
      if (!node || !project) return;
      const module = { ...node, sourceFiles: tree.sourceFiles(node.id).files };
      if (module.sourceFiles.length === 0) return;
      const available = new Set((module.coreApis ?? []).map(normalizedApi).filter(Boolean));
      const apiScore = requiredApis.length ? requiredApis.filter((api) => available.has(normalizedApi(api))).length / requiredApis.length : 0;
      const semantic = document.retrievalScore?.semantic;
      const lexical = document.retrievalScore?.lexical ?? 0;
      const fused = RecallKernel.normalise(outcome, document.searchDocumentId);
      const relevance = semantic !== undefined && Number.isFinite(semantic) ? Math.max(0, Math.min(1, semantic))
        : lexical > 0 ? lexical / (lexical + 10) : fused;
      const semanticOrderScore = 0.8 * relevance + 0.2 * apiScore;
      const score = 0.8 * hybridRelevance(document, fused) + 0.2 * apiScore;
      const key = JSON.stringify([record.projectId, module.id]);
      const previous = byModule.get(key);
      if ((previous?.score ?? -1) < score) byModule.set(key, {
        ...scope, repositoryName: repository.displayName, projectId: project.projectId,
        projectPath: project.relativePath, module, score, semanticScore: relevance,
        semanticOrderScore: Math.max(previous?.semanticOrderScore ?? 0, semanticOrderScore),
      });
      else if (previous) previous.semanticOrderScore = Math.max(previous.semanticOrderScore, semanticOrderScore);
    };
    const seenDeclarations = new Set<string>();
    documents.forEach((document) => {
      if (document.repositoryId !== repositoryId || document.analysisRevision !== scope.analysisRevision) return;
      if (document.moduleArtifactId) {
        const record = records.get(document.moduleArtifactId);
        if (!record) return;
        let identity: { projectId?: string; moduleId?: string; planHash?: string };
        try { identity = JSON.parse(document.text); } catch { return; }
        if (!identity || identity.projectId !== record.projectId) return;
        if (identity.planHash !== undefined && identity.planHash !== record.planHash || record.proposal!.hierarchy && identity.planHash !== record.planHash) return;
        if (!identity.moduleId) return;
        scoreModule(document, document.moduleArtifactId, identity.moduleId, record);
        return;
      }
      // A declaration or implementation fragment identifies its module through
      // declared file ownership; unresolved hits are dropped rather than guessed.
      const owners = document.relativePath ? ownersByPath.get(document.relativePath) ?? [] : [];
      if (owners.length === 0) return;
      const marker = `${document.searchDocumentId}\u0000${owners[0]!.moduleId}`;
      if (seenDeclarations.has(marker)) return;
      seenDeclarations.add(marker);
      for (const owner of owners) {
        const record = records.get(owner.artifactId);
        if (!record) continue;
        scoreModule(document, owner.artifactId, owner.moduleId, record);
      }
    });
    return [...byModule.values()];
  })).flat();
  if (profile) console.log(`      [profile] 召回+聚合(含4并发/仓库)=${Date.now() - profileStart}ms 仓库数=${repositoryIds.length}`);

  beginStage('candidatePrepareMs');
  // Older module projections can contain a documentation-only or otherwise
  // language-less node with a non-empty file list. Such a hit is not a usable
  // implementation candidate; skip it instead of aborting the whole search.
  const usableHits = allHits.filter((hit) => {
    try {
      moduleLanguage(hit.module.language, hit.module.sourceFiles);
      return true;
    } catch {
      return false;
    }
  });
  // Top4 receives up to 16 distinct candidates (bounded by the model's 20-item
  // contract). Keeping both orders protects useful semantic matches while
  // allowing lexical/vector agreement to bring missed implementations back.
  const hits = reranker ? shortlistHits(usableHits, Math.min(20, Math.max(12, request.topK * 4)))
    : usableHits.sort(compareHits).slice(0, request.topK);
  const result = await mapBounded(hits, 4, async (hit): Promise<SearchCandidate> => {
    signal.throwIfAborted();
    const files = [...new Set(hit.module.sourceFiles)];
    const previewFiles = files.slice(0, 3);
    const parts = await mapBounded(previewFiles, 3, async (file) => {
      signal.throwIfAborted();
      const source = await store.getSourcePreview!(hit, file, 4_000, signal);
      if (source === null) throw new Error(`Module source is missing from its revision: ${file}`);
      return { text: `// ${file}\n${source.text}`, truncated: source.truncated };
    });
    const available = new Set((hit.module.coreApis ?? []).map(normalizedApi).filter(Boolean));
    const matchedApis = requiredApis.filter((api) => available.has(normalizedApi(api)));
    return {
      id: `module-${createHash('sha256').update(JSON.stringify([hit.repositoryId, hit.analysisRevision, hit.projectId, hit.module.id])).digest('hex')}`,
      title: hit.module.name, repository: hit.repositoryName, license: 'Unknown', kind: 'module',
      language: moduleLanguage(hit.module.language, files), path: files[0]!,
      signature: (hit.module.coreApis ?? []).join('\n'), summary: hit.module.description,
      score: { overall: hit.score, semantic: hit.semanticScore, symbol: 0, contract: requiredApis.length ? matchedApis.length / requiredApis.length : 0 },
      preview: parts.map((part) => part.text).join('\n\n'), dependencies: [...hit.module.dependsOn],
      compatibility: [], risks: ['模块行为与许可证尚需验证；接口名称匹配不代表功能等价。'],
      sourceModule: { repositoryId: hit.repositoryId, analysisRevision: hit.analysisRevision, projectId: hit.projectId,
        moduleId: hit.module.id, name: hit.module.name, projectPath: hit.projectPath, purpose: hit.module.purpose,
        sourceFiles: files, coreApis: hit.module.coreApis ?? [], dependsOn: [...hit.module.dependsOn], evidenceIds: [...hit.module.evidenceIds] },
      moduleMatch: { requiredApis, matchedApis, missingApis: requiredApis.filter((api) => !matchedApis.includes(api)),
        verification: 'interface-only', previewFiles, previewTruncated: files.length > previewFiles.length || parts.some((part) => part.truncated) },
    };
  });
  // Source previews and candidate metadata are complete at this point. Release
  // the database admission slot while the remote model ranks the bounded list;
  // the next request can start its own recall without competing with this HTTP
  // call. The revision check below is deliberately also outside the slot: it is
  // a small consistency read, whereas recall is the pool-heavy part.
  releaseDatabaseSlot();
  let ranked = result;
  if (reranker && result.length > 0) {
    beginStage('rerankMs');
    timing.rerankCandidateCount = result.length;
    try {
      const ordering = await reranker.rank(query, result.map((candidate) => [candidate.title, candidate.summary,
        candidate.signature, candidate.dependencies.join('\n'), candidate.preview].join('\n')), signal);
      if (!Array.isArray(ordering) || ordering.length !== result.length ||
          ordering.some((item) => !item || !Number.isInteger(item.index) || item.index < 0 || item.index >= result.length ||
            !Number.isFinite(item.score) || item.score < 0 || item.score > 1) ||
          new Set(ordering.map((item) => item.index)).size !== result.length) throw new Error('Reranker returned an invalid candidate ordering.');
      ranked = ordering.map(({ index, score }) => ({ ...result[index]!, score: { ...result[index]!.score, overall: score },
        moduleMatch: { ...result[index]!.moduleMatch!, reranker: { model: reranker.model, score } } }));
    } catch (error) {
      // A malformed/partial model list must not erase a valid database recall.
      // Cancellation remains fatal; all other reranker failures fall back to the
      // deterministic hybrid order and are exposed in timing diagnostics.
      signal.throwIfAborted();
      timing.rerankFallback = true;
      timing.rerankError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
      ranked = result;
    }
  }
  beginStage('revisionCheckMs');
  for (const hit of hits) {
    signal.throwIfAborted();
    if ((await store.getRepository(hit.repositoryId, signal))?.activeRevision !== hit.analysisRevision) throw new Error('Repository revision changed during module search; retry against the current snapshot.');
  }
  return ranked.slice(0, request.topK);
}

function moduleLanguage(language: string | undefined, files: string[]): ModuleTarget['language'] {
  const names: Record<string, ModuleTarget['language']> = { typescript: 'TypeScript', javascript: 'TypeScript', python: 'Python', java: 'Java', 'c#': 'C#', csharp: 'C#', rust: 'Rust', go: 'Go' };
  if (language && names[language.toLowerCase()]) return names[language.toLowerCase()]!;
  const extensions: Record<string, ModuleTarget['language']> = { ts: 'TypeScript', js: 'TypeScript', py: 'Python', java: 'Java', cs: 'C#', rs: 'Rust', go: 'Go' };
  const found = files.map((file) => extensions[file.split('.').at(-1)?.toLowerCase() ?? '']).find(Boolean);
  if (!found) throw new Error(`Module source language is unsupported: ${language ?? 'unknown'}`);
  return found;
}

export const moduleMatchingInternals = { normalizedApi, mapBounded, configuredModuleSearchConcurrency, moduleSearchGate };
