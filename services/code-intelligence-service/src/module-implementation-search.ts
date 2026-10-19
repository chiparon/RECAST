import { indexModuleHierarchy } from '@forexplore/contracts';
import type {
  Language,
  ModuleArtifactRecord,
  ModuleTarget,
  ProjectAnalysisRecord,
  RepositoryId,
  SearchCandidate,
  SearchDocumentRecord,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import { searchModules } from './module-matching.js';
import type { ModuleReranker } from './module-reranker.js';
import { projectPlanHash } from './project-analysis.js';
import { RecallKernel } from './recall-kernel.js';
import { resolveModuleRetrievalTarget } from './module-search-query.js';

export interface ModuleImplementationSearchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  repositoryIds: readonly RepositoryId[];
}

export interface ModuleImplementationSearchPort {
  search(request: ModuleImplementationSearchRequest, signal?: AbortSignal, reranker?: ModuleReranker): Promise<SearchCandidate[]>;
}

/**
 * Ownership a reviewed module declares over files and symbols. It annotates a
 * symbol and feeds it a discounted evidence signal; it never decides whether the
 * symbol is allowed to be a candidate.
 */
interface SymbolModuleAnnotation {
  repositoryId: RepositoryId;
  analysisRevision: string;
  artifactId: string;
  planHash?: string;
  hierarchy?: boolean;
  projectId: string;
  projectPath: string;
  moduleId: string;
  name: string;
  purpose?: string;
  description: string;
  sourceFiles: string[];
  coreApis: string[];
  evidenceIds: string[];
  risks: string[];
}

/** One flat symbol candidate with every retrieval signal the projection keeps. */
interface ScoredSymbol {
  symbol: SymbolRecord;
  index: StructuralIndex;
  repositoryId: RepositoryId;
  repositoryName: string;
  analysisRevision: string;
  /** Best weighted-RRF recall evidence for this symbol, normalised to (0, 1]. */
  evidence: number;
  /** Best vector similarity among the documents that recalled it, if any. */
  semantic: number;
  symbolMatch: number;
  kindMatch: number;
  overall: number;
  module?: SymbolModuleAnnotation;
}

interface ModuleOwnership {
  byPath: Map<string, SymbolModuleAnnotation[]>;
  bySymbolKey: Map<string, SymbolModuleAnnotation[]>;
  byArtifact: Map<string, SymbolModuleAnnotation[]>;
}

const languageNames: Record<string, Language> = {
  typescript: 'TypeScript',
  javascript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  csharp: 'C#',
  rust: 'Rust',
  go: 'Go',
};

// Flat symbol weights: recall evidence first, then the code identity itself, then
// type fit. Module context is folded into `evidence` at a discount instead of
// taking a weight of its own, so no module boundary can outvote the symbol.
const symbolWeights = { evidence: 0.55, symbol: 0.35, kind: 0.1 } as const;
/** A module summary that matches vouches for its own symbols at half strength. */
const summaryEvidenceDecay = 0.5;
/** Two candidates per file keeps sibling overloads from filling the page. */
const perFileLimit = 2;

