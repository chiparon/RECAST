import { createHash, randomUUID } from 'node:crypto';
import type { StructuralScanProgress } from '@forexplore/code-indexer';
import {
  type AnalysisRevisionRecord,
  type RepositoryId,
  type RepositoryRevisionScope,
  type StructuralIndex,
} from '@forexplore/contracts';
import type { IndexStore, SourceTextReader } from './index-store.js';
import type { RepositoryRegistry } from './repository-registry.js';
import { platformLocalPath } from './platform-path.js';

export type AnalysisMode = 'full' | 'incremental';

export interface AnalysisProgress {
  stage: StructuralScanProgress['stage'] | 'recover' | 'structural-write' | 'search-projection' | 'activation';
  completed?: number;
  total?: number;
  filesCompleted?: number;
  filesTotal?: number;
}

export interface StructuralScanRequest extends RepositoryRevisionScope {
  root: string;
  mode: AnalysisMode;
  /** Present only for an incremental scan and remains revision-scoped. */
  previousIndex?: StructuralIndex;
  /** Host-normalized repository-relative paths, when a file watcher supplied them. */
  changedPaths?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: StructuralScanProgress) => void;
}

export interface StructuralScanResult {
  parserResources?: { peakWorkerRss: number; peakCombinedRss: number; workers: number };
  index: StructuralIndex;
  /** Immutable source copies used for revision-bound read_source_excerpt. */
  sourceTexts: ReadonlyMap<string, string>;
  sourceReader?: SourceTextReader;
  sourceRevision?: string;
  /** Informational incremental accounting for the host/UI. */
  changedPaths?: string[];
  reusedFileCount?: number;
}

export interface StructuralScanner {
  scan(request: StructuralScanRequest): Promise<StructuralScanResult>;
}

export interface SearchProjection {
  projectFromSource?(index: StructuralIndex, source: SourceTextReader, signal?: AbortSignal,
    onProgress?: (progress: AnalysisProgress) => void): Promise<void>;
  project(
    index: StructuralIndex,
    sourceTexts?: ReadonlyMap<string, string>,
    signal?: AbortSignal,
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<void>;
}

export interface AnalysisCoordinatorClock {
  now(): string;
}

export interface AnalysisCoordinatorOptions {
  clock?: AnalysisCoordinatorClock;
  revisionIdGenerator?: () => string;
  indexerVersion?: string;
}

export interface RunAnalysisRequest {
  repositoryId: RepositoryId;
  mode?: AnalysisMode;
  changedPaths?: string[];
  /**
   * Explicit rebuild. Without it a run whose source hash is unchanged returns the
   * previous revision and never re-projects, which would leave an operator unable
   * to refresh a search projection after an embedding or extraction change.
   */
  rebuild?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
  /** Recheck current source hashes and reuse parsing from a completed failed projection. */
  reuseFailedProjection?: boolean;
}

export interface AnalysisRunResult {
  scope: RepositoryRevisionScope;
  analysisHash: string;
  status: 'ready' | 'degraded';
  sourceRevision?: string;
  changedPaths: string[];
  reusedFileCount: number;
}

function systemClock(): AnalysisCoordinatorClock {
  return { now: () => new Date().toISOString() };
}

function failureHash(repositoryId: string, analysisRevision: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return createHash('sha256').update(`${repositoryId}\u0000${analysisRevision}\u0000${detail}`).digest('hex');
}

function normalizeChangedPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '..')
  ) {
    throw new Error('changedPaths must contain only repository-relative paths.');
  }
  return normalized;
}

/**
 * Owns state transitions, not syntax parsing. The previous active revision is
 * never replaced until the scanner, durable index write, and search projection
 * have all completed successfully.
 */
