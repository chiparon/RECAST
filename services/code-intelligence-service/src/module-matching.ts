import { createHash } from 'node:crypto';
import { indexModuleHierarchy } from '@forexplore/contracts';
import type { ModuleTarget, ProjectAnalysisRecord, ProjectModule, RepositoryRevisionScope, SearchCandidate, SearchDocumentRecord, SymbolRecord } from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import { projectPlanHash } from './project-analysis.js';
import type { ModuleReranker } from './module-reranker.js';
import { RecallKernel, reciprocalRankOffset } from './recall-kernel.js';
import { buildModuleSearchQuery, resolveModuleRetrievalTarget } from './module-search-query.js';
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

export interface ModuleRecallObservation {
  repositoryId: string;
  analysisRevision: string;
  projectId: string;
  moduleId: string;
  channels: string[];
  score: number;
  channelRanks?: Record<string, number>;
  channelScores?: Record<string, number>;
}

type ModuleSearchStage = 'queueMs' | 'recallAndAggregateMs' | 'candidatePrepareMs' | 'rerankMs' | 'revisionCheckMs';

interface ModuleHit extends RepositoryRevisionScope {
  repositoryName: string;
  projectId: string;
  projectPath: string;
  module: ProjectModule;
  score: number;
  semanticScore: number;
  semanticOrderScore: number;
  channelScores?: Map<string, number>;
  channelRanks?: Map<string, number>;
  fileEvidence?: Map<string, { score: number; fragment?: string; fragmentScore: number }>;
}

function compareHits(a: ModuleHit, b: ModuleHit): number {
  return b.score - a.score || Number(a.module.nodeKind === 'subsystem') - Number(b.module.nodeKind === 'subsystem') ||
    JSON.stringify([a.repositoryId, a.projectId, a.module.id])
    .localeCompare(JSON.stringify([b.repositoryId, b.projectId, b.module.id]));
}

/** Give the model both ranking signals, preserving distinct module identities. */
function shortlistHits(hits: ModuleHit[], budget: number): ModuleHit[] {
  const hybrid = [...hits].sort(compareHits);
  const semantic = [...hits].sort((a, b) => b.semanticOrderScore - a.semanticOrderScore || compareHits(a, b));
  const selected: ModuleHit[] = [];
  const seen = new Set<string>();
  const perRepository = new Map<string, number>();
  const configuredRepositoryLimit = Number(process.env.CODE_INTELLIGENCE_MODULE_SHORTLIST_REPOSITORY_LIMIT ?? '0');
  const repositoryLimit = configuredRepositoryLimit > 0 && Number.isInteger(configuredRepositoryLimit)
    ? Math.min(configuredRepositoryLimit, budget)
    : new Set(hits.map(hit => hit.repositoryId)).size > 1 ? Math.max(4, Math.ceil(budget / 3)) : budget;
  const append = (hit: ModuleHit | undefined, diversify: boolean): void => {
    if (!hit || selected.length >= budget || diversify && (perRepository.get(hit.repositoryId) ?? 0) >= repositoryLimit) return;
    const identity = JSON.stringify([hit.repositoryId, hit.analysisRevision, hit.projectId, hit.module.id]);
    if (seen.has(identity)) return;
    seen.add(identity);
    selected.push(hit);
    perRepository.set(hit.repositoryId, (perRepository.get(hit.repositoryId) ?? 0) + 1);
  };
  // Cosine scales and rank-fusion heads differ across repositories. Preserve
  // each repository's best hybrid and semantic evidence before the global cut,
  // so a large corpus cannot hide a smaller corpus from the model entirely.
  const bestHybrid = new Map<string, ModuleHit>();
  const bestSemantic = new Map<string, ModuleHit>();
  for (const hit of hybrid) if (!bestHybrid.has(hit.repositoryId)) bestHybrid.set(hit.repositoryId, hit);
  for (const hit of semantic) if (!bestSemantic.has(hit.repositoryId)) bestSemantic.set(hit.repositoryId, hit);
  for (const hit of [...bestHybrid.values()].sort(compareHits)) {
    append(hit, true);
    append(bestSemantic.get(hit.repositoryId), true);
  }
  for (let index = 0; index < hits.length && selected.length < budget; index++) {
    append(hybrid[index], true);
    append(semantic[index], true);
  }
  // Fill unused slots when only a few repositories contain relevant modules.
  for (const hit of hybrid) append(hit, false);
  return selected.sort(compareHits);
}