function terms(value: string): Set<string> {
  return new Set(value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function overlapScore(queryTerms: ReadonlySet<string>, value: string): number {
  const valueTerms = terms(value);
  if (queryTerms.size === 0 || valueTerms.size === 0) return 0;
  let common = 0;
  for (const term of queryTerms) if (valueTerms.has(term)) common++;
  return common / Math.max(queryTerms.size, valueTerms.size);
}

function overlap(left: string, right: string): number {
  return overlapScore(terms(left), right);
}

/**
 * Tokens that say nothing about *which* symbol a candidate is. Counting them made
 * `public class Whatever` look like an identity match and let a sibling class
 * outrank the real port of the target, so the identity comparison ignores them.
 */
const identityStopWords = new Set([
  'abstract', 'any', 'apache', 'args', 'array', 'async', 'await', 'bool', 'boolean', 'byte', 'char', 'class',
  'cls', 'com', 'commons', 'const', 'ctor', 'decimal', 'default', 'def', 'dict', 'double', 'enum', 'export',
  'extends', 'false', 'final', 'float', 'fn', 'from', 'func', 'function', 'generic', 'get', 'implements',
  'import', 'inherits', 'init', 'int', 'integer', 'interface', 'internal', 'io', 'java', 'javax', 'lang',
  'let', 'list', 'long', 'main', 'map', 'namespace', 'net', 'never', 'new', 'nil', 'none', 'null', 'object',
  'org', 'overload', 'override', 'package', 'params', 'partial', 'private', 'protected', 'public', 'record',
  'return', 'sbyte', 'sealed', 'self', 'set', 'short', 'slice', 'static', 'str', 'string', 'struct', 'system',
  'task', 'this', 'throw', 'throws', 'true', 'tuple', 'type', 'uint', 'ulong', 'unknown', 'ushort', 'using',
  'util', 'val', 'value', 'var', 'virtual', 'void',
]);

function identityTerms(value: string): Set<string> {
  const result = new Set<string>();
  for (const term of terms(value)) if (!identityStopWords.has(term)) result.add(term);
  return result;
}

/** Identity similarity between two code identities, ignoring language boilerplate. */
function overlapIdentity(left: ReadonlySet<string>, right: string): number {
  const valueTerms = identityTerms(right);
  if (left.size === 0 || valueTerms.size === 0) return 0;
  let common = 0;
  for (const term of left) if (valueTerms.has(term)) common++;
  return common / Math.max(left.size, valueTerms.size);
}

function moduleIdentity(document: SearchDocumentRecord): { projectId: string; moduleId: string; planHash?: string } | null {
  try {
    const value = JSON.parse(document.text) as { projectId?: unknown; moduleId?: unknown; planHash?: unknown };
    return typeof value.projectId === 'string' && typeof value.moduleId === 'string'
      ? { projectId: value.projectId, moduleId: value.moduleId, ...(typeof value.planHash === 'string' ? { planHash: value.planHash } : {}) }
      : null;
  } catch {
    return null;
  }
}

function projectRecord(artifact: ModuleArtifactRecord): ProjectAnalysisRecord | null {
  if (artifact.kind !== 'module-summary' || artifact.status !== 'current' || !artifact.payload) return null;
  const value = artifact.payload as Partial<ProjectAnalysisRecord>;
  if (value.state !== 'ready' || !value.proposal || !Array.isArray(value.proposal.modules) ||
    artifact.analysisHash !== value.proposal.analysisHash || !artifact.planHash || artifact.planHash !== projectPlanHash(value.proposal)) {
    return null;
  }
  return value as ProjectAnalysisRecord;
}

function supportsTarget(symbol: SymbolRecord, target: ModuleTarget): boolean {
  if (!languageNames[symbol.languageId]) return false;
  return target.kind === 'class'
    ? ['class', 'record', 'struct', 'interface'].includes(symbol.kind)
    : ['function', 'method', 'constructor'].includes(symbol.kind);
}

function sourceExcerpt(source: string, symbol: SymbolRecord): string {
  const lines = source.split(/\r?\n/);
  const startLine = Math.max(0, symbol.sourceRange.startLine - 1);
  const endLine = Math.min(lines.length - 1, Math.max(startLine, symbol.sourceRange.endLine - 1));
  const selected = lines.slice(startLine, endLine + 1);
  if (selected.length === 0) return '';
  selected[0] = selected[0]?.slice(Math.max(0, symbol.sourceRange.startColumn - 1)) ?? '';
  if (selected.length === 1) {
    const width = Math.max(0, symbol.sourceRange.endColumn - symbol.sourceRange.startColumn);
    selected[0] = selected[0]?.slice(0, width) ?? '';
  } else {
    selected[selected.length - 1] = selected.at(-1)?.slice(0, Math.max(0, symbol.sourceRange.endColumn - 1)) ?? '';
  }
  return selected.join('\n').trim();
}

function dependencies(index: StructuralIndex, symbol: SymbolRecord): string[] {
  return [...new Set(index.dependencyEdges
    .filter((edge) => edge.sourceSymbolKey === symbol.symbolKey || edge.sourceRelativePath === symbol.relativePath)
    .flatMap((edge) => edge.targetReference ?? edge.targetSymbolKey ?? edge.targetRelativePath
      ? [edge.targetReference ?? edge.targetSymbolKey ?? edge.targetRelativePath!]
      : []))]
    .slice(0, 32);
}

function queryText(request: ModuleImplementationSearchRequest): string {
  return [request.target.name, request.target.signature, request.target.documentation ?? '', request.requirement].join('\n');
}

function moduleKey(module: SymbolModuleAnnotation): string {
  return `${module.projectId}\u0000${module.moduleId}`;
}

/**
 * The module a symbol is annotated with: the recalled one when we have evidence
 * for it, otherwise the most specific owner, then a stable id order.
 */
function preferredOwner(owners: readonly SymbolModuleAnnotation[], recalled: ReadonlyMap<string, number>): SymbolModuleAnnotation | undefined {
  return [...owners].sort((left, right) =>
    Number(recalled.has(moduleKey(right))) - Number(recalled.has(moduleKey(left)))
    || left.sourceFiles.length - right.sourceFiles.length
    || left.moduleId.localeCompare(right.moduleId))[0];
}

/** Effective ownership of one revision, with descendant manifests already expanded. */
function moduleOwnership(
  index: StructuralIndex,
  artifacts: readonly ModuleArtifactRecord[],
  scope: { repositoryId: RepositoryId; analysisRevision: string },
): ModuleOwnership {
  const ownership: ModuleOwnership = { byPath: new Map(), bySymbolKey: new Map(), byArtifact: new Map() };
  const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  };
  for (const artifact of artifacts) {
    const record = projectRecord(artifact);
    if (!record?.proposal) continue;
    if (record.repositoryId !== scope.repositoryId || record.analysisRevision !== scope.analysisRevision ||
      record.proposal.analysisHash !== index.analysisHash) continue;
    const project = index.projects.find((candidate) => candidate.projectId === record.projectId);
    if (!project) continue;
    let tree: ReturnType<typeof indexModuleHierarchy>;
    try { tree = indexModuleHierarchy(record.proposal.modules); }
    catch { continue; }
    for (const node of record.proposal.modules) {
      const annotation: SymbolModuleAnnotation = {
        repositoryId: scope.repositoryId,
        analysisRevision: scope.analysisRevision,
        artifactId: artifact.moduleArtifactId,
        ...(artifact.planHash ? { planHash: artifact.planHash } : {}),
        ...(record.proposal.hierarchy ? { hierarchy: true } : {}),
        projectId: record.projectId,
        projectPath: project.relativePath,
        moduleId: node.id,
        name: node.name,
        ...(node.purpose ? { purpose: node.purpose } : {}),
        description: node.description,
        sourceFiles: tree.sourceFiles(node.id).files,
        coreApis: node.coreApis ?? [],
        evidenceIds: node.evidenceIds ?? [],
        risks: record.proposal.risks ?? [],
      };
      push(ownership.byArtifact, artifact.moduleArtifactId, annotation);
      for (const file of annotation.sourceFiles) push(ownership.byPath, file, annotation);
      for (const symbolKey of node.symbolKeys ?? []) push(ownership.bySymbolKey, symbolKey, annotation);
    }
  }
  return ownership;
}

/** Modules a recalled summary actually speaks for, honouring its plan binding. */
function summaryOwners(document: SearchDocumentRecord, byArtifact: Map<string, SymbolModuleAnnotation[]>): SymbolModuleAnnotation[] {
  const owners = document.moduleArtifactId ? byArtifact.get(document.moduleArtifactId) ?? [] : [];
  if (owners.length === 0) return [];
  const identity = moduleIdentity(document);
  if (!identity) return owners;
  return owners.filter((owner) =>
    (!identity.projectId || owner.projectId === identity.projectId) &&
    (!identity.moduleId || owner.moduleId === identity.moduleId) &&
    (!owner.hierarchy || identity.planHash === owner.planHash) &&
    (identity.planHash === undefined || identity.planHash === owner.planHash));
}

function symbolsByPath(index: StructuralIndex): Map<string, SymbolRecord[]> {
  const byPath = new Map<string, SymbolRecord[]>();
  for (const symbol of index.symbols) {
    const list = byPath.get(symbol.relativePath);
    if (list) list.push(symbol); else byPath.set(symbol.relativePath, [symbol]);
  }
  for (const list of byPath.values()) {
    list.sort((left, right) => left.sourceRange.startLine - right.sourceRange.startLine
      || left.sourceRange.startColumn - right.sourceRange.startColumn
      || right.sourceRange.endLine - left.sourceRange.endLine);
  }
  return byPath;
}

function startsAfter(left: SymbolRecord['sourceRange'], right: SymbolRecord['sourceRange']): boolean {
  return left.startLine > right.startLine || (left.startLine === right.startLine && left.startColumn > right.startColumn);
}

function endsBeforeStart(span: SymbolRecord['sourceRange'], range: SymbolRecord['sourceRange']): boolean {
  return span.endLine < range.startLine || (span.endLine === range.startLine && span.endColumn < range.startColumn);
}

function endsBefore(left: SymbolRecord['sourceRange'], right: SymbolRecord['sourceRange']): boolean {
  return left.endLine < right.endLine || (left.endLine === right.endLine && left.endColumn < right.endColumn);
}

/**
 * A fragment without its own symbol key (imports, class fields, gaps between
 * members) still belongs to the innermost declaration that contains it.
 */
function containingSymbol(byPath: Map<string, SymbolRecord[]>, document: SearchDocumentRecord): SymbolRecord | undefined {
  const range = document.sourceRange;
  const path = document.relativePath;
  if (!range || !path) return undefined;
  let best: SymbolRecord | undefined;
  for (const symbol of byPath.get(path) ?? []) {
    if (startsAfter(symbol.sourceRange, range)) break;
    if (endsBeforeStart(symbol.sourceRange, range)) continue;
    if (!best || endsBefore(symbol.sourceRange, best.sourceRange)) best = symbol;
  }
  return best;
}

/**
 * Code-to-code retrieval.
 *
 * Module targets rank reviewed modules, so their candidates are modules. Class
 * and function targets are ranked flat: recall nominates symbols directly and
 * every indexed symbol of the revision is eligible, while the module that
 * declares a symbol only annotates it and adds a discounted evidence signal.
 * The structural index is already loaded for the revision, so gating symbols
 * behind module ownership would hide candidates without saving a single read.
 */
export class ModuleImplementationSearchService implements ModuleImplementationSearchPort {
  /** Shared multi-view recall; this projection keeps symbol resolution and its own calibration. */
  readonly #recall: RecallKernel;
  readonly #moduleCache = new Map<string, { expiresAt: number; revisions: Map<string, string>; value: SearchCandidate[] }>();
  static readonly #moduleCacheTtlMs = 5 * 60_000;
  static readonly #moduleCacheMaxEntries = 64;
  constructor(private readonly store: IndexStore, private readonly reranker?: ModuleReranker) {
    this.#recall = new RecallKernel(store);
  }

  async search(request: ModuleImplementationSearchRequest, signal?: AbortSignal, scopedReranker?: ModuleReranker): Promise<SearchCandidate[]> {
    const reranker = scopedReranker ?? this.reranker;
    if (request.target.kind === 'module') {
      // Resolve before the cache key: a re-published summary in the same source
      // revision must invalidate old results just like a revision change does.
      request = { ...request, target: await resolveModuleRetrievalTarget(this.store, request.target, signal) };
      const repositoryIds = [...new Set(request.repositoryIds)].sort();
      const rerankerKey = reranker?.cacheKey?.() ?? reranker?.model ?? '';
      const key = JSON.stringify({ target: request.target, requirement: request.requirement, topK: request.topK,
        repositoryIds, reranker: rerankerKey });
      const cached = this.#moduleCache.get(key);
      if (!scopedReranker && cached && cached.expiresAt > Date.now() && await this.#cacheRevisionsCurrent(repositoryIds, cached.revisions, signal)) {
        return cloneCandidates(cached.value);
      }
      if (cached) this.#moduleCache.delete(key);
      const result = await searchModules(this.store, { ...request, repositoryIds }, signal, reranker, this.#recall);
      const revisions = new Map((await Promise.all(repositoryIds.map(async (repositoryId) => {
        const repository = await this.store.getRepository(repositoryId, signal);
        return repository?.activeRevision ? [repositoryId, repository.activeRevision] as const : null;
      }))).filter((entry): entry is readonly [string, string] => entry !== null));
      // Do not cache a hybrid-order fallback after a model failure: a later
      // request should get a chance to rerank once the provider recovers.
      const rerankSucceeded = !reranker || result.every((candidate) => Boolean(candidate.moduleMatch?.reranker));
      if (rerankSucceeded && !scopedReranker) {
        this.#moduleCache.set(key, { expiresAt: Date.now() + ModuleImplementationSearchService.#moduleCacheTtlMs,
          revisions, value: cloneCandidates(result) });
        while (this.#moduleCache.size > ModuleImplementationSearchService.#moduleCacheMaxEntries) {
          this.#moduleCache.delete(this.#moduleCache.keys().next().value!);
        }
      }
      return cloneCandidates(result);
    }
    if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 10) {
      throw new Error('Module implementation search topK must be between 1 and 10.');
    }
    const repositoryIds = [...new Set(request.repositoryIds.filter(Boolean))];
    if (repositoryIds.length === 0) throw new Error('至少需要一个已解析的参考工程才能执行模块检索。');
    const query = queryText(request);
    // Identity is the target's own name and signature; the requirement stays in the
    // recall query, where it belongs, instead of being double counted as identity.
    const identity = identityTerms([request.target.name, request.target.signature, request.target.documentation ?? ''].join('\n'));
    const perViewLimit = Math.max(20, request.topK * 5);
    const scored: ScoredSymbol[] = [];
    const contributing = new Map<RepositoryId, string>();

    for (const repositoryId of repositoryIds) {
      signal?.throwIfAborted();
      const repository = await this.store.getRepository(repositoryId);
      if (!repository?.activeRevision || repository.role !== 'history') continue;
      const scope = { repositoryId, analysisRevision: repository.activeRevision };
      const [index, artifacts] = await Promise.all([
        this.store.getStructuralIndex(scope),
        this.store.listModuleArtifacts(scope),
      ]);
      if (!index) continue;
      // Shared kernel: the code identity is one plan over every view, so a symbol
      // can be recalled by its declaration, by its implementation, or by both.
      const outcome = await this.#recall.recall({
        scope,
        plans: [{ label: 'code-identity', query, weight: 1 }],
        limitPerView: perViewLimit,
        signal,
      });
      if (outcome.documents.length === 0) continue;
      const ownership = moduleOwnership(index, artifacts, scope);
      const symbolsByKey = new Map(index.symbols.map((symbol) => [symbol.symbolKey, symbol] as const));
      const symbolsByFile = symbolsByPath(index);
      // Documents nominate symbols directly; summaries nominate the modules whose
      // symbols they then vouch for, at a discount.
      const recalled = new Map<string, { evidence: number; semantic: number }>();
      const moduleEvidence = new Map<string, number>();
      for (const document of outcome.documents) {
        const fused = RecallKernel.normalise(outcome, document.searchDocumentId);
        if (document.kind === 'summary') {
          for (const owner of summaryOwners(document, ownership.byArtifact)) {
            const key = moduleKey(owner);
            moduleEvidence.set(key, Math.max(moduleEvidence.get(key) ?? 0, fused));
          }
          continue;
        }
        const symbolKey = document.symbolKey ?? containingSymbol(symbolsByFile, document)?.symbolKey;
        if (!symbolKey || !symbolsByKey.has(symbolKey)) continue;
        const previous = recalled.get(symbolKey);
        const semantic = document.retrievalScore?.semantic;
        recalled.set(symbolKey, {
          evidence: Math.max(previous?.evidence ?? 0, fused),
          semantic: Math.max(previous?.semantic ?? 0, semantic !== undefined && Number.isFinite(semantic) ? semantic : 0),
        });
      }

      const ownersOf = (symbol: SymbolRecord): SymbolModuleAnnotation[] => {
        const byKey = ownership.bySymbolKey.get(symbol.symbolKey);
        return byKey && byKey.length > 0 ? byKey : ownership.byPath.get(symbol.relativePath) ?? [];
      };
      const nominated = new Set<string>(recalled.keys());
      if (moduleEvidence.size > 0) {
        for (const symbol of index.symbols) {
          if (ownersOf(symbol).some((owner) => moduleEvidence.has(moduleKey(owner)))) nominated.add(symbol.symbolKey);
        }
      }
      for (const symbolKey of nominated) {
        const symbol = symbolsByKey.get(symbolKey);
        if (!symbol || !supportsTarget(symbol, request.target)) continue;
        const owners = ownersOf(symbol);
        const module = preferredOwner(owners, moduleEvidence);
        const carried = owners.reduce((best, owner) => Math.max(best, moduleEvidence.get(moduleKey(owner)) ?? 0), 0) * summaryEvidenceDecay;
        const own = recalled.get(symbolKey);
        const evidence = Math.max(own?.evidence ?? 0, carried);
        const symbolMatch = overlapIdentity(identity, [symbol.name, symbol.qualifiedName, symbol.signature ?? ''].join('\n'));
        const kindMatch = request.target.kind === 'class'
          ? ['class', 'record', 'struct'].includes(symbol.kind) ? 1 : 0.65
          : symbol.kind === 'constructor' ? 0.7 : 1;
        scored.push({
          symbol,
          index,
          repositoryId,
          repositoryName: repository.displayName,
          analysisRevision: repository.activeRevision!,
          evidence,
          semantic: own?.semantic ?? 0,
          symbolMatch,
          kindMatch,
          overall: Math.min(1, symbolWeights.evidence * evidence + symbolWeights.symbol * symbolMatch + symbolWeights.kind * kindMatch),
          ...(module ? { module } : {}),
        });
      }
      if (scored.length > 0) contributing.set(repositoryId, repository.activeRevision!);
    }

    const ranked = scored.sort((left, right) => right.overall - left.overall
      || left.symbol.symbolId.localeCompare(right.symbol.symbolId));
    const perFile = new Map<string, number>();
    const selected: ScoredSymbol[] = [];
    for (const candidate of ranked) {
      const fileKey = `${candidate.repositoryId}\u0000${candidate.symbol.relativePath}`;
      if ((perFile.get(fileKey) ?? 0) >= perFileLimit) continue;
      perFile.set(fileKey, (perFile.get(fileKey) ?? 0) + 1);
      selected.push(candidate);
      if (selected.length === request.topK) break;
    }

    const candidates = await Promise.all(selected.map(async (candidate): Promise<SearchCandidate> => {
      signal?.throwIfAborted();
      const source = await this.store.getSourceText(candidate.index, candidate.symbol.relativePath) ?? '';
      const title = candidate.symbol.qualifiedName || candidate.symbol.name;
      return {
        id: candidate.symbol.symbolId,
        title,
        repository: candidate.repositoryName,
        license: 'Unknown',
        language: languageNames[candidate.symbol.languageId]!,
        kind: request.target.kind,
        path: candidate.symbol.relativePath,
        signature: candidate.symbol.signature ?? candidate.symbol.name,
        summary: candidate.module?.description || candidate.module?.purpose || candidate.symbol.signature
          || `来自历史工程的索引符号 ${title}。`,
        score: {
          overall: candidate.overall,
          semantic: candidate.semantic,
          symbol: candidate.symbolMatch,
          contract: candidate.kindMatch,
          hybrid: candidate.evidence,
        },
        preview: sourceExcerpt(source, candidate.symbol),
        dependencies: dependencies(candidate.index, candidate.symbol),
        compatibility: ['来自当前 revision 已索引的权威符号'],
        risks: [
          ...(candidate.module?.risks ?? []),
          '许可证尚未由代码智能索引确认',
        ],
        ...(candidate.module ? {
          sourceModule: {
            repositoryId: candidate.repositoryId,
            analysisRevision: candidate.analysisRevision,
            projectId: candidate.module.projectId,
            moduleId: candidate.module.moduleId,
            name: candidate.module.name,
            projectPath: candidate.module.projectPath,
            ...(candidate.module.purpose ? { purpose: candidate.module.purpose } : {}),
            sourceFiles: candidate.module.sourceFiles,
            coreApis: candidate.module.coreApis,
            evidenceIds: candidate.module.evidenceIds,
          },
        } : {}),
      };
    }));
    for (const [repositoryId, analysisRevision] of contributing) {
      signal?.throwIfAborted();
      if ((await this.store.getRepository(repositoryId, signal))?.activeRevision !== analysisRevision) {
        throw new Error('Repository revision changed during module search; retry against the current snapshot.');
      }
    }
    return candidates.slice(0, request.topK);
  }

  async #cacheRevisionsCurrent(repositoryIds: readonly string[], expected: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<boolean> {
    if (expected.size !== repositoryIds.length) return false;
    const current = await Promise.all(repositoryIds.map(async (repositoryId) => {
      signal?.throwIfAborted();
      const repository = await this.store.getRepository(repositoryId, signal);
      return repository?.role === 'history' && repository.activeRevision === expected.get(repositoryId);
    }));
    return current.every(Boolean);
  }
}

