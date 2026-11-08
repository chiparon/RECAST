import type {
  DependencyEdgeRecord,
  ModuleTarget,
  SearchCandidate,
} from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import {
  rerankModuleCandidates,
  searchModules,
  type ModuleMatchRequest,
  type ModuleRecallObservation,
} from './module-matching.js';
import type { ModuleReranker } from './module-reranker.js';
import { RecallKernel, type RecallPlan } from './recall-kernel.js';
import { buildModuleSearchQuery, resolveModuleRetrievalTarget } from './module-search-query.js';
import { moduleSearchBudgetMs } from './seekdb-timeouts.js';
import {
  orderCandidatesByJevCoverage,
  StructuralSag2JevJudge,
  type Sag2CandidateDecision,
  type Sag2JevJudge,
  type Sag2Responsibility,
} from './sag2-jev.js';

export interface Sag2RetrievalDiagnostics {
  hopsExecuted: number;
  hop1CandidateCount: number;
  hop2CandidateCount: number;
  hop2NewlyDiscoveredIds: string[];
  responsibilities: Sag2Responsibility[];
  coveredIndices: number[];
  missingResponsibilities: Sag2Responsibility[];
  bridgeTerms: string[];
  hop2Queries: Array<{ label: string; query: string; weight: number }>;
  decisions: Sag2CandidateDecision[];
}

export interface Sag2SearchOptions {
  /** Maximum retrieval hops (1..3, default 2). */
  maxHops?: number;
  /** Custom JEV contextual evidence judge; defaults to StructuralSag2JevJudge. */
  jevJudge?: Sag2JevJudge;
  /** Optional final reranker applied after JEV multi-hop evidence fusion. */
  reranker?: ModuleReranker;
  /** RecallKernel instance; defaults to a new RecallKernel(store). */
  recall?: RecallKernel;
  /** Force Hop-2 associative expansion whenever bridge terms exist, even if Hop-1 covered initial clauses. */
  expandOnBridgeTerms?: boolean;
  /** Diagnostic observer for multi-hop inspection and benchmarking. */
  observeDiagnostics?: (diagnostics: Readonly<Sag2RetrievalDiagnostics>) => void;
  /** Recall observer across hops. */
  observeRecall?: (hits: readonly ModuleRecallObservation[]) => void;
}

async function collectCandidateDependencyEdges(
  store: IndexStore,
  candidates: readonly SearchCandidate[],
  signal?: AbortSignal,
): Promise<Map<string, readonly DependencyEdgeRecord[]>> {
  const result = new Map<string, readonly DependencyEdgeRecord[]>();
  if (!store.queryDependencies) return result;

  for (const candidate of candidates.slice(0, 6)) {
    signal?.throwIfAborted();
    const sm = candidate.sourceModule;
    const sourceFiles = sm?.sourceFiles ?? [];
    if (!sm || sourceFiles.length === 0) continue;
    const key = `${sm.repositoryId}\u0000${sm.analysisRevision}\u0000${sm.moduleId}`;
    if (result.has(key)) continue;
    try {
      const { dependencies } = await store.queryDependencies(
        { repositoryId: sm.repositoryId, analysisRevision: sm.analysisRevision },
        {
          projectId: sm.projectId,
          relativePaths: sourceFiles.slice(0, 64),
          direction: 'outgoing',
          limit: 64,
        },
        signal,
      );
      result.set(key, dependencies);
    } catch {
      signal?.throwIfAborted();
      // Structural dependency enrichment is best-effort and must never fail recall.
    }
  }
  return result;
}

/**
 * SAG2 Bounded Multi-Hop Retrieval (`BM25 + JEV + Query-Time Association`).
 *
 * 1. Hop 1 recalls initial candidate modules via multi-view lexical/BM25 plans.
 * 2. JEV evaluates candidate evidence against decomposed target responsibilities,
 *    identifies uncovered responsibilities, and extracts associative bridge terms
 *    from Hop-1 anchor modules (`dependsOn`, `coreApis`, and structural dependency edges).
 * 3. When uncovered responsibilities or bridge terms exist, Hop 2 executes a
 *    targeted associative BM25 query to retrieve complementary modules missed in Hop 1.
 * 4. Merges Hop-1 and Hop-2 candidates and orders them by JEV responsibility coverage.
 */