function normalizedApi(api: string): string {
  return api.replace(/\(.*$/s, '').split(/[\s.:]+/).at(-1)?.replaceAll('_', '').toLowerCase() ?? '';
}

function isSourceFile(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|java|cs|py|go|rs)$/i.test(file) && !/(?:^|\/)(?:package-info|module-info)\.java$/i.test(file);
}

function apiTerms(apis: readonly string[]): string[] {
  return [...new Set(apis.filter(api => !/\b(?:class|interface|enum|record|struct)\s+\w/.test(api)).flatMap(api =>
    api.replace(/\(.*$/s, '').trim().split(/\s+/).at(-1)!.split(/[.:#]+/).slice(-2))
    .filter(term => term.length > 2))];
}

/** Strip comments/imports from display evidence, leaving the stored source intact. */
function implementationExcerpt(text: string, apis: readonly string[], limit: number): string {
  const cleaned = text.replace(/^[\t ]*\/\*[\s\S]*?\*\/[\t ]*/gm, '')
    .replace(/^[\t ]*("""|''')[\s\S]*?\1[\t ]*$/gm, '')
    .split(/\r?\n/).filter(line => !/^\s*(?:\/\/|#(?!\[)|package\s|import\s|from\s+\S+\s+import\s)/.test(line) &&
      !/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[\w.]+\s*=\s*)?[\w.]+\s*;\s*$/.test(line))
    .join('\n').trim();
  const terms = apis.map(api => api.replace(/\(.*$/s, '').split(/[\s.:#]+/).at(-1)!).filter(term => term.length > 2);
  const positions = terms.map(term => cleaned.toLowerCase().indexOf(term.toLowerCase())).filter(index => index >= 0);
  const anchor = positions.length ? Math.min(...positions) : 0;
  return cleaned.slice(Math.max(0, anchor - 80), Math.max(0, anchor - 80) + limit).trim();
}

function evidenceTerms(text: string): Set<string> {
  return new Set(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);
}

/** Keep a strong match to one named responsibility in the model's shortlist,
 * even when a multi-purpose query has a slightly higher generic cosine head. */
function apiIdentityOverlap(required: readonly string[], module: ProjectModule): number {
  const common = new Set(['async', 'await', 'get', 'set', 'is', 'can', 'run', 'submit', 'create', 'update', 'delete', 'register',
    'search', 'query', 'find', 'check', 'add', 'remove', 'load', 'save', 'start', 'stop', 'close', 'init', 'execute',
    'service', 'coordinator', 'gateway', 'adapter', 'factory', 'policy', 'impl', 'model', 'manager', 'context', 'lifecycle',
    'processing', 'public', 'private', 'static', 'virtual', 'override', 'void']);
  const words = (name: string): Set<string> => new Set([...evidenceTerms(name.replace(/^I(?=[A-Z])/, ''))].filter(word => !common.has(word)));
  const identities = [...apiTerms((module.coreApis ?? []).slice(0, 64)), ...module.sourceFiles.slice(0, 12).map(file =>
    file.split('/').at(-1)!.replace(/\.[^.]+$/, ''))].map(words).filter(group => group.size);
  const targets = apiTerms(required).map(words).filter(group => group.size);
  return Math.max(0, ...targets.flatMap(target => identities.map(identity =>
    [...target].filter(word => identity.has(word)).length / target.size)));
}

/** Select a real callable body rather than a constant, constructor or file header. */
function representativeSymbol(symbols: readonly SymbolRecord[], hit: ModuleHit, fragment: string | undefined, target?: ModuleTarget): SymbolRecord | undefined {
  const apis = new Set((hit.module.coreApis ?? []).map(normalizedApi));
  const exactApis = new Set((hit.module.coreApis ?? []).map(api => api.replace(/\(.*$/s, '').split(/[\s.:#]+/).at(-1)?.toLowerCase()));
  const terms = evidenceTerms([hit.module.name, hit.module.purpose, hit.module.description, ...apis].filter(Boolean).join(' '));
  const targetTerms = evidenceTerms([target?.module?.description, target?.module?.purpose,
    ...(target?.module?.coreApis ?? [])].filter(Boolean).join(' '));
  for (const word of ['async', 'get', 'set', 'run', 'service', 'module', 'application', 'existing', 'implement', 'public', 'private']) targetTerms.delete(word);
  const score = (symbol: SymbolRecord): number => {
    const lines = symbol.sourceRange.endLine - symbol.sourceRange.startLine;
    const name = normalizedApi(symbol.name);
    const matches = [...evidenceTerms(symbol.name)].filter(term => terms.has(term)).length;
    const targetMatches = [...evidenceTerms(symbol.name)].filter(term => targetTerms.has(term)).length;
    const recalled = fragment && new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(fragment) ? 3 : 0;
    const utilityPenalty = /^(?:toString|hashCode|equals|clone)$/.test(symbol.name) ? 8
      : /^(?:get|set|is)[A-Z_]/.test(symbol.name) ? lines < 8 ? 8 : 2 : 0;
    return (exactApis.has(symbol.name.toLowerCase()) ? 6 : apis.has(name) ? 4 : 0) + matches + targetMatches * 2 + recalled + Math.min(lines, 30) / 30 -
      utilityPenalty;
  };
  return symbols.filter(symbol => ['method', 'function'].includes(symbol.kind) &&
    symbol.sourceRange.endLine > symbol.sourceRange.startLine && !/;\s*$/.test(symbol.signature ?? ''))
    .sort((a, b) => score(b) - score(a) || a.sourceRange.startLine - b.sourceRange.startLine)[0];
}

/** Prefer API-bearing production files and recalled implementations over file-list order. */
function representativeFiles(hit: ModuleHit, limit = 3): string[] {
  const files = [...new Set(hit.module.sourceFiles)];
  const sources = files.filter(isSourceFile);
  const production = sources.filter(file => !isTestFile(file));
  const candidates = production.length ? production : sources.length ? sources : files;
  const terms = apiTerms(hit.module.coreApis ?? []).map(term => term.toLowerCase());
  const score = (file: string): number => {
    const basename = file.split('/').at(-1)!.replace(/\.[^.]+$/, '').toLowerCase();
    const api = terms.filter(term => basename === term || basename === term.replace(/^i(?=[a-z])/, '')).length;
    return api * 2 + (hit.fileEvidence?.get(file)?.score ?? 0) * reciprocalRankOffset;
  };
  return candidates.sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, limit);
}

/** Keep all representative files visible within the backend's 2,000-character preview. */
function rerankDocument(candidate: SearchCandidate): string {
  const files = candidate.moduleMatch?.previewFiles ?? [candidate.path];
  const configuredChars = Number(process.env.CODE_INTELLIGENCE_MODULE_RERANK_DOCUMENT_CHARS ?? '2000');
  const maxChars = Number.isInteger(configuredChars) && configuredChars >= 800 && configuredChars <= 8_000 ? configuredChars : 2_000;
  const evidence = files.map((file, index) => {
    const marker = `// ${file}\n`;
    const start = candidate.preview.indexOf(marker);
    const next = files[index + 1] ? candidate.preview.indexOf(`// ${files[index + 1]}\n`, start + marker.length) : -1;
    const source = start >= 0 ? candidate.preview.slice(start + marker.length, next >= 0 ? next : undefined) : '';
    return `${file.length > 90 ? '…' + file.slice(-89) : file}\n${implementationExcerpt(source, [], 320)}`;
  });
  return [candidate.title.slice(0, 100),
    `Responsibilities: ${candidate.summary.slice(0, 400)}`,
    candidate.sourceModule?.purpose ? `Purpose: ${candidate.sourceModule.purpose.slice(0, 150)}` : '',
    `Core APIs: ${candidate.signature.slice(0, 180)}`,
    `Implementation evidence:\n${evidence.join('\n\n')}`].filter(Boolean).join('\n').slice(0, maxChars);
}

function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:[._-](?:test|spec)\.[^.]+$)|(?:Tests?\.cs$)|(?:^|\/)test_[^/]+\.py$/i.test(path);
}

function productionEvidenceWeight(targetFiles: readonly string[], candidateFiles: readonly string[]): number {
  const sources = candidateFiles.filter(path => /\.(?:[cm]?[jt]sx?|java|cs|py|go|rs)$/i.test(path));
  const targetSources = targetFiles.filter(path => /\.(?:[cm]?[jt]sx?|java|cs|py|go|rs)$/i.test(path));
  // Tests can still serve as reference evidence, but a production translation
  // should not lose implementation candidates to a module containing only tests.
  return sources.length && sources.every(isTestFile) && !(targetSources.length && targetSources.every(isTestFile)) ? 0.5 : 1;
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
 * A process-wide admission gate for module searches. A single search fans out
 * to four repositories and each view issues text and vector queries. Additional
 * callers wait instead of adding their recall work to the shared connection pool.
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
  // One admitted request already runs multiple repository/view lookups through
  // the shared pool. Serialize database-heavy recalls by default; deployments
  // with a larger database budget can opt into 2..32 explicitly.
  const value = Number(process.env.CODE_INTELLIGENCE_MODULE_SEARCH_CONCURRENCY ?? 1);
  return Number.isInteger(value) && value >= 1 && value <= 32 ? value : 1;
}

function configuredRepositoryConcurrency(): number {
  // Lower fan-out reduces pool waits but can lengthen the critical path across
  // repositories. Retain the measured default, with an explicit tuning option.
  const value = Number(process.env.CODE_INTELLIGENCE_MODULE_REPOSITORY_CONCURRENCY ?? 4);
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 4;
}

const moduleSearchGate = new ModuleSearchConcurrencyGate(configuredModuleSearchConcurrency());

/** Module metadata is fetched only for recalled IDs; no full structural index is hydrated. */
export async function searchModules(store: IndexStore, request: ModuleMatchRequest, parentSignal?: AbortSignal, reranker?: ModuleReranker,
  recall = new RecallKernel(store), observeTiming?: (timing: Readonly<ModuleSearchTiming>) => void,
  observeCandidates?: (candidates: readonly SearchCandidate[]) => void,
  observeRecall?: (hits: readonly ModuleRecallObservation[]) => void): Promise<SearchCandidate[]> {
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
    const result = await searchModuleSnapshot(store, request, signal, reranker, recall, beginStage, timing, releaseDatabaseSlot, observeCandidates, observeRecall);
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
  releaseDatabaseSlot: () => void, observeCandidates?: (candidates: readonly SearchCandidate[]) => void,
  observeRecall?: (hits: readonly ModuleRecallObservation[]) => void): Promise<SearchCandidate[]> {
  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 10) throw new Error('Module search topK must be between 1 and 10.');
  const repositoryIds = [...new Set(request.repositoryIds)];
  if (repositoryIds.length === 0 || repositoryIds.length > 32) throw new Error('Module search requires between 1 and 32 historical repositories.');
  if (!store.searchSearchDocuments || !store.getModuleArtifacts || !store.getProject || !store.getSourcePreview) throw new Error('Module search requires bounded index-store queries.');
  const target = await resolveModuleRetrievalTarget(store, request.target, signal);
  const configuredRecallLimit = Number(process.env.CODE_INTELLIGENCE_MODULE_RECALL_LIMIT ?? String(request.topK * 8));
  const limitPerView = Number.isInteger(configuredRecallLimit) && configuredRecallLimit >= 1 && configuredRecallLimit <= 96
    ? configuredRecallLimit : Math.min(96, Math.max(16, request.topK * 8));
  const { plans, rerankQuery } = buildModuleSearchQuery(target, request.requirement);
  const maximumFusion = plans.reduce((sum, plan) => sum + plan.weight * (plan.views?.length ?? 3), 0) / reciprocalRankOffset;
  const requiredApis = [...new Set(target.module?.coreApis ?? [])];
  const profile = process.env.RECAST_SEARCH_PROFILE === '1';
  const profileStart = profile ? Date.now() : 0;
  const repositoryConcurrency = configuredRepositoryConcurrency();
  const repositories = (await mapBounded(repositoryIds, repositoryConcurrency, async (repositoryId) => {
    signal.throwIfAborted();
    const repository = await store.getRepository(repositoryId, signal);
    if (!repository?.activeRevision || repository.role !== 'history') return undefined;
    const scope = { repositoryId, analysisRevision: repository.activeRevision };
    const revision = await store.getRevision(scope, signal);
    return revision?.status === 'ready' ? { repository, scope, revision } : undefined;
  })).filter((entry) => entry !== undefined);
  const recallStarted = profile ? Date.now() : 0;
  const outcomes = await recall.recallBatch(repositories.map(({ scope }) => ({ scope, plans, limitPerView, signal })), repositoryConcurrency);
  const byScope = new Map(repositories.map(({ scope }, index) => [JSON.stringify([scope.repositoryId, scope.analysisRevision]), outcomes[index]!]));
  if (profile) console.log(`      [profile] 批量召回=${Date.now() - recallStarted}ms 仓库数=${repositories.length}`);
  const allHits = (await mapBounded(repositories, repositoryConcurrency, async ({ repository, scope, revision }) => {
    const repositoryId = scope.repositoryId;
    // Each view gets a question derived from the target module itself.
    const outcome = byScope.get(JSON.stringify([scope.repositoryId, scope.analysisRevision]))!;
    // Older projections indexed whitespace gaps between declarations. They
    // contain no implementation evidence, even when their paths match the query.
    const documents = outcome.documents.filter((document) => document.kind !== 'source-fragment' || document.text.trim());
    if (profile) console.log(`      [profile]   ${repository.displayName}: docs=${documents.length} 视图=${[...new Set(documents.map((d) => d.kind))].join('|') || '无'}`);
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
    const identityScores = new Map<string, number>();
    const scoreModule = (document: SearchDocumentRecord, artifactId: string, moduleId: string, record: ProjectAnalysisRecord): void => {
      const tree = trees.get(artifactId)!;
      const node = tree.byId.get(moduleId);
      const project = projects.get(record.projectId);
      if (!node || !project) return;
      const module = { ...node, sourceFiles: tree.sourceFiles(node.id).files };
      if (module.sourceFiles.length === 0) return;
      const available = new Set((module.coreApis ?? []).map(normalizedApi).filter(Boolean));
      const apiScore = requiredApis.length ? requiredApis.filter((api) => available.has(normalizedApi(api))).length / requiredApis.length : 0;
      const key = JSON.stringify([record.projectId, module.id]);
      if (!identityScores.has(key)) identityScores.set(key, apiIdentityOverlap(requiredApis, module));
      const identityScore = identityScores.get(key)!;
      const semantic = document.retrievalScore?.semantic;
      const lexical = document.retrievalScore?.lexical ?? 0;
      const evidenceWeight = productionEvidenceWeight(target.module?.sourceFiles ?? [target.path], module.sourceFiles);
      const provenance = outcome.provenance.get(document.searchDocumentId) ?? [];
      const hit = byModule.get(key) ?? { ...scope, repositoryName: repository.displayName, projectId: project.projectId,
        projectPath: project.relativePath, module, score: 0, semanticScore: 0, semanticOrderScore: 0,
        channelScores: new Map<string, number>(), channelRanks: new Map<string, number>(),
        fileEvidence: new Map<string, { score: number; fragment?: string; fragmentScore: number }>() };
      // Summary, source and symbol IDs are different documents even when they
      // support the same module. Fuse at the module identity, retaining its best
      // hit per channel so large modules cannot win by their document count.
      for (const entry of provenance) {
        const channel = JSON.stringify([entry.planLabel, entry.view]);
        const contribution = entry.weight / (reciprocalRankOffset + entry.rank);
        hit.channelScores!.set(channel, Math.max(hit.channelScores!.get(channel) ?? 0, contribution));
        hit.channelRanks!.set(channel, Math.min(hit.channelRanks!.get(channel) ?? Number.POSITIVE_INFINITY, entry.rank));
      }
      const fused = [...hit.channelScores!.values()].reduce((sum, score) => sum + score, 0) / maximumFusion;
      const relevance = semantic !== undefined && Number.isFinite(semantic) ? Math.max(0, Math.min(1, semantic))
        : lexical > 0 ? lexical / (lexical + 10) : fused;
      hit.score = (0.8 * fused + 0.2 * apiScore) * evidenceWeight;
      hit.semanticScore = Math.max(hit.semanticScore, relevance);
      hit.semanticOrderScore = Math.max(hit.semanticOrderScore, (0.8 * relevance + 0.2 * Math.max(apiScore, identityScore)) * evidenceWeight);
      if (document.relativePath) {
        const file = hit.fileEvidence!.get(document.relativePath) ?? { score: 0, fragmentScore: 0 };
        const contribution = provenance.reduce((sum, entry) => sum + entry.weight / (reciprocalRankOffset + entry.rank), 0);
        file.score = Math.max(file.score, contribution);
        if (document.kind === 'source-fragment' && implementationExcerpt(document.text, module.coreApis ?? [], 300)) {
          const fragmentScore = contribution + apiTerms(module.coreApis ?? []).filter(term => document.text.includes(term)).length / reciprocalRankOffset;
          if (!file.fragment || fragmentScore > file.fragmentScore) {
            // Choose the implementation before bounding it; a long license or
            // class comment must not consume the entire evidence allowance.
            file.fragment = implementationExcerpt(document.text, module.coreApis ?? [], 4_000);
            file.fragmentScore = fragmentScore;
          }
        }
        hit.fileEvidence!.set(document.relativePath, file);
      }
      byModule.set(key, hit);
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
  if (profile) console.log(`      [profile] 召回+聚合(仓库并发=${repositoryConcurrency})=${Date.now() - profileStart}ms 仓库数=${repositoryIds.length}`);

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
  // Read-only diagnostics expose every module surviving view ownership and language
  // validation, before shortlist truncation. They never enter ranking or persistence.
  try { observeRecall?.(usableHits.map(hit => ({ repositoryId: hit.repositoryId, analysisRevision: hit.analysisRevision,
    projectId: hit.projectId, moduleId: hit.module.id,
    channels: [...(hit.channelScores?.keys() ?? [])].map(key => { try { const [plan, view] = JSON.parse(key); return `${plan}:${view}`; } catch { return key; } }),
    score: hit.score,
    channelRanks: Object.fromEntries([...(hit.channelRanks ?? [])].map(([key, rank]) => {
      try { const [plan, view] = JSON.parse(key); return [`${plan}:${view}`, rank]; } catch { return [key, rank]; }
    })),
    channelScores: Object.fromEntries([...(hit.channelScores ?? [])].map(([key, score]) => {
      try { const [plan, view] = JSON.parse(key); return [`${plan}:${view}`, score]; } catch { return [key, score]; }
    })),
  })) ); } catch { /* observation must never affect search */ }
  // Top4 receives up to 20 distinct candidates (bounded by the model's 20-item
  // contract). Keeping both orders protects useful semantic matches while
  // allowing lexical/vector agreement to bring missed implementations back.
  const configuredShortlist = Number(process.env.CODE_INTELLIGENCE_MODULE_SEARCH_SHORTLIST ?? '20');
  const shortlistBudget = Number.isInteger(configuredShortlist) && configuredShortlist >= request.topK && configuredShortlist <= 64
    ? configuredShortlist : 20;
  const hits = reranker ? shortlistHits(usableHits, shortlistBudget)
    : usableHits.sort(compareHits).slice(0, request.topK);
  // Parent/child candidates often share files. Keep these bounded local reads
  // within this request; no revision-independent source cache is introduced.
  const previewCache = new Map<string, ReturnType<NonNullable<IndexStore['getSourcePreview']>>>();
  const symbolCache = new Map<string, ReturnType<NonNullable<IndexStore['querySymbols']>>>();
  const sliceCache = new Map<string, ReturnType<NonNullable<IndexStore['getSourceSlice']>>>();
  const result = await mapBounded(hits, 4, async (hit): Promise<SearchCandidate> => {
    signal.throwIfAborted();
    const files = [...new Set(hit.module.sourceFiles)];
    const previewFiles = representativeFiles(hit);
    const parts = await mapBounded(previewFiles, 3, async (file) => {
      signal.throwIfAborted();
      const key = JSON.stringify([hit.repositoryId, hit.analysisRevision, file]);
      if (!previewCache.has(key)) previewCache.set(key, store.getSourcePreview!(hit, file, 4_000, signal));
      const source = await previewCache.get(key)!;
      if (source === null) throw new Error(`Module source is missing from its revision: ${file}`);
      const fragment = hit.fileEvidence?.get(file)?.fragment;
      if (isSourceFile(file) && store.querySymbols && store.getSourceSlice) {
        if (!symbolCache.has(key)) symbolCache.set(key, store.querySymbols(hit,
          { relativePaths: [file], kinds: ['method', 'function'], limit: 200 }, signal));
        const { symbols } = await symbolCache.get(key)!;
        const symbol = representativeSymbol(symbols.filter(s => s.relativePath === file), hit, fragment, target);
        if (symbol) {
          const sliceKey = JSON.stringify([key, symbol.sourceRange]);
          if (!sliceCache.has(sliceKey)) sliceCache.set(sliceKey, store.getSourceSlice(hit, file, symbol.sourceRange, 4_000, signal));
          const slice = await sliceCache.get(sliceKey)!;
          if (slice?.text.trim()) return { text: `// ${file}\n${implementationExcerpt(slice.text, [], 4_000)}`, truncated: true };
        }
      }
      // A whitespace-only fragment must not hide a readable source preview.
      const text = fragment?.trim() || implementationExcerpt(source.text, [], 4_000);
      return { text: `// ${file}\n${text}`, truncated: Boolean(fragment?.trim()) || source.truncated };
    });
    const available = new Set((hit.module.coreApis ?? []).map(normalizedApi).filter(Boolean));
    const matchedApis = requiredApis.filter((api) => available.has(normalizedApi(api)));
    return {
      id: `module-${createHash('sha256').update(JSON.stringify([hit.repositoryId, hit.analysisRevision, hit.projectId, hit.module.id])).digest('hex')}`,
      title: hit.module.name, repository: hit.repositoryName, license: 'Unknown', kind: 'module',
      language: moduleLanguage(hit.module.language, files), path: previewFiles[0]!,
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
  // Experiment observers receive a detached snapshot, never mutable ranking inputs.
  observeCandidates?.(structuredClone(result));
  let ranked = result;
  if (reranker && result.length > 0) {
    beginStage('rerankMs');
    timing.rerankCandidateCount = result.length;
    try {
      const ordering = await reranker.rank(rerankQuery, result.map(rerankDocument), signal);
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
  const names: Record<string, ModuleTarget['language']> = { typescript: 'TypeScript', javascript: 'TypeScript', python: 'Python', java: 'Java', 'c#': 'C#', csharp: 'C#', c: 'C', cpp: 'C++', 'c++': 'C++', rust: 'Rust', go: 'Go' };
  if (language && names[language.toLowerCase()]) return names[language.toLowerCase()]!;
  const extensions: Record<string, ModuleTarget['language']> = { ts: 'TypeScript', js: 'TypeScript', py: 'Python', java: 'Java', cs: 'C#', rs: 'Rust', go: 'Go', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++' };
  const found = files.map((file) => extensions[file.split('.').at(-1)?.toLowerCase() ?? '']).find(Boolean);
  if (!found) throw new Error(`Module source language is unsupported: ${language ?? 'unknown'}`);
  return found;
}

export const moduleMatchingInternals = { normalizedApi, mapBounded, configuredModuleSearchConcurrency, moduleSearchGate,
  configuredRepositoryConcurrency, productionEvidenceWeight, shortlistHits, representativeFiles, representativeSymbol, implementationExcerpt, rerankDocument };
