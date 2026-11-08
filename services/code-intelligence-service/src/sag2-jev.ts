import type {
  DependencyEdgeRecord,
  ModuleTarget,
  SearchCandidate,
} from '@forexplore/contracts';
import { tokenizeSag2Text } from './sag2-bm25.js';

export interface Sag2Responsibility {
  index: number;
  label: string;
  terms: string[];
}

export type Sag2EvidenceVerdict = 'anchor' | 'supporting' | 'irrelevant';

export interface Sag2CandidateDecision {
  id: string;
  moduleId?: string;
  repositoryId?: string;
  score: number;
  covers: number[];
  verdict: Sag2EvidenceVerdict;
  bridgeTerms: string[];
}

export interface Sag2JevOutcome {
  responsibilities: Sag2Responsibility[];
  decisions: Sag2CandidateDecision[];
  coveredIndices: number[];
  missingResponsibilities: Sag2Responsibility[];
  bridgeTerms: string[];
  hop2Queries: Array<{ label: string; query: string; weight: number }>;
}

export interface Sag2JevEvaluationInput {
  target: ModuleTarget;
  requirement: string;
  candidates: readonly SearchCandidate[];
  /** Optional structural dependency edges outgoing from Hop-1 anchor modules. */
  dependencyEdges?: ReadonlyMap<string, readonly DependencyEdgeRecord[]>;
  signal?: AbortSignal;
}

export interface Sag2JevJudge {
  evaluate(input: Sag2JevEvaluationInput): Promise<Sag2JevOutcome>;
}

const genericBridgeStopWords = new Set([
  'abstract', 'action', 'adapter', 'adapters', 'additional', 'any', 'api', 'apis', 'app', 'application',
  'args', 'argument', 'array', 'async', 'await', 'base', 'behavior', 'bool', 'boolean', 'build', 'builder',
  'business', 'byte', 'call', 'callable', 'callback', 'can', 'cancel', 'cancellation', 'char', 'check',
  'class', 'client', 'clone', 'close', 'cls', 'code', 'collection', 'com', 'common', 'commons', 'Complete',
  'complete', 'component', 'components', 'config', 'configuration', 'const', 'context', 'contract',
  'contracts', 'controller', 'core', 'create', 'cs', 'csharp', 'ctor', 'Current', 'current', 'data',
  'date', 'datetime', 'datetimeoffset', 'decimal', 'def', 'default', 'define', 'delete', 'depend',
  'dependency', 'description', 'dict', 'dictionary', 'dispose', 'disposable', 'do', 'domain', 'double',
  'dto', 'element', 'empty', 'enable', 'end', 'engine', 'entity', 'entry', 'enum', 'equals', 'error',
  'event', 'exception', 'execute', 'existing', 'export', 'extend', 'extended', 'extends', 'extension',
  'factory', 'fail', 'false', 'field', 'file', 'files', 'filter', 'final', 'find', 'first', 'float', 'fn',
  'for', 'format', 'from', 'func', 'function', 'gateway', 'generic', 'get', 'global', 'go', 'guid',
  'handle', 'handler', 'has', 'hash', 'hashcode', 'hashset', 'helper', 'host', 'id', 'icollection',
  'idictionary', 'idisposable', 'ienumerable', 'ilist', 'impl', 'implement', 'implementation', 'implements',
  'import', 'in', 'index', 'info', 'infrastructure', 'init', 'initialize', 'input', 'instance', 'int',
  'integer', 'interface', 'interfaces', 'internal', 'into', 'invalid', 'io', 'ireadonlycollection',
  'ireadonlydictionary', 'ireadonlylist', 'is', 'iset', 'item', 'items', 'iterator', 'java', 'javascript',
  'json', 'key', 'keys', 'kind', 'lang', 'language', 'last', 'length', 'let', 'level', 'lifecycle', 'limit',
  'line', 'list', 'load', 'local', 'log', 'logger', 'long', 'main', 'make', 'manage', 'manager', 'map',
  'match', 'max', 'message', 'meta', 'metadata', 'method', 'min', 'mode', 'model', 'models', 'module',
  'modules', 'must', 'name', 'names', 'namespace', 'net', 'never', 'new', 'next', 'nil', 'node', 'none',
  'not', 'null', 'number', 'obj', 'object', 'of', 'offset', 'ok', 'on', 'one', 'open', 'operation',
  'option', 'optional', 'options', 'or', 'order', 'org', 'out', 'output', 'overload', 'override', 'package',
  'page', 'param', 'parameter', 'parameters', 'params', 'parent', 'parse', 'part', 'partial', 'path',
  'paths', 'payload', 'policy', 'port', 'ports', 'position', 'prepare', 'preserve', 'private', 'process',
  'processing', 'processor', 'program', 'project', 'projects', 'property', 'protected', 'provide',
  'provider', 'public', 'purpose', 'put', 'py', 'python', 'query', 'range', 'raw', 'read', 'reader',
  'ready', 'record', 'records', 'ref', 'reference', 'references', 'register', 'registry', 'remove',
  'reusable', 'request', 'require', 'required', 'reset', 'resolve', 'resolver', 'resource', 'response',
  'result', 'results', 'return', 'returns', 'root', 'route', 'router', 'row', 'rs', 'run', 'runner',
  'runtime', 'rust', 'save', 'sbyte', 'scope', 'search', 'select', 'self', 'send', 'service', 'services',
  'session', 'set', 'setting', 'settings', 'short', 'should', 'simple', 'single', 'size', 'slice',
  'source', 'sources', 'spec', 'start', 'state', 'static', 'status', 'step', 'stop', 'store', 'str',
  'string', 'stringcomparer', 'struct', 'sub', 'submit', 'subsystem', 'support', 'supports', 'system',
  'table', 'target', 'targets', 'task', 'tasks', 'template', 'test', 'tests', 'text', 'that', 'the',
  'then', 'this', 'thread', 'through', 'throw', 'throws', 'time', 'timeout', 'timespan', 'timestamp',
  'title', 'to', 'token', 'tokens', 'tool', 'tools', 'tostring', 'total', 'trace', 'trait', 'true', 'try',
  'ts', 'tuple', 'type', 'types', 'typescript', 'uint', 'ulong', 'unit', 'unknown', 'update', 'uri', 'url',
  'use', 'user', 'using', 'ushort', 'util', 'utility', 'utils', 'val', 'valid', 'validate', 'validator',
  'value', 'values', 'valuetask', 'var', 'version', 'view', 'views', 'virtual', 'void', 'wait', 'when',
  'where', 'while', 'with', 'without', 'work', 'worker', 'workspace', 'wrap', 'wrapper', 'write', 'writer',
  // Common Chinese stop words in requirement descriptions
  '实现', '提供', '支持', '模块', '功能', '接口', '方法', '以及', '或者', '并且', '包括', '用于', '负责',
  '需要', '处理', '管理', '系统', '服务', '核心', '目标', '工程', '项目', '语言', '代码', '可复用', '通过',
]);