function cloneCandidates(candidates: readonly SearchCandidate[]): SearchCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    score: { ...candidate.score }, dependencies: [...candidate.dependencies],
    compatibility: [...candidate.compatibility], risks: [...candidate.risks],
    ...(candidate.sourceModule ? { sourceModule: { ...candidate.sourceModule,
      ...(candidate.sourceModule.sourceFiles ? { sourceFiles: [...candidate.sourceModule.sourceFiles] } : {}),
      ...(candidate.sourceModule.coreApis ? { coreApis: [...candidate.sourceModule.coreApis] } : {}),
      ...(candidate.sourceModule.dependsOn ? { dependsOn: [...candidate.sourceModule.dependsOn] } : {}),
      ...(candidate.sourceModule.evidenceIds ? { evidenceIds: [...candidate.sourceModule.evidenceIds] } : {}) } } : {}),
    ...(candidate.moduleMatch ? { moduleMatch: { ...candidate.moduleMatch,
      requiredApis: [...candidate.moduleMatch.requiredApis], matchedApis: [...candidate.moduleMatch.matchedApis],
      missingApis: [...candidate.moduleMatch.missingApis], previewFiles: [...candidate.moduleMatch.previewFiles],
      ...(candidate.moduleMatch.reranker ? { reranker: { ...candidate.moduleMatch.reranker } } : {}) } } : {}),
  }));
}

export const moduleImplementationSearchInternals = {
  moduleIdentity,
  overlap,
  sourceExcerpt,
  supportsTarget,
  terms,
};