export async function searchModulesWithSag2(
  store: IndexStore,
  request: ModuleMatchRequest,
  signal?: AbortSignal,
  options: Sag2SearchOptions = {},
): Promise<SearchCandidate[]> {
  const maxHops = options.maxHops ?? 2;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 3) {
    throw new Error('SAG2 maxHops must be an integer between 1 and 3.');
  }
  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 10) {
    throw new Error('Module search topK must be between 1 and 10.');
  }

  const recall = options.recall ?? new RecallKernel(store);
  const jevJudge = options.jevJudge ?? new StructuralSag2JevJudge();
  const resolvedTarget: ModuleTarget = await resolveModuleRetrievalTarget(store, request.target, signal);

  // Hop 1: Retrieve broader candidate pool (up to 10) before JEV filtering
  const hop1PoolTopK = Math.min(10, Math.max(request.topK, 8));
  const recallObservations: ModuleRecallObservation[] = [];
  const hop1Candidates = await searchModules(
    store,
    { ...request, target: resolvedTarget, topK: hop1PoolTopK },
    signal,
    undefined,
    recall,
    undefined,
    undefined,
    (hits) => recallObservations.push(...hits),
  );

  const dependencyEdges = await collectCandidateDependencyEdges(store, hop1Candidates, signal);
  const hop1Jev = await jevJudge.evaluate({
    target: resolvedTarget,
    requirement: request.requirement,
    candidates: hop1Candidates,
    dependencyEdges,
    signal,
  });

  let hopsExecuted = 1;
  let hop2Candidates: SearchCandidate[] = [];
  const hop2NewlyDiscoveredIds: string[] = [];
  const combinedMap = new Map<string, SearchCandidate>();
  for (const candidate of hop1Candidates) {
    combinedMap.set(candidate.id, candidate);
  }

  const shouldRunHop2 =
    maxHops >= 2 &&
    (hop1Jev.missingResponsibilities.length > 0 ||
      hop1Jev.coveredIndices.length === 0 ||
      (options.expandOnBridgeTerms === true && hop1Jev.bridgeTerms.length > 0)) &&
    (hop1Jev.hop2Queries.length > 0 || hop1Jev.bridgeTerms.length > 0);

  if (shouldRunHop2) {
    hopsExecuted = 2;
    const bridgeQueryText = [
      ...hop1Jev.missingResponsibilities.map((r) => r.label),
      ...hop1Jev.bridgeTerms,
    ].join('\n');

    const hop2Plans: RecallPlan[] = hop1Jev.hop2Queries.length > 0
      ? hop1Jev.hop2Queries.flatMap((q) => [
          { label: `${q.label}-summary`, query: q.query, views: ['summary'] as const, weight: q.weight },
          { label: `${q.label}-symbol`, query: q.query, views: ['symbol'] as const, weight: q.weight * 0.85 },
          { label: `${q.label}-fragment`, query: q.query, views: ['source-fragment'] as const, weight: q.weight * 0.75 },
        ])
      : [
          { label: 'sag2-hop2-bridge-summary', query: bridgeQueryText, views: ['summary'] as const, weight: 1.0 },
          { label: 'sag2-hop2-bridge-symbol', query: bridgeQueryText, views: ['symbol'] as const, weight: 0.85 },
        ];

    // Construct a synthetic Hop-2 target enriched with bridge terms so API matching scores Hop-2 collaborators
    const hop2Target: ModuleTarget = {
      ...resolvedTarget,
      documentation: [resolvedTarget.documentation ?? '', bridgeQueryText].filter(Boolean).join('\n'),
      ...(resolvedTarget.module
        ? {
            module: {
              ...resolvedTarget.module,
              description: [resolvedTarget.module.description, bridgeQueryText].filter(Boolean).join('\n'),
              coreApis: [...new Set([...(resolvedTarget.module.coreApis ?? []), ...hop1Jev.bridgeTerms.slice(0, 12)])],
            },
          }
        : {}),
    };

    hop2Candidates = await searchModules(
      store,
      {
        ...request,
        target: hop2Target,
        requirement: `${request.requirement}\n${bridgeQueryText}`.trim().slice(0, 8_000),
        topK: hop1PoolTopK,
      },
      signal,
      undefined,
      recall,
      undefined,
      undefined,
      (hits) => recallObservations.push(...hits),
      hop2Plans,
    );

    for (const candidate of hop2Candidates) {
      const existing = combinedMap.get(candidate.id);
      if (!existing) {
        hop2NewlyDiscoveredIds.push(candidate.id);
        combinedMap.set(candidate.id, candidate);
      } else if (candidate.score.overall > existing.score.overall) {
        combinedMap.set(candidate.id, {
          ...existing,
          score: {
            ...existing.score,
            overall: Math.max(existing.score.overall, candidate.score.overall),
            contract: Math.max(existing.score.contract, candidate.score.contract),
          },
        });
      }
    }
  }

  const combinedCandidates = [...combinedMap.values()];
  const allEdges = hopsExecuted > 1
    ? await collectCandidateDependencyEdges(store, combinedCandidates, signal)
    : dependencyEdges;

  const finalJev = hopsExecuted > 1
    ? await jevJudge.evaluate({
        target: resolvedTarget,
        requirement: request.requirement,
        candidates: combinedCandidates,
        dependencyEdges: allEdges,
        signal,
      })
    : hop1Jev;

  const orderedByJev = orderCandidatesByJevCoverage(combinedCandidates, finalJev.decisions);
  let finalCandidates: SearchCandidate[] = orderedByJev.map(({ candidate, decision, score }) => ({
    ...candidate,
    score: {
      ...candidate.score,
      overall: score,
    },
    ...(candidate.moduleMatch
      ? {
          moduleMatch: {
            ...candidate.moduleMatch,
            reranker: {
              model: `sag2-jev:${decision.verdict}`,
              score,
            },
          },
        }
      : {}),
  }));

  if (options.reranker && finalCandidates.length > 0) {
    const timeout = AbortSignal.timeout(moduleSearchBudgetMs);
    const rankSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const { rerankQuery } = buildModuleSearchQuery(resolvedTarget, request.requirement);
      finalCandidates = await rerankModuleCandidates(options.reranker, rerankQuery, finalCandidates, rankSignal);
    } catch {
      rankSignal.throwIfAborted();
    }
  }

  signal?.throwIfAborted();
  const currentRevisions = new Map(await Promise.all([...new Set(combinedCandidates.flatMap(
    candidate => candidate.sourceModule ? [candidate.sourceModule.repositoryId] : [],
  ))].map(async id => [id, (await store.getRepository(id, signal))?.activeRevision] as const)));
  if (combinedCandidates.some(({ sourceModule }) => sourceModule &&
    currentRevisions.get(sourceModule.repositoryId) !== sourceModule.analysisRevision)) {
    throw new Error('Repository revision changed during SAG2 module search; retry against the current snapshot.');
  }

  try {
    options.observeRecall?.(recallObservations);
  } catch {
    // Diagnostic observer must never fail search
  }

  const diagnostics: Sag2RetrievalDiagnostics = {
    hopsExecuted,
    hop1CandidateCount: hop1Candidates.length,
    hop2CandidateCount: hop2Candidates.length,
    hop2NewlyDiscoveredIds,
    responsibilities: finalJev.responsibilities,
    coveredIndices: finalJev.coveredIndices,
    missingResponsibilities: finalJev.missingResponsibilities,
    bridgeTerms: hop1Jev.bridgeTerms,
    hop2Queries: hop1Jev.hop2Queries,
    decisions: finalJev.decisions,
  };

  try {
    options.observeDiagnostics?.(Object.freeze(diagnostics));
  } catch {
    // Diagnostic observer must never fail search
  }

  return finalCandidates.slice(0, request.topK);
}