function distinctMeaningfulTerms(text: string, maxTerms = 16): string[] {
  const raw = tokenizeSag2Text(text, false);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of raw) {
    const lower = token.toLowerCase();
    if (lower.length < 2 || genericBridgeStopWords.has(lower) || /^\d+$/.test(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(lower);
    if (result.length >= maxTerms) break;
  }
  return result;
}

/**
 * Decompose a ModuleTarget and user requirement into discrete, bounded
 * responsibilities for JEV contextual evidence evaluation.
 */
export function extractTargetResponsibilities(
  target: ModuleTarget,
  requirement: string,
  maxResponsibilities = 8,
): Sag2Responsibility[] {
  const rawClauses: string[] = [];

  if (requirement.trim()) {
    const reqClauses = requirement
      .split(/(?:[\r\n；;。]+|(?:\s+(?:以及|并且|同时|and|plus)\s+))/iu)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length >= 3);
    rawClauses.push(...reqClauses);
  }

  for (const api of (target.module?.coreApis ?? []).slice(0, 12)) {
    const cleaned = api.trim();
    if (cleaned) rawClauses.push(cleaned);
  }

  const descriptive = [target.module?.purpose, target.module?.description, target.documentation]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
  if (descriptive) {
    const descClauses = descriptive
      .split(/(?:[\r\n；;。]+|(?:\s+(?:以及|并且|同时)\s+))/iu)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length >= 4);
    rawClauses.push(...descClauses);
  }

  if (rawClauses.length === 0) {
    rawClauses.push(`${target.name} ${target.signature}`.trim());
  }

  const responsibilities: Sag2Responsibility[] = [];
  const seenSignatures = new Set<string>();

  for (const clause of rawClauses) {
    const terms = distinctMeaningfulTerms(clause, 12);
    if (terms.length === 0) continue;
    const signature = [...terms].sort().join('|');
    if (seenSignatures.has(signature)) continue;
    // Skip if a responsibility is already a strict subset of an existing one
    const isRedundant = responsibilities.some((existing) => {
      const existingSet = new Set(existing.terms);
      const overlap = terms.filter((t) => existingSet.has(t)).length;
      return overlap >= Math.ceil(terms.length * 0.85);
    });
    if (isRedundant) continue;
    seenSignatures.add(signature);
    responsibilities.push({
      index: responsibilities.length,
      label: clause.slice(0, 200),
      terms,
    });
    if (responsibilities.length >= maxResponsibilities) break;
  }

  if (responsibilities.length === 0) {
    const fallbackTerms = tokenizeSag2Text(`${target.name} ${requirement}`, true).slice(0, 8);
    responsibilities.push({
      index: 0,
      label: target.name || 'primary-responsibility',
      terms: fallbackTerms.length > 0 ? fallbackTerms : ['module'],
    });
  }

  return responsibilities;
}