export class AnalysisCoordinator {
  readonly #clock: AnalysisCoordinatorClock;
  readonly #revisionIdGenerator: () => string;
  readonly #indexerVersion: string;
  readonly #activeRuns = new Set<RepositoryId>();

  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly store: IndexStore,
    private readonly scanner: StructuralScanner,
    private readonly projection: SearchProjection,
    options: AnalysisCoordinatorOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock();
    this.#revisionIdGenerator = options.revisionIdGenerator ?? (() => `analysis-${randomUUID()}`);
    // Bumped from 2.1: the search projection now batches by characters, retries a
    // slow embedding request, and can run the embedding model on the GPU. An
    // unchanged source hash used to short-circuit the whole run (see the early
    // return below), so an index built by the previous projection kept its old
    // vectors forever and no operator action could refresh them.
    this.#indexerVersion = options.indexerVersion ?? 'forexplore-code-intelligence/2.2';
  }

  async run(request: RunAnalysisRequest): Promise<AnalysisRunResult> {
    if (this.#activeRuns.has(request.repositoryId)) {
      throw new Error(`Repository ${request.repositoryId} is already indexing.`);
    }
    this.#activeRuns.add(request.repositoryId);
    try {
      return await this.#run(request);
    } finally {
      this.#activeRuns.delete(request.repositoryId);
    }
  }

  async #run(request: RunAnalysisRequest): Promise<AnalysisRunResult> {
    request.signal?.throwIfAborted();
    const repository = await this.registry.get(request.repositoryId);
    if (!repository) throw new Error(`Repository ${request.repositoryId} is not registered.`);
    const mode = request.mode ?? 'full';
    const changedPaths = [...new Set((request.changedPaths ?? []).map(normalizeChangedPath))].sort();
    if (mode === 'full' && changedPaths.length > 0) {
      throw new Error('changedPaths may only be supplied for incremental analysis.');
    }
    const previousScope = repository.activeRevision
      ? { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision }
      : null;
    const previousRevision = previousScope ? await this.store.getRevision(previousScope) : null;
    const effectiveMode = mode === 'incremental' && previousRevision && previousRevision.indexerVersion !== this.#indexerVersion
      ? 'full' : mode;
    const latest = request.reuseFailedProjection ? (await this.store.listRevisions(repository.repositoryId))[0] : undefined;
    const recoverable = latest?.status === 'failed' && latest.failureStage === 'search-projection' &&
      latest.indexerVersion === this.#indexerVersion ? latest : undefined;
    if (recoverable) request.onProgress?.({ stage: 'recover' });
    const reuseScope = recoverable ?? (effectiveMode === 'incremental' ? previousScope : null);
    const previousIndex = reuseScope
      ? await this.store.getStructuralIndex(reuseScope)
      : null;
    const scanMode = recoverable && previousIndex ? 'incremental' : effectiveMode;
    const analysisRevision = this.#revisionIdGenerator();
    if (!/^[-A-Za-z0-9._]+$/.test(analysisRevision)) {
      throw new Error('Analysis coordinator generated an invalid analysisRevision.');
    }
    const scope: RepositoryRevisionScope = { repositoryId: repository.repositoryId, analysisRevision };
    if (await this.store.getRevision(scope)) {
      throw new Error(`Analysis revision ${analysisRevision} already exists for repository ${repository.repositoryId}.`);
    }
    await this.registry.setAnalysisStatus(repository.repositoryId, 'indexing');

    let building: AnalysisRevisionRecord | null = null;
    let ownsBuildingRevision = false;
    let sourceReader: SourceTextReader | undefined;
    let failureStage: NonNullable<AnalysisRevisionRecord['failureStage']> = 'scan';

    try {
      const scanStarted = performance.now();
      const result = await this.scanner.scan({
        ...scope,
        root: platformLocalPath(repository.localPath),
        mode: scanMode,
        ...(scanMode === 'incremental' && previousIndex ? { previousIndex } : {}),
        ...(scanMode === 'incremental' && changedPaths.length > 0 ? { changedPaths } : {}),
        signal: request.signal,
        onProgress: request.onProgress,
      });
      sourceReader = result.sourceReader;
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'scan', ...scope,
        durationMs: Math.round(performance.now() - scanStarted), files: result.index.files.length,
        symbols: result.index.symbols.length, dependencies: result.index.dependencyEdges.length,
        reusedFiles: result.reusedFileCount ?? 0 }));
      request.signal?.throwIfAborted();
      if (
        result.index.repositoryId !== scope.repositoryId ||
        result.index.analysisRevision !== scope.analysisRevision
      ) {
        throw new Error('Structural scanner returned an index for a different analysis revision.');
      }
      // An explicit rebuild must also rebuild a search projection whose source text
      // did not change: that projection is what an embedding or extraction change
      // invalidates, and returning the previous revision silently kept the old one.
      if (!request.rebuild &&
          previousRevision?.status === 'ready' && previousRevision.indexerVersion === this.#indexerVersion &&
          previousRevision.analysisHash === result.index.analysisHash) {
        const status = result.index.diagnostics.some((item) => item.severity === 'error')
          ? 'degraded' as const : 'ready' as const;
        await this.registry.setAnalysisStatus(repository.repositoryId, status);
        return {
          scope: { repositoryId: repository.repositoryId, analysisRevision: previousRevision.analysisRevision },
          analysisHash: previousRevision.analysisHash, status,
          ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
          changedPaths: [], reusedFileCount: result.reusedFileCount ?? 0,
        };
      }
      const createdAt = this.#clock.now();
      building = {
        ...scope,
        status: 'building',
        analysisHash: result.index.analysisHash,
        ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
        indexerVersion: this.#indexerVersion,
        createdAt,
      };
      await this.store.putRevision(building);
      ownsBuildingRevision = true;
      failureStage = 'structural-write';
      request.onProgress?.({ stage: 'structural-write', completed: 0 });
      const writeStarted = performance.now();
      if (sourceReader && this.store.putStructuralIndexFromSource) {
        await this.store.putStructuralIndexFromSource(result.index, sourceReader, request.signal,
          (completed, total) => request.onProgress?.({ stage: 'structural-write', completed, total }));
      } else {
        if (sourceReader) throw new Error('The index store does not support streamed source persistence.');
        await this.store.putStructuralIndex(result.index, result.sourceTexts);
      }
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'structural-write', ...scope,
        durationMs: Math.round(performance.now() - writeStarted) }));
      const projectionStarted = performance.now();
      failureStage = 'search-projection';
      request.onProgress?.({ stage: 'search-projection', completed: 0 });
      if (sourceReader && this.projection.projectFromSource) {
        // Source bytes have been hash-checked and committed above. Long model
        // projections read that immutable revision, never an OS temp spool.
        const persistedSource: SourceTextReader = {
          read: relativePath => {
            request.signal?.throwIfAborted();
            return this.store.getSourceText(scope, relativePath);
          },
        };
        await this.projection.projectFromSource(result.index, persistedSource, request.signal, request.onProgress);
      } else {
        await this.projection.project(result.index, result.sourceTexts, request.signal, request.onProgress);
      }
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'search-projection', ...scope,
        durationMs: Math.round(performance.now() - projectionStarted) }));
      failureStage = 'activation';
      request.onProgress?.({ stage: 'activation' });
      request.signal?.throwIfAborted();
      const ready: AnalysisRevisionRecord = {
        ...building,
        status: 'ready',
        completedAt: this.#clock.now(),
      };
      await this.store.putRevision(ready);
      const status = result.index.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
        ? 'degraded' as const
        : 'ready' as const;
      await this.store.activateRevision(scope, status);
      return {
        scope,
        analysisHash: result.index.analysisHash,
        status,
        ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
        changedPaths: result.changedPaths ?? changedPaths,
        reusedFileCount: result.reusedFileCount ?? 0,
      };
    } catch (error) {
      const recordedFailure = await this.#recordFailure({
        scope,
        error,
        building,
        ownsBuildingRevision,
        failureStage,
      });
      try {
        await this.registry.setAnalysisStatus(
          repository.repositoryId,
          recordedFailure ? 'failed' : repository.analysisStatus,
        );
      } catch {
        // The source failure remains the actionable error. A transient status
        // write must never cause a coordinator retry to overwrite a revision.
      }
      throw error;
    } finally {
      await sourceReader?.dispose?.();
    }
  }

  async #recordFailure(input: {
    scope: RepositoryRevisionScope;
    error: unknown;
    building: AnalysisRevisionRecord | null;
    ownsBuildingRevision: boolean;
    failureStage: NonNullable<AnalysisRevisionRecord['failureStage']>;
  }): Promise<boolean> {
    const failureReason = input.error instanceof Error ? input.error.message : String(input.error);
    let ownsBuildingRevision = input.ownsBuildingRevision;
    try {
      if (!ownsBuildingRevision) {
        // Scans can fail before an evidence hash is available. Still leave an
        // auditable lifecycle row, but only if this coordinator owns the ID;
        // a collision must never mutate another run's revision.
        const existing = await this.store.getRevision(input.scope);
        if (!existing) {
          const failureBuilding: AnalysisRevisionRecord = {
            ...input.scope,
            status: 'building',
            analysisHash: failureHash(input.scope.repositoryId, input.scope.analysisRevision, input.error),
            indexerVersion: this.#indexerVersion,
            createdAt: this.#clock.now(),
          };
          await this.store.putRevision(failureBuilding);
          ownsBuildingRevision = true;
        } else if (
          input.building &&
          existing.status === 'building' &&
          existing.analysisHash === input.building.analysisHash &&
          existing.createdAt === input.building.createdAt &&
          existing.indexerVersion === input.building.indexerVersion &&
          existing.sourceRevision === input.building.sourceRevision
        ) {
          // If a durable insert committed but its acknowledgement was lost,
          // the exact immutable build identity proves it is safe to finalize
          // this coordinator's row as failed. A differing collision remains
          // untouched.
          ownsBuildingRevision = true;
        }
      }
      if (!ownsBuildingRevision) return false;
      const current = await this.store.getRevision(input.scope);
      if (!current || current.status !== 'building') return false;
      await this.store.putRevision({
        ...current,
        status: 'failed',
        completedAt: this.#clock.now(),
        failureReason,
        failureStage: input.failureStage,
      });
      return true;
    } catch {
      // Keep the original scan/index/projection error. The store transition is
      // intentionally best-effort if the backing database itself is down.
      return false;
    }
  }
}

export const analysisCoordinatorInternals = { failureHash, normalizeChangedPath };