function extractCandidateBridgeTokens(
  candidate: SearchCandidate,
  edges: readonly DependencyEdgeRecord[],
  queryTermSet: ReadonlySet<string>,
): string[] {
  const sources: string[] = [];
  if (candidate.sourceModule) {
    sources.push(...(candidate.sourceModule.dependsOn ?? []));
    sources.push(...(candidate.sourceModule.coreApis ?? []).slice(0, 16));
  }
  sources.push(...candidate.dependencies.slice(0, 16));
  for (const edge of edges.slice(0, 32)) {
    if (edge.targetReference) sources.push(edge.targetReference);
    if (edge.targetSymbolKey) sources.push(edge.targetSymbolKey);
    if (edge.targetRelativePath) {
      const base = edge.targetRelativePath.split('/').at(-1)?.replace(/\.[^.]+$/, '');
      if (base) sources.push(base);
    }
  }
  // Also extract PascalCase collaborator identifiers appearing inside preview code
  const previewIdentifiers = candidate.preview.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g) ?? [];
  sources.push(...previewIdentifiers.slice(0, 24));

  const bridge: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const token of distinctMeaningfulTerms(source, 8)) {
      if (queryTermSet.has(token) || seen.has(token)) continue;
      seen.add(token);
      bridge.push(token);
      if (bridge.length >= 16) return bridge;
    }
  }
  return bridge;
}

/**
 * Deterministic Contextual Evidence Judge (JEV) for SAG2.
 * Evaluates Hop-1 candidates against target responsibilities, filters distracting
 * hits, identifies uncovered responsibilities, and extracts associative bridge
 * terms from verified Hop-1 anchor modules and their structural dependencies.
 */
export class StructuralSag2JevJudge implements Sag2JevJudge {
  async evaluate(input: Sag2JevEvaluationInput): Promise<Sag2JevOutcome> {
    input.signal?.throwIfAborted();
    const responsibilities = extractTargetResponsibilities(input.target, input.requirement);
    const allQueryTerms = new Set(responsibilities.flatMap((r) => r.terms));

    const decisions: Sag2CandidateDecision[] = [];
    const coveredSet = new Set<number>();

    for (const candidate of input.candidates) {
      const candidateText = [
        candidate.title,
        candidate.summary,
        candidate.sourceModule?.purpose ?? '',
        candidate.signature,
        candidate.preview.slice(0, 3_000),
      ].join('\n');
      const candidateTokenSet = new Set(
        tokenizeSag2Text(candidateText, true).map((t) => t.toLowerCase()),
      );

      const covers: number[] = [];
      let bestRespScore = 0;

      for (const resp of responsibilities) {
        if (resp.terms.length === 0) continue;
        const matched = resp.terms.filter((term) => candidateTokenSet.has(term));
        const ratio = matched.length / resp.terms.length;
        // A responsibility is covered when at least half of its distinctive terms
        // (or at least 2 distinctive domain terms) appear in the candidate evidence.
        const threshold = resp.terms.length <= 2 ? 0.5 : Math.min(0.5, 2 / resp.terms.length);
        if (ratio >= threshold) {
          covers.push(resp.index);
        }
        if (ratio > bestRespScore) {
          bestRespScore = ratio;
        }
      }

      const baseScore = Math.max(candidate.score.overall, candidate.score.contract, bestRespScore);
      const coverageBonus = responsibilities.length > 0
        ? (covers.length / responsibilities.length) * 0.35
        : 0;
      const score = Math.max(0, Math.min(1, baseScore * 0.65 + coverageBonus));

      const verdict: Sag2EvidenceVerdict =
        score >= 0.45 || covers.length > 0
          ? 'anchor'
          : score >= 0.25
            ? 'supporting'
            : 'irrelevant';

      if (verdict === 'anchor') {
        for (const index of covers) coveredSet.add(index);
      }

      const moduleKey = candidate.sourceModule
        ? `${candidate.sourceModule.repositoryId}\u0000${candidate.sourceModule.analysisRevision}\u0000${candidate.sourceModule.moduleId}`
        : candidate.id;
      const edges = input.dependencyEdges?.get(moduleKey) ?? [];
      const bridgeTerms = verdict !== 'irrelevant'
        ? extractCandidateBridgeTokens(candidate, edges, allQueryTerms)
        : [];

      decisions.push({
        id: candidate.id,
        ...(candidate.sourceModule?.moduleId ? { moduleId: candidate.sourceModule.moduleId } : {}),
        ...(candidate.sourceModule?.repositoryId ? { repositoryId: candidate.sourceModule.repositoryId } : {}),
        score,
        covers,
        verdict,
        bridgeTerms,
      });
    }

    const coveredIndices = [...coveredSet].sort((a, b) => a - b);
    const missingResponsibilities = responsibilities.filter((r) => !coveredSet.has(r.index));

    // Collect top bridge terms from anchor candidates first, then supporting candidates
    const orderedAnchors = [...decisions]
      .filter((d) => d.verdict !== 'irrelevant')
      .sort((a, b) => Number(b.verdict === 'anchor') - Number(a.verdict === 'anchor') || b.score - a.score);

    const aggregatedBridgeTerms: string[] = [];
    const seenBridge = new Set<string>();
    for (const decision of orderedAnchors.slice(0, 6)) {
      for (const term of decision.bridgeTerms) {
        if (seenBridge.has(term)) continue;
        seenBridge.add(term);
        aggregatedBridgeTerms.push(term);
        if (aggregatedBridgeTerms.length >= 20) break;
      }
      if (aggregatedBridgeTerms.length >= 20) break;
    }

    const hop2Queries: Array<{ label: string; query: string; weight: number }> = [];
    if (missingResponsibilities.length > 0) {
      const missingTerms = [...new Set(missingResponsibilities.flatMap((r) => r.terms))].slice(0, 16);
      const combinedQuery = [...missingTerms, ...aggregatedBridgeTerms.slice(0, 12)].join(' ').trim();
      if (combinedQuery) {
        hop2Queries.push({
          label: 'sag2-hop2-missing-responsibility',
          query: combinedQuery,
          weight: 1.0,
        });
      }
    }
    if (aggregatedBridgeTerms.length > 0 && (missingResponsibilities.length > 0 || coveredIndices.length === 0)) {
      hop2Queries.push({
        label: 'sag2-hop2-associative-bridge',
        query: aggregatedBridgeTerms.slice(0, 16).join(' '),
        weight: 0.85,
      });
    }

    return {
      responsibilities,
      decisions,
      coveredIndices,
      missingResponsibilities,
      bridgeTerms: aggregatedBridgeTerms,
      hop2Queries,
    };
  }
}

/**
 * Order candidates by JEV responsibility coverage and evidence score.
 * Promotes complementary candidates that cover distinct uncovered responsibilities
 * into the top slots ahead of redundant duplicates.
 */
export function orderCandidatesByJevCoverage(
  candidates: readonly SearchCandidate[],
  decisions: readonly Sag2CandidateDecision[],
): Array<{ candidate: SearchCandidate; decision: Sag2CandidateDecision; score: number }> {
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const pool = candidates.map((candidate) => {
    const decision = decisionById.get(candidate.id) ?? {
      id: candidate.id,
      score: candidate.score.overall,
      covers: [],
      verdict: 'supporting' as const,
      bridgeTerms: [],
    };
    return { candidate, decision };
  });

  pool.sort((a, b) => b.decision.score - a.decision.score || a.candidate.id.localeCompare(b.candidate.id));

  const covered = new Set<number>();
  const ordered: Array<{ candidate: SearchCandidate; decision: Sag2CandidateDecision; score: number }> = [];

  while (pool.length > 0 && ordered.length < 4) {
    let bestIndex = 0;
    const utility = (entry: (typeof pool)[number]): number => {
      if (ordered.length > 0 && entry.decision.verdict === 'anchor') {
        const newlyCovered = entry.decision.covers.filter((idx) => !covered.has(idx)).length;
        return newlyCovered * entry.decision.score + 0.05 * entry.decision.score;
      }
      return 0.05 * entry.decision.score;
    };
    for (let i = 1; i < pool.length; i++) {
      if (utility(pool[i]!) > utility(pool[bestIndex]!)) {
        bestIndex = i;
      }
    }
    const [selected] = pool.splice(bestIndex, 1);
    ordered.push({ ...selected!, score: selected!.decision.score });
    if (selected!.decision.verdict === 'anchor') {
      for (const idx of selected!.decision.covers) covered.add(idx);
    }
  }

  for (const remaining of pool) {
    ordered.push({ ...remaining, score: remaining.decision.score });
  }

  return ordered;
}
