import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import path from 'node:path';
import type {
  AnalysisRevisionRecord,
  ModuleArtifactRecord,
  ModuleTarget,
  ModuleHierarchyPlanner,
  RepositoryId,
  RepositoryRecord,
  RepositoryRole,
  RepositoryAnalysisStatus,
  RepositoryRevisionScope,
  RepositoryStaticAnalysis,
  SearchCandidate,
  ProjectId,
  ProjectRecord,
  ProjectAnalysisPort, ProjectAnalysisResult, ProjectAnalysisScope, ProjectAnalysisRecord,
  StructuralIndex,
} from '@forexplore/contracts';
import type { SemanticQueryPort } from '@forexplore/workflow-core';
import type {
  CodeIntelligencePresentation,
  CodeIntelligenceRepositoryPresentation,
  CodeIntelligenceSummaryPresentation,
} from './ui-types';
import { projectAnalysisPresentation } from './project-analysis-presentation';
import { MAX_RETRIEVAL_SCOPES, MAX_SELECTED_HISTORY_MODULES, type WorkspaceEvidenceScope, type WorkspaceHistoryCandidate, type WorkspaceHistoryView } from '@forexplore/contracts';
import type { ModuleReranker } from '../../../services/code-intelligence-service/src/module-reranker';
import { platformLocalPath, repositoryPathIdentity } from '../../../services/code-intelligence-service/src/platform-path';
import { createIndexingProgressReporter, indexingProgressMessage, isIndexingCancellation,
  type IndexingProgress, type RepositoryIndexingProgress } from './indexing-progress';

/**
 * A history-view is evidence for one module, not a checkout of the whole
 * historical subsystem. Keep the view small enough that an Analyzer cannot
 * accidentally spend its entire context on a bulk `cat` command. The first
 * source file is retained when it fits the byte budget; oversized entry files
 * must not defeat that budget.
 */
export const HISTORY_VIEW_MAX_FILES = 8;
// This limits materialized observations, not automatic prompt injection. Allow
// a normal implementation file with its contracts; the Analyzer still reads a
// focused sample instead of loading every available source into its context.
export const HISTORY_VIEW_MAX_BYTES = 256_000;

export interface HistoryModuleSelection {
  repositoryId: RepositoryId;
  analysisRevision: string;
  projectId?: ProjectId;
  moduleId: string;
  sourceFiles: readonly string[];
  preferredFiles?: readonly string[];
  relevanceTerms?: readonly string[];
  name?: string;
  language?: string;
}

const historyPathStopWords = new Set(['src', 'main', 'test', 'tests', 'java', 'csharp', 'cs', 'com', 'org', 'net', 'example']);

function historyTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !historyPathStopWords.has(token));
}

function historyFileRelevance(file: string, terms: readonly string[]): number {
  const normalized = file.toLowerCase();
  // Score the basename rather than the whole path. A module-level directory
  // term (for example `Nop.Core.Infrastructure`) is shared by every file and
  // must not make all candidates tie before the size fallback is applied.
  const basename = normalized.split('/').at(-1) ?? normalized;
  const compactPath = basename.replace(/[^a-z0-9]+/g, '');
  const fileTokens = new Set(historyTokens(basename));
  let score = 0;
  for (const term of terms) {
    const compactTerm = term.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (compactTerm.length >= 4 && compactPath.includes(compactTerm)) score += 10;
    const tokens = historyTokens(term);
    if (!tokens.length) continue;
    const matches = tokens.filter((token) => fileTokens.has(token)).length;
    score += matches / tokens.length;
  }
  return score;
}

export function boundHistoryViewFiles(
  files: readonly string[],
  sizes: ReadonlyMap<string, number>,
  maxFiles = HISTORY_VIEW_MAX_FILES,
  maxBytes = HISTORY_VIEW_MAX_BYTES,
  relevanceTerms: readonly string[] = [],
): string[] {
  const unique = [...new Set(files)];
  if (!unique.length) return [];
  const firstSize = Math.max(0, sizes.get(unique[0]!) ?? 0);
  const selected: string[] = firstSize <= maxBytes ? [unique[0]!] : [];
  let bytes = selected.length ? firstSize : 0;
  const ranked = unique.slice(1).map((file, index) => ({ file, index, score: historyFileRelevance(file, relevanceTerms), size: Math.max(0, sizes.get(file) ?? 0) }));
  if (ranked.some((item) => item.score > 0)) {
    ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  }
  for (const { file, size } of ranked) {
    if (selected.length >= maxFiles) break;
    if (bytes + size > maxBytes) continue;
    selected.push(file);
    bytes += size;
  }
  return selected;
}

/** Local-only SeekDB configuration; credentials never cross a UI boundary. */
export interface SeekDbRuntimeConfig {
  initialization?: { onProgress?: (progress: {
    stage: 'waiting' | 'initializing' | 'migrating' | 'ready'; message: string; migration?: number;
  }) => void; timeoutMs?: number };
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  vectorDimension?: number;
  /**
   * `variant` names the inference device and precision that produced the vectors
   * ("dml-fp16"). It is part of the embedding identity, so declaring a different
   * variant makes the store re-embed instead of reusing vectors from the other
   * provider.
   */
  embedding?: { url: string; apiKey: string; model: string; supportsDimensions?: boolean; queryPrefix?: string;
    documentPrefix?: string; variant?: string };
}

/** The narrow host composition input intentionally excludes scanners/DB handles from callers. */
export interface CreateCodeIntelligenceRuntimeOptions {
  seekdb?: SeekDbRuntimeConfig;
  moduleReranker?: { url: string; model: string; timeoutMs?: number };
  moduleCandidateReranker?: ModuleReranker;
}

export interface CodeIntelligenceEnvironmentOptions {
  /** Production hosts require an explicit SeekDB database; dev/test may opt into transient storage. */
  allowInMemory?: boolean;
}

interface HostIndexStore {
  getRevision(scope: RepositoryRevisionScope): Promise<AnalysisRevisionRecord | null>;
  getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null>;
  getStructuralIndexMetadata?(scope: RepositoryRevisionScope): Promise<Pick<StructuralIndex, 'repositoryId' | 'analysisRevision' | 'analysisHash'> | null>;
  listProjects?(scope: RepositoryRevisionScope): Promise<ProjectRecord[]>;
  listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]>;
  listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]>;
  putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void>;
}

interface HostRepositoryRegistry {
  get(repositoryId: RepositoryId): Promise<RepositoryRecord | null>;
  list?(): Promise<RepositoryRecord[]>;
  unregister?(repositoryId: RepositoryId): Promise<void>;
  /**
   * Optional so a minimal registry stays valid. When present, the host
   * publishes the lifecycle transitions that make a long scan observable.
   */
  setAnalysisStatus?(
    repositoryId: RepositoryId,
    analysisStatus: RepositoryAnalysisStatus,
  ): Promise<RepositoryRecord>;
  register(request: {
    repositoryId: RepositoryId;
    displayName?: string;
    localPath: string;
    role: RepositoryRole;
  }): Promise<RepositoryRecord>;
}

interface HostAnalysisCoordinator {
  run(request: { repositoryId: RepositoryId; mode: 'full' | 'incremental'; signal?: AbortSignal;
    onProgress?: (progress: IndexingProgress) => void; reuseFailedProjection?: boolean }): Promise<unknown>;
}

interface HostJavaCsharpSpecializedProvider {
  register(binding: RepositoryRevisionScope & {
    analysisHash: string;
    analysis: RepositoryStaticAnalysis;
  }): Promise<void>;
}

/**
 * Structural typing keeps VS Code's typecheck out of the service source tree.
 * Runtime composition is still the actual code-intelligence service bundle.
 */
export interface CodeIntelligenceRuntime {
  store: HostIndexStore;
  registry: HostRepositoryRegistry;
  coordinator: HostAnalysisCoordinator;
  /** Trusted host bridge for legacy compiler-probe evidence; never expose it to Agent/MCP callers. */
  javaCsharpSpecializedProvider?: HostJavaCsharpSpecializedProvider;
  queryPort: SemanticQueryPort;
  projectAnalysis?: ProjectAnalysisPort;
  moduleImplementationSearch?: {
    search(request: {
      target: ModuleTarget;
      requirement: string;
      topK: number;
      repositoryIds: readonly RepositoryId[];
    }, signal?: AbortSignal, reranker?: ModuleReranker): Promise<SearchCandidate[]>;
  };
  close(): Promise<void>;
}

interface CodeIntelligenceServiceModule {
  ProjectAnalysisCoordinator: new (options: {
    store: HostIndexStore;
    plan?(scope: ProjectAnalysisScope & { objective: string }): Promise<ProjectAnalysisResult>;
    hierarchyPlanner?: ModuleHierarchyPlanner;
    allowLargeAgentPlan?: boolean;
    onChange?(): void;
  }) => ProjectAnalysisPort;
  createCodeIntelligenceRuntime(
    options: CreateCodeIntelligenceRuntimeOptions,
  ): Promise<CodeIntelligenceRuntime>;
  SeekDbProjection: new (store: HostIndexStore) => {
    projectModuleArtifacts(index: StructuralIndex, signal?: AbortSignal): Promise<void>;
  };
  createSemanticQueryHttpServer(options: {
    queryPort: SemanticQueryPort;
    bearerToken?: string;
  }): Server;
}

let loadedCodeIntelligenceService: CodeIntelligenceServiceModule | undefined;

function codeIntelligenceService(): CodeIntelligenceServiceModule {
  // Keep test/UI typechecking independent from the service's source-level
  // ESM imports. The actual service is loaded only by the trusted host path.
  loadedCodeIntelligenceService ??= require('@forexplore/code-intelligence-service') as CodeIntelligenceServiceModule;
  return loadedCodeIntelligenceService;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

/**
 * Minimal persistence surface supplied by VS Code's globalState.  IDs are
 * deliberately keyed by a digest of a local path, and no local path ever
 * appears in a presentation returned from this host.
 */
export interface RepositoryIdentityStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: string): PromiseLike<void>;
}

export type CodeIntelligenceRuntimeFactory = (
  options: CreateCodeIntelligenceRuntimeOptions,
) => Promise<CodeIntelligenceRuntime>;

export interface CodeIntelligenceHostOptions {
  projectAnalysisPort?: ProjectAnalysisPort;
  /** The host supplied a bounded complete plan and it may cover a large repository. */
  allowLargeAgentPlan?: boolean;
  planProject?: (scope: ProjectAnalysisScope & { objective: string }) => Promise<ProjectAnalysisResult>;
  hierarchyPlanner?: ModuleHierarchyPlanner;
  onChange?: () => void;
  /**
   * Module analysis calls a model, so the trusted host refuses it while this
   * returns a reason (e.g. no API Key in the settings). Indexing, symbols and
   * source search are unaffected by a refusal.
   */
  modelKeyRefusal?: () => Promise<string | undefined>;
  /** Surfaces a refusal to the user; called once per refused scheduling attempt. */
  onModelRefusal?: (reason: string) => void;
  /**
   * The VS Code host owns this composition.  It can use SeekDB when its local
   * process environment has been configured, but it is never created by a
   * webview, MCP tool, or Agent request.
   */
  runtimeOptions?: CreateCodeIntelligenceRuntimeOptions;
  runtimeFactory?: CodeIntelligenceRuntimeFactory;
  identityStore?: RepositoryIdentityStore;
  /** Initial project choices for a read-only preloaded workbench. */
  initialSelectedProjects?: ReadonlyMap<RepositoryId, ProjectId>;
  output?: { appendLine(value: string): void };
  storageKind?: 'seekdb' | 'memory';
  now?: () => string;
  /** Test seam; production uses the service-owned SeekDB projection. */
  projectModuleArtifacts?: (
    runtime: CodeIntelligenceRuntime,
    index: StructuralIndex,
  ) => Promise<void>;
  /** Test seam; production uses the code-intelligence service transport. */
  semanticQueryServerFactory?: (options: {
    queryPort: SemanticQueryPort;
    bearerToken?: string;
  }) => Server;
}

export interface CodeIntelligenceRepositoryInput {
  localPath: string;
  displayName?: string;
  role: RepositoryRole;
  /** Preloaded windows may remap a persisted path across Windows and WSL. */
  repositoryId?: RepositoryId;
}

export interface SynchronizeCodeIntelligenceRequest {
  signal?: AbortSignal;
  onProgress?: (progress: RepositoryIndexingProgress) => void;
  scanRepositoryIds?: readonly string[];
  /** Automatic history initialization must not crawl unrelated workspace targets. */
  scanRoles?: readonly RepositoryRole[];
  /** Settings changes initialize newly visible roots without rescanning existing ones. */
  scanNewOnly?: boolean;
  repositories: readonly CodeIntelligenceRepositoryInput[];
  /** Full is useful for an explicit user refresh; ordinary refreshes reuse unchanged files. */
  forceFull?: boolean;
  /** Registration-only requests are useful for a lightweight status refresh. */
  scan?: boolean;
  /** Resume project modelling from existing indexes, even when scanning is disabled or restricted by role. */
  resumeProjectAnalysis?: boolean;
  /**
   * A prebuilt corpus can contain a stale registry "indexing" flag while its
   * active immutable revision is already ready. Repair that presentation-only
   * lifecycle flag during registration without crawling source files.
   */
  repairStaleIndexing?: boolean;
}

export interface CodeIntelligenceSynchronizationResult {
  presentation: CodeIntelligencePresentation;
  scannedRepositoryIds: RepositoryId[];
  failedRepositoryIds: RepositoryId[];
}

/**
 * Webview-facing revision intent. The host resolves both opaque IDs against
 * its own registry/store; it never accepts a local path or changes the
 * repository's active revision in response to this request.
 */
export interface SelectCodeIntelligenceRevisionRequest extends RepositoryRevisionScope {}

export interface PublishModuleSummaryRequest extends RepositoryRevisionScope {
  analysisHash: string;
  planHash: string;
  /** Already host-validated summary/plan data. It is never accepted from a Webview. */
  payload: unknown;
  contentHash?: string;
}

/**
 * Local-path input for the trusted host bridge only.  The result deliberately
 * contains revision identifiers but never echoes the root back to a caller.
 */
export interface BindJavaCsharpCompilerProbeEvidenceRequest {
  localPath: string;
  analysis: RepositoryStaticAnalysis;
}

export interface JavaCsharpCompilerProbeBindingResult {
  status: 'bound' | 'skipped';
  repositoryId?: RepositoryId;
  analysisRevision?: string;
}

const identityKeyPrefix = 'forexplore.code-intelligence.repository-id';
const selectedProjectKeyPrefix = 'forexplore.code-intelligence.selected-project';
/** The indexer's grouping for files no manifest claims (`project-discovery.ts`). */
const unattributedProjectKind = 'directory';

function defaultRuntimeFactory(
  options: CreateCodeIntelligenceRuntimeOptions,
): Promise<CodeIntelligenceRuntime> {
  return codeIntelligenceService().createCodeIntelligenceRuntime(options);
}

function stableIdentityKey(localPath: string): string {
  const normalized = repositoryPathIdentity(path.resolve(platformLocalPath(localPath)));
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `${identityKeyPrefix}:${digest}`;
}

function selectedProjectKey(repositoryId: RepositoryId): string {
  return `${selectedProjectKeyPrefix}:${repositoryId}`;
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function genericRuntimeFailure(): string {
  return '代码智能索引运行时不可用；请检查本机索引配置和输出日志。';
}

function memoryStorageNotice(): string {
  return '代码智能索引正在使用非持久的内存开发存储；配置 CODE_INTELLIGENCE_SEEKDB_DATABASE 以启用 SeekDB。';
}

function repositoryInputKey(input: CodeIntelligenceRepositoryInput): string {
  const normalized = path.resolve(input.localPath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeHistoryPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
      ['.env', '.env.local', '.env.production', '.npmrc', 'id_rsa', 'id_ed25519'].includes(normalized.split('/').at(-1)!.toLowerCase())) {
    throw new Error(`历史候选文件路径无效：${value}`);
  }
  return normalized;
}

async function safeHistoryFile(root: string, relative: string): Promise<string> {
  const candidate = path.resolve(root, ...relative.split('/'));
  const resolvedRoot = await realpath(root);
  const resolvedParent = await realpath(path.dirname(candidate));
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(prefix)) {
    throw new Error(`历史候选文件越界：${relative}`);
  }
  return candidate;
}

async function removeHistoryView(root: string): Promise<void> {
  async function makeWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
    }
  }
  await makeWritable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function chmodReadonlyTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`历史视图出现符号链接：${entry.name}`);
    if (entry.isDirectory()) await chmodReadonlyTree(child);
    await chmod(child, entry.isDirectory() ? 0o555 : 0o444);
  }
  await chmod(root, 0o555);
}

/** A presentation name is a label, never a second local-path channel. */
function safeRepositoryDisplayName(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  const leaf = normalized.split('/').filter(Boolean).at(-1)?.trim();
  if (!leaf || leaf === '.' || leaf === '..') return 'repository';
  return leaf.slice(0, 160);
}

function preferredRepositoryInputs(
  inputs: readonly CodeIntelligenceRepositoryInput[],
): CodeIntelligenceRepositoryInput[] {
  const byPath = new Map<string, CodeIntelligenceRepositoryInput>();
  for (const input of inputs) {
    if (!input.localPath.trim()) continue;
    const key = repositoryInputKey(input);
    const current = byPath.get(key);
    // A workspace target has a stronger role than the same root configured as
    // a historical corpus.  This makes both paths use one registry record.
    if (!current || input.role === 'target') byPath.set(key, input);
  }
  return [...byPath.values()].sort((left, right) =>
    repositoryInputKey(left).localeCompare(repositoryInputKey(right)),
  );
}

function summaryArtifact(
  artifacts: readonly ModuleArtifactRecord[],
  revision: AnalysisRevisionRecord,
): ModuleArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => (
      artifact.kind === 'module-summary' &&
      artifact.status === 'current' &&
      artifact.analysisHash === revision.analysisHash &&
      Boolean(artifact.planHash)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function latestSummaryArtifact(
  artifacts: readonly ModuleArtifactRecord[],
  revision: AnalysisRevisionRecord,
): ModuleArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => (
      artifact.kind === 'module-summary' &&
      artifact.analysisHash === revision.analysisHash &&
      Boolean(artifact.planHash)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function isReadOnlyQueryableRevision(
  revision: AnalysisRevisionRecord,
): revision is AnalysisRevisionRecord & { status: 'ready' | 'superseded' } {
  return revision.status === 'ready' || revision.status === 'superseded';
}

function isBoundedOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isJavaCsharpLegacyFile(file: RepositoryStaticAnalysis['files'][number]): boolean {
  return file.language === 'Java' || file.language === 'C#';
}

/**
 * A compiler-probe snapshot is only safe to attach when its Java/C# source
 * bytes exactly match the active structural revision.  Other languages are
 * intentionally outside this compatibility provider's evidence domain.
 */
function compilerProbeFilesMatchStructuralIndex(
  analysis: RepositoryStaticAnalysis,
  index: StructuralIndex,
): boolean {
  const legacyFiles = analysis.files.filter(isJavaCsharpLegacyFile);
  const structuralFiles = index.files.filter((file) =>
    file.languageId === 'java' || file.languageId === 'csharp',
  );
  if (legacyFiles.length === 0 || legacyFiles.length !== structuralFiles.length) return false;
  const structuralByPath = new Map(structuralFiles.map((file) => [file.relativePath, file.sha256]));
  return legacyFiles.every((file) => structuralByPath.get(file.path) === file.sha256);
}

/**
 * Trusted VS Code composition for the shared repository chain.  The host is
 * allowed to hold local paths and invoke Registry/Coordinator; consumers get
 * only `SemanticQueryPort` or the path-free presentation above.
 */
export class CodeIntelligenceHost {
  #projectAnalysis?: ProjectAnalysisPort;
  #planProject?: CodeIntelligenceHostOptions['planProject'];
  #hierarchyPlanner?: ModuleHierarchyPlanner;
  #allowLargeAgentPlan: boolean;
  #onChange?: () => void;
  #modelKeyRefusal?: CodeIntelligenceHostOptions['modelKeyRefusal'];
  #onModelRefusal?: CodeIntelligenceHostOptions['onModelRefusal'];
  #syncQueue: Promise<unknown> = Promise.resolve();
  #selectedTarget?: RepositoryId;
  /** Local view override for legacy rows whose active revision is already ready. */
  #readOnlyReadyRevisions = new Map<RepositoryId, string>();
  #selectionSequence = 0;
  readonly #runtimeFactory: CodeIntelligenceRuntimeFactory;
  readonly #runtimeOptions: CreateCodeIntelligenceRuntimeOptions;
  readonly #identityStore?: RepositoryIdentityStore;
  readonly #output?: { appendLine(value: string): void };
  readonly #storageKind: 'seekdb' | 'memory';
  readonly #now: () => string;
  readonly #projectModuleArtifacts: (runtime: CodeIntelligenceRuntime, index: StructuralIndex) => Promise<void>;
  readonly #semanticQueryServerFactory: NonNullable<CodeIntelligenceHostOptions['semanticQueryServerFactory']>;
  #runtimePromise: Promise<CodeIntelligenceRuntime> | undefined;
  #synchronizing: Promise<CodeIntelligenceSynchronizationResult> | undefined;
  #ephemeralRepositoryIds = new Map<string, RepositoryId>();
  /** Repository visibility belongs to one VS Code window, not the shared persistent registry. */
  #visibleRepositoryIds = new Set<RepositoryId>();
  #indexingProgress = new Map<RepositoryId, NonNullable<CodeIntelligenceRepositoryPresentation['indexing']>>();
  #projectTasks = new Set<Promise<void>>();
  #lastPresentation: CodeIntelligencePresentation | undefined;
  /** Per-panel-host display choice only; never persisted as repository state. */
  #selectedRevisions = new Map<RepositoryId, string>();
  /**
   * A multi-project repository stays hidden until one project is chosen
   * explicitly, so the choice is window UI state that outlives a restart
   * instead of an in-memory fact that would re-hide the repository.
   */
  #selectedProjects = new Map<RepositoryId, ProjectId>();
  #semanticQueryServer: Server | undefined;
  #semanticQueryEndpoint: string | undefined;
  #semanticServerStart?: Promise<string>;
  #lastFailure = false;
  #disposed = false;

  constructor(options: CodeIntelligenceHostOptions = {}) {
    this.#projectAnalysis = options.projectAnalysisPort;
    this.#planProject = options.planProject;
    this.#hierarchyPlanner = options.hierarchyPlanner;
    this.#allowLargeAgentPlan = options.allowLargeAgentPlan === true;
    this.#onChange = options.onChange;
    this.#modelKeyRefusal = options.modelKeyRefusal;
    this.#onModelRefusal = options.onModelRefusal;
    this.#runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
    this.#runtimeOptions = options.runtimeOptions ?? {};
    this.#identityStore = options.identityStore;
    for (const [repositoryId, projectId] of options.initialSelectedProjects ?? []) {
      this.#selectedProjects.set(repositoryId, projectId);
    }
    this.#output = options.output;
    this.#storageKind = options.storageKind ?? (options.runtimeOptions?.seekdb ? 'seekdb' : 'memory');
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#projectModuleArtifacts = options.projectModuleArtifacts ?? (async (runtime, index) => {
      await new (codeIntelligenceService().SeekDbProjection)(runtime.store).projectModuleArtifacts(index);
    });
    this.#semanticQueryServerFactory = options.semanticQueryServerFactory
      ?? ((serverOptions) => codeIntelligenceService().createSemanticQueryHttpServer(serverOptions));
  }

  /** Safe read-only data boundary suitable for a ToolCallingArchitectRuntime. */
  async semanticQueryPort(): Promise<SemanticQueryPort> {
    return (await this.runtime()).queryPort;
  }

  /**
   * Starts the loopback-only query transport consumed by the adaptation
   * service. The server exposes the already-composed read-only port and never
   * receives a local path or a database credential.
   */
  async startSemanticQueryServer(options: {
    port?: number;
    bearerToken?: string;
  } = {}): Promise<string> {
    if (this.#semanticServerStart) {
      const endpoint = await this.#semanticServerStart;
      if (this.#semanticQueryServer?.listening) {
        return endpoint;
      }
      this.#semanticServerStart = undefined;
      this.#semanticQueryEndpoint = undefined;
    }
    if (!this.#semanticServerStart) {
      this.#semanticServerStart = this.startSemanticQueryServerInternal(options).catch((error) => {
        this.#semanticServerStart = undefined;
        throw error;
      });
    }
    return this.#semanticServerStart;
  }

  private async startSemanticQueryServerInternal(options: { port?: number; bearerToken?: string }): Promise<string> {
    if (this.#semanticQueryEndpoint) return this.#semanticQueryEndpoint;
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error('Semantic query server port must be 0 (automatic) or a valid TCP port.');
    }
    const runtime = await this.runtime();
    const server = this.#semanticQueryServerFactory({
      queryPort: await this.semanticQueryPort(),
      ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      if (isAddressInUse(error)) {
        throw new Error(`代码查询端口 ${port} 已被占用；不能复用另一窗口的索引。请更换 FOREXPLORE_SEMANTIC_QUERY_PORT 或取消固定端口。`, { cause: error });
      }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Semantic query server did not bind a TCP endpoint.');
    }
    this.#semanticQueryServer = server;
    this.#semanticQueryEndpoint = `http://127.0.0.1:${address.port}`;
    this.#output?.appendLine(`[forexplore] semantic query port listening at ${this.#semanticQueryEndpoint}.`);
    return this.#semanticQueryEndpoint;
  }

  /** Resolves a registered local root to the active revision without exposing the root. */
  async activeScopeForPath(localPath: string): Promise<RepositoryRevisionScope> {
    const runtime = await this.runtime();
    const repositoryId = await this.existingRepositoryIdFor(localPath);
    if (!repositoryId) throw new Error('The repository path is not registered in the code-intelligence host.');
    const repository = await runtime.registry.get(repositoryId);
    if (!repository?.activeRevision) throw new Error('The repository has no active analysis revision.');
    return { repositoryId, analysisRevision: repository.activeRevision };
  }

  async selectedProjectForPath(localPath: string): Promise<ProjectId | null> {
    const scope = await this.activeScopeForPath(localPath);
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(scope.repositoryId);
    if (!repository) return null;
    const projects = await runtime.queryPort.listProjects(scope);
    return this.resolveProjectChoice(repository, projects.projects.map((project) => project.value)).projectId ?? null;
  }

  /** Runs module-first retrieval only across this window's current historical repositories. */
  async searchHistoricalImplementations(request: {
    target: ModuleTarget;
    requirement: string;
    topK: number;
  }, signal?: AbortSignal, reranker?: ModuleReranker): Promise<SearchCandidate[]> {
    const runtime = await this.runtime();
    const targetScope = request.target.module;
    if (targetScope?.repositoryId && targetScope.analysisRevision) {
      const targetRepository = await runtime.registry.get(targetScope.repositoryId);
      if (targetRepository?.role !== 'target' || targetRepository.activeRevision !== targetScope.analysisRevision) {
        throw new Error('目标模块版本已变化，请重新选择当前模块。');
      }
    }
    if (!runtime.moduleImplementationSearch) {
      throw new Error('当前代码智能运行时未提供模块检索能力。');
    }
    const repositoryIds = (await runtime.registry.list?.() ?? [])
      .filter((repository) => repository.role === 'history' && this.#visibleRepositoryIds.has(repository.repositoryId))
      .map((repository) => repository.repositoryId);
    return reranker ? runtime.moduleImplementationSearch.search({ ...request, repositoryIds }, signal, reranker)
      : runtime.moduleImplementationSearch.search({ ...request, repositoryIds }, signal);
  }

  async historyEvidenceScopes(selected: RepositoryRevisionScope & { projectId?: ProjectId }): Promise<WorkspaceEvidenceScope[]> {
    const runtime = await this.runtime();
    if (!selected || !this.#visibleRepositoryIds.has(selected.repositoryId)) throw new Error('候选仓库不在当前窗口的参考范围。');
    const repository = await runtime.registry.get(selected.repositoryId);
    const revision = await runtime.store.getRevision(selected);
    if (repository?.role !== 'history' || !revision || !['ready', 'superseded'].includes(revision.status)) throw new Error('历史候选版本已不可查询，请重新检索。');
    const scopes: WorkspaceEvidenceScope[] = [{
      repositoryId: selected.repositoryId,
      analysisRevision: selected.analysisRevision,
      ...(selected.projectId ? { projectId: selected.projectId } : {}),
    }];
    for (const reference of await runtime.registry.list?.() ?? []) {
      if (!this.#visibleRepositoryIds.has(reference.repositoryId) || reference.role !== 'history' ||
          reference.repositoryId === selected.repositoryId) continue;
      if (!reference.activeRevision) throw new Error(`参考工程 ${reference.displayName} 尚未完成索引，无法准备完整跨仓取证范围。`);
      const scope = { repositoryId: reference.repositoryId, analysisRevision: reference.activeRevision };
      if ((await runtime.store.getRevision(scope))?.status !== 'ready') throw new Error(`参考工程 ${reference.displayName} 尚未完成索引，无法准备完整跨仓取证范围。`);
      scopes.push(scope);
    }
    if (scopes.length > MAX_RETRIEVAL_SCOPES) throw new Error(`历史范围超过 ${MAX_RETRIEVAL_SCOPES} 个版本，请缩小参考工程范围。`);
    return scopes;
  }

  /**
   * Materialize a bounded, immutable evidence view for the selected history
   * module.  The returned root is an internal hand-off for the local adaptation
   * service; callers never publish it to the webview or the model.  Every file
   * is checked against the registered history repository before it is copied.
   */
  async createHistoryModuleView(selected: {
    /** Target workspace root used for the host-owned .forexpore history view. */
    workspaceRoot?: string;
    repositoryId: RepositoryId;
    analysisRevision: string;
    projectId?: ProjectId;
    moduleId: string;
    sourceFiles: readonly string[];
    /** Representative implementation paths selected by module retrieval. */
    preferredFiles?: readonly string[];
    /** Target symbols and paths used only to prioritize files in a bounded view. */
    relevanceTerms?: readonly string[];
  }): Promise<WorkspaceHistoryView> {
    if (!this.#visibleRepositoryIds.has(selected.repositoryId)) {
      throw new Error('候选仓库不在当前窗口的参考范围。');
    }
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(selected.repositoryId);
    if (!repository || repository.role !== 'history' || !repository.activeRevision) {
      throw new Error('历史候选仓库不可用，请重新检索。');
    }
    const revision = await runtime.store.getRevision({ repositoryId: selected.repositoryId, analysisRevision: selected.analysisRevision });
    if (!revision || !['ready', 'superseded'].includes(revision.status)) {
      throw new Error('历史候选版本已不可查询，请重新检索。');
    }
    // The row may have been written by a process on the other platform (a WSL run
    // stores /mnt/e/..., a Windows run stores E:\...), so translate before opening it.
    const sourceRoot = await realpath(platformLocalPath(repository.localPath));
    const inventory = [...new Set(selected.sourceFiles.map(normalizeHistoryPath))];
    if (!inventory.length || inventory.some((file) => !file)) throw new Error('历史候选模块没有有效的源文件清单。');
    const preferred = [...new Set((selected.preferredFiles ?? []).map(normalizeHistoryPath))].filter(file => inventory.includes(file));
    const files = [...preferred, ...inventory.filter(file => !preferred.includes(file))];
    // Validate and measure every candidate file at the trusted host boundary,
    // then materialize only a bounded evidence view. Module inventory size is
    // not the Agent's observation budget: large indexed modules are valid too.
    const fileSizes = new Map<string, number>();
    for (const file of files) {
      const source = await safeHistoryFile(sourceRoot, file);
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`历史候选文件不是普通文件：${file}`);
      fileSizes.set(file, stat.size);
    }
    const viewFiles = boundHistoryViewFiles(files, fileSizes, HISTORY_VIEW_MAX_FILES, HISTORY_VIEW_MAX_BYTES, selected.relevanceTerms ?? []);
    if (!viewFiles.length) throw new Error('历史候选没有符合历史视图大小预算的 source files。');
    const runId = randomUUID();
    let targetRoot = selected.workspaceRoot?.trim();
    if (!targetRoot && this.#selectedTarget) {
      const target = await runtime.registry.get(this.#selectedTarget);
      if (target?.role === 'target') targetRoot = target.localPath;
    }
    const root = targetRoot
      ? path.join(await realpath(platformLocalPath(targetRoot)), '.forexpore', 'history-views', runId)
      : await mkdtemp(path.join(tmpdir(), 'forexplore-history-view-'));
    await mkdir(path.join(root, 'source'), { recursive: true });
    const generatedAt = new Date().toISOString();
    const manifestEntries: Array<[string, string]> = [];
    try {
      for (const file of viewFiles) {
        const source = await safeHistoryFile(sourceRoot, file);
        const bytes = await readFile(source);
        const destination = path.join(root, 'source', ...file.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        // The Agent receives a read-only copy; the runtime also validates the
        // manifest before staging it, so chmod is defence in depth only.
        await writeFile(destination, bytes);
        await chmod(destination, 0o444);
        manifestEntries.push([file, createHash('sha256').update(bytes).digest('hex')]);
      }
      manifestEntries.sort(([left], [right]) => left.localeCompare(right));
      const manifestHash = createHash('sha256').update(JSON.stringify(manifestEntries)).digest('hex');
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
        repositoryId: selected.repositoryId, analysisRevision: selected.analysisRevision,
        projectId: selected.projectId, moduleId: selected.moduleId, runId, generatedAt,
        files: manifestEntries.map(([file, sha256]) => ({ path: file, sha256 })),
        omittedFiles: files.filter((file) => !viewFiles.includes(file)),
      }, null, 2), { mode: 0o444 });
      await chmodReadonlyTree(path.join(root, 'source'));
      await chmodReadonlyTree(root);
      return {
        root, files: manifestEntries.map(([file]) => file), repositoryId: selected.repositoryId,
        analysisRevision: selected.analysisRevision, ...(selected.projectId ? { projectId: selected.projectId } : {}),
        moduleId: selected.moduleId, manifestHash, runId, generatedAt,
      };
    } catch (error) {
      // Best-effort cleanup; the original error is the useful diagnostic.
      await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })).catch(() => undefined);
      throw error;
    }
}

  /** Merge 1–3 user-selected modules; each retains the existing per-module budget. */
  async createHistoryModulesView(input: {
    workspaceRoot?: string;
    candidates: readonly HistoryModuleSelection[];
  }): Promise<WorkspaceHistoryView> {
    if (input.candidates.length < 1 || input.candidates.length > MAX_SELECTED_HISTORY_MODULES ||
        new Set(input.candidates.map(item => JSON.stringify([item.repositoryId, item.analysisRevision, item.projectId, item.moduleId]))).size !== input.candidates.length) {
      throw new Error('请选择 1～3 个不同的历史模块。');
    }
    // Preserve the established layout for a single selected module.
    if (input.candidates.length === 1) return this.createHistoryModuleView({ ...input.candidates[0]!, workspaceRoot: input.workspaceRoot });
    const views: Array<{ selection: HistoryModuleSelection; view: WorkspaceHistoryView; prefix: string }> = [];
    const skippedCandidates: Array<{ moduleId: string; repositoryId: string; reason: string }> = [];
    let root: string | undefined;
    try {
      for (const [index, selection] of input.candidates.entries()) {
        try {
          const view = await this.createHistoryModuleView({ ...selection, workspaceRoot: input.workspaceRoot });
          views.push({ selection, view, prefix: `candidate-${index + 1}` });
        } catch (error) {
          skippedCandidates.push({ moduleId: selection.moduleId, repositoryId: selection.repositoryId,
            reason: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!views.length) throw new Error(`历史候选没有可读取的 source files：${skippedCandidates.map(item => item.reason).join('; ')}`);
      const primary = views[0]!.view;
      const runId = randomUUID();
      root = primary.root.startsWith(path.join(tmpdir(), 'forexplore-history-view-'))
        ? await mkdtemp(path.join(tmpdir(), 'forexplore-history-view-'))
        : path.join(path.dirname(primary.root), runId);
      await mkdir(path.join(root, 'source'), { recursive: true });
      const entries: Array<[string, string]> = [];
      const candidates: WorkspaceHistoryCandidate[] = [];
      const omittedFiles: string[] = [];
      for (const { selection, view, prefix } of views) {
        candidates.push({ prefix, repositoryId: view.repositoryId, analysisRevision: view.analysisRevision,
          ...(view.projectId ? { projectId: view.projectId } : {}), moduleId: view.moduleId,
          ...(selection.name ? { name: selection.name } : {}), ...(selection.language ? { language: selection.language } : {}) });
        for (const file of view.files) {
          const bytes = await readFile(path.join(view.root, 'source', ...file.split('/')));
          const relative = `${prefix}/${file}`;
          const destination = path.join(root, 'source', ...relative.split('/'));
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, bytes, { mode: 0o444 });
          entries.push([relative, createHash('sha256').update(bytes).digest('hex')]);
        }
        const manifest = JSON.parse(await readFile(path.join(view.root, 'manifest.json'), 'utf8'));
        omittedFiles.push(...(manifest.omittedFiles ?? []).map((file: string) => `${prefix}/${file}`));
      }
      entries.sort(([a], [b]) => a.localeCompare(b));
      const manifestHash = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      const generatedAt = new Date().toISOString();
      const identity = { repositoryId: primary.repositoryId, analysisRevision: primary.analysisRevision,
        ...(primary.projectId ? { projectId: primary.projectId } : {}), moduleId: primary.moduleId };
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...identity, runId, generatedAt, candidates,
        files: entries.map(([file, sha256]) => ({ path: file, sha256 })), omittedFiles, skippedCandidates }, null, 2), { mode: 0o444 });
      await chmodReadonlyTree(root);
      return { root, ...identity, files: entries.map(([file]) => file), manifestHash, runId, generatedAt, candidates };
    } catch (error) {
      if (root) await removeHistoryView(root);
      throw error;
    } finally {
      for (const { view } of views) await removeHistoryView(view.root);
    }
  }

  /** Returns the active structural index for trusted host-side presentation. */
  async structuralIndexForPath(localPath: string): Promise<StructuralIndex | null> {
    try {
      const scope = await this.activeScopeForPath(localPath);
      return await (await this.runtime()).store.getStructuralIndex(scope);
    } catch {
      return null;
    }
  }

  async synchronize(
    request: SynchronizeCodeIntelligenceRequest,
  ): Promise<CodeIntelligenceSynchronizationResult> {
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    request.signal?.throwIfAborted();
    const operation = this.#syncQueue.catch(() => {}).then(() => this.synchronizeInternal(request)).finally(() => {
      if (this.#synchronizing === operation) this.#synchronizing = undefined;
    });
    this.#synchronizing = operation;
    this.#syncQueue = operation;
    return operation;
  }

  /** Read the safe UI model without handing the Webview a registry or store. */
  async presentation(): Promise<CodeIntelligencePresentation> {
    if (this.#disposed) {
      return this.emptyPresentation('error', genericRuntimeFailure());
    }
    if (!this.#runtimePromise) return this.emptyPresentation('initializing');
    try {
      const runtime = await this.runtime();
      return await this.presentationFor(runtime);
    } catch (error) {
      this.logFailure('read code intelligence status', error);
      return this.unavailablePresentation();
    }
  }

  /**
   * Select an already-indexed revision for read-only presentation/query work.
   * This only changes an in-memory display choice and deliberately never calls
   * the registry's activation APIs or the analysis coordinator.
   */
  async selectRevisionForDisplay(
    request: SelectCodeIntelligenceRevisionRequest,
  ): Promise<CodeIntelligencePresentation> {
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    if (!isBoundedOpaqueIdentifier(request.repositoryId) || !isBoundedOpaqueIdentifier(request.analysisRevision)) {
      throw new Error('A revision selection requires bounded repository and revision identifiers.');
    }
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(request.repositoryId);
    if (!repository) throw new Error('The selected repository is not registered in this host.');
    const [revision, index] = await Promise.all([
      runtime.store.getRevision(request),
      runtime.store.getStructuralIndexMetadata?.(request) ?? runtime.store.getStructuralIndex(request),
    ]);
    if (
      !revision ||
      !index ||
      !isReadOnlyQueryableRevision(revision) ||
      index.analysisHash !== revision.analysisHash
    ) {
      throw new Error('The selected analysis revision is not available for read-only queries.');
    }
    // Verify the public query boundary accepts this exact immutable scope
    // before exposing it as selected. This remains a read-only operation.
    await runtime.queryPort.getRepositoryOverview(request);
    this.#selectedRevisions.set(request.repositoryId, request.analysisRevision);
    return this.presentationFor(runtime);
  }

  /** Selects a host-verified project inside the currently displayed revision. */
  async selectProjectForDisplay(request: RepositoryRevisionScope & { projectId: ProjectId }): Promise<CodeIntelligencePresentation> {
    const sequence = ++this.#selectionSequence;
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    if (!isBoundedOpaqueIdentifier(request.repositoryId) ||
        !isBoundedOpaqueIdentifier(request.analysisRevision) ||
        !isBoundedOpaqueIdentifier(request.projectId)) {
      throw new Error('A project selection requires bounded repository, revision, and project identifiers.');
    }
    const runtime = await this.runtime();
    const projects = await runtime.queryPort.listProjects({
      repositoryId: request.repositoryId,
      analysisRevision: request.analysisRevision,
    });
    if (!projects.projects.some((project) => project.value.projectId === request.projectId)) {
      throw new Error('The selected project is not part of the requested analysis revision.');
    }
    const repository = await runtime.registry.get(request.repositoryId);
    if (sequence !== this.#selectionSequence) return this.presentationFor(runtime);
    this.#selectedRevisions.set(request.repositoryId, request.analysisRevision);
    await this.rememberSelectedProject(request.repositoryId, request.projectId);
    if (repository?.role === 'target') this.#selectedTarget = request.repositoryId;
    if (repository?.activeRevision === request.analysisRevision) this.scheduleProject(request);
    return this.presentationFor(runtime);
  }

  /**
   * Host-only summary publication for the tool-calling planning flow.  Legacy
   * RepositoryStaticAnalysis summaries are intentionally not coerced into a
   * new revision: their analysis hash is a different evidence domain.
   */
  async publishModuleSummary(request: PublishModuleSummaryRequest): Promise<void> {
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(request.repositoryId);
    if (!repository || repository.activeRevision !== request.analysisRevision) {
      throw new Error('A module summary may only be published for the active repository revision.');
    }
    const revision = await runtime.store.getRevision(request);
    const index = await runtime.store.getStructuralIndex(request);
    if (!revision || !index || revision.analysisHash !== request.analysisHash) {
      throw new Error('Module summary analysisHash does not match the indexed analysis revision.');
    }
    if (!request.planHash.trim()) throw new Error('Module summary planHash is required.');

    const now = this.#now();
    await runtime.store.putModuleArtifact({
      ...request,
      moduleArtifactId: `module-summary:${randomUUID()}`,
      kind: 'module-summary',
      status: 'current',
      contentHash: request.contentHash ?? contentHash(request.payload),
      createdAt: now,
      updatedAt: now,
    });
    // Rebuild only this revision's non-authoritative search projection.  The
    // projection class owns SeekDB writes and has no global clear operation.
    await this.#projectModuleArtifacts(runtime, index);
  }

  /**
   * Bind an already host-verified Java/C# compiler-probe snapshot to the
   * active structural revision.  This is intentionally a host-only hook: no
   * Agent, Webview, or MCP caller can supply a root or access the provider.
   *
   * The caller must have registered/scanned the root first.  A mismatch or a
   * missing Java/C# semantic bridge is non-fatal to the legacy workflow and
   * returns `skipped` without changing the active revision.
   */
  async bindJavaCsharpCompilerProbeEvidence(
    request: BindJavaCsharpCompilerProbeEvidenceRequest,
  ): Promise<JavaCsharpCompilerProbeBindingResult> {
    if (this.#disposed || !request.localPath.trim()) return { status: 'skipped' };
    try {
      const runtime = await this.runtime();
      const repositoryId = await this.existingRepositoryIdFor(request.localPath);
      if (!repositoryId) return { status: 'skipped' };
      const repository = await runtime.registry.get(repositoryId);
      const analysisRevision = repository?.activeRevision;
      if (!repository || !analysisRevision || !runtime.javaCsharpSpecializedProvider) {
        return { status: 'skipped', repositoryId };
      }
      const scope = { repositoryId, analysisRevision };
      const revision = await runtime.store.getRevision(scope);
      const index = await runtime.store.getStructuralIndex(scope);
      if (
        !revision ||
        revision.status !== 'ready' ||
        !index ||
        index.analysisHash !== revision.analysisHash ||
        !compilerProbeFilesMatchStructuralIndex(request.analysis, index)
      ) {
        return { status: 'skipped', repositoryId, analysisRevision };
      }
      await runtime.javaCsharpSpecializedProvider.register({
        ...scope,
        analysisHash: revision.analysisHash,
        analysis: request.analysis,
      });
      return { status: 'bound', repositoryId, analysisRevision };
    } catch (error) {
      this.logFailure('bind Java/C# compiler-probe evidence', error);
      return { status: 'skipped' };
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#selectedRevisions.clear();
    this.#selectedProjects.clear();
    this.#readOnlyReadyRevisions.clear();
    const semanticQueryServer = this.#semanticQueryServer;
    this.#semanticQueryServer = undefined;
    this.#semanticQueryEndpoint = undefined;
    if (semanticQueryServer) {
      semanticQueryServer.close();
      semanticQueryServer.closeIdleConnections();
    }
    const pending = this.#runtimePromise;
    this.#runtimePromise = undefined;
    if (pending) {
      void pending.then((runtime) => runtime.close()).catch(() => undefined);
    }
  }

  private async synchronizeInternal(
    request: SynchronizeCodeIntelligenceRequest,
  ): Promise<CodeIntelligenceSynchronizationResult> {
    request.signal?.throwIfAborted();
    this.#output?.appendLine('[forexplore] code intelligence synchronization started.');
    let runtime: CodeIntelligenceRuntime;
    try {
      runtime = await this.runtime();
    } catch (error) {
      request.signal?.throwIfAborted();
      this.logFailure('start code intelligence runtime', error);
      return {
        presentation: this.emptyPresentation('error', genericRuntimeFailure()),
        scannedRepositoryIds: [],
        failedRepositoryIds: [],
      };
    }

    const registered = new Map<RepositoryId, RepositoryRecord>();
    const persistedByPath = new Map((await runtime.registry.list?.() ?? [])
      .map((repository) => [stableIdentityKey(repository.localPath), repository.repositoryId]));
    const previouslyVisible = this.#visibleRepositoryIds;
    const failedRepositoryIds: RepositoryId[] = [];
    let registrationFailed = false;
    const normalizedInputs = await Promise.all(request.repositories.map(async (input) => ({
      ...input, localPath: await realpath(path.resolve(input.localPath)).catch(() => path.resolve(input.localPath)),
    })));
    const preferredInputs = preferredRepositoryInputs(normalizedInputs);
    const requestedScanPaths = request.scanRoles
      ? new Set(normalizedInputs.filter((input) => request.scanRoles!.includes(input.role)).map(repositoryInputKey))
      : undefined;
    for (const input of preferredInputs) {
      request.signal?.throwIfAborted();
      try {
        const repositoryId = await this.repositoryIdFor(
          input.localPath,
          input.repositoryId ?? persistedByPath.get(stableIdentityKey(input.localPath)),
        );
        const explicitlyBound = input.repositoryId ? await runtime.registry.get(repositoryId) : null;
        let repository: RepositoryRecord;
        if (request.scan === false && explicitlyBound) {
          // The ignored preloaded manifest binds a local path to a persisted
          // repository ID across Windows/WSL. Keep the SeekDB row untouched:
          // writing this platform's localPath back would make the ordinary
          // entry create duplicate identities when opened from the other OS.
          if (explicitlyBound.role !== input.role) {
            throw new Error('The preloaded repository role does not match its persisted repository record.');
          }
          repository = explicitlyBound;
        } else {
          repository = await runtime.registry.register({
            repositoryId,
            localPath: input.localPath,
            role: input.role,
            ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
          }).catch(async (error: unknown) => {
            // Re-registering a checkout that a persisted row already owns is idempotent:
            // the identity is unchanged, so the existing record is the registration.
            // Treating it as a failure emptied the visible set and left every history
            // repository invisible to retrieval ("Module search requires between 1 and
            // 32 historical repositories").
            if (!/already registered/i.test(String((error as Error)?.message ?? error))) throw error;
            const existing = await runtime.registry.get(repositoryId);
            if (!existing) throw error;
            return existing;
          });
        }
        if (request.repairStaleIndexing && repository.analysisStatus === 'indexing' && repository.activeRevision) {
          const revision = await runtime.store.getRevision({
            repositoryId: repository.repositoryId,
            analysisRevision: repository.activeRevision,
          });
          if (revision?.status === 'ready') {
            this.#readOnlyReadyRevisions.set(repository.repositoryId, repository.activeRevision);
          } else this.#readOnlyReadyRevisions.delete(repository.repositoryId);
        } else this.#readOnlyReadyRevisions.delete(repository.repositoryId);
        registered.set(repository.repositoryId, repository);
      } catch (error) {
        request.signal?.throwIfAborted();
        // The only identifier available to UI clients is a registered ID, so
        // an unregistered local-path error stays in the trusted host log.
        this.logFailure('register code intelligence repository', error);
        registrationFailed = true;
      }
    }
    this.#visibleRepositoryIds = new Set(registered.keys());
    if (this.#selectedTarget && !this.#visibleRepositoryIds.has(this.#selectedTarget)) {
      this.#selectedTarget = undefined;
    }
    this.#onChange?.();

    const scannedRepositoryIds: RepositoryId[] = [];
    if (request.scan !== false) {
      const pending = [...registered.values()].filter(repository => {
        if (request.scanRepositoryIds && !request.scanRepositoryIds.includes(repository.repositoryId)) return false;
        // A path explicitly configured as history can also be a workspace
        // target. Role precedence must not suppress that requested scan.
        if (requestedScanPaths && !requestedScanPaths.has(repositoryInputKey(repository))) return false;
        if (request.scanNewOnly && previouslyVisible.has(repository.repositoryId) && repository.activeRevision &&
          repository.analysisStatus !== 'failed') return false;
        return true;
      });
      pending.forEach((repository, index) => this.#indexingProgress.set(repository.repositoryId,
        { stage: 'queued', position: index + 1, count: pending.length }));
      this.#onChange?.();
      try {
      for (const [index, repository] of pending.entries()) {
        request.signal?.throwIfAborted();
        try {
          this.#output?.appendLine(`[forexplore] indexing ${repository.role} repository: ${repository.displayName}.`);
          // The coordinator flips the registry to 'indexing' inside its own
          // run, so publish that transition from here: a long first-time scan
          // of a freshly selected target must be visible to the Webview rather
          // than only its final result.
          await runtime.registry.setAnalysisStatus?.(repository.repositoryId, 'indexing');
          this.#onChange?.();
          const onProgress = createIndexingProgressReporter(progress => {
            this.#indexingProgress.set(repository.repositoryId, { ...progress, position: index + 1, count: pending.length });
            this.#output?.appendLine(`[RECAST] ${indexingProgressMessage(progress)}`);
            request.onProgress?.({ ...progress, position: index + 1, count: pending.length });
          });
          await runtime.coordinator.run({
            repositoryId: repository.repositoryId,
            mode: request.forceFull || !repository.activeRevision ? 'full' : 'incremental',
            // A forced full scan is a rebuild request: it must not return the
            // previous revision's search projection when sources happen to match.
            ...(request.forceFull ? { rebuild: true } : {}),
            reuseFailedProjection: !request.forceFull && !['ready', 'degraded'].includes(repository.analysisStatus),
            signal: request.signal,
            onProgress: progress => onProgress({ ...progress, repositoryId: repository.repositoryId, displayName: repository.displayName }),
          });
          // A resolved coordinator run has committed its revision. Late
          // cancellation must not relabel that success or skip its projects.
          scannedRepositoryIds.push(repository.repositoryId);
          const current = await runtime.registry.get(repository.repositoryId);
          if (current?.activeRevision) await this.scheduleRepositoryProjects(runtime, current);
        } catch (error) {
          failedRepositoryIds.push(repository.repositoryId);
          await this.markIndexFailure(runtime, repository.repositoryId);
          if (request.signal?.aborted || isIndexingCancellation(error)) {
            this.#lastFailure = true;
            this.#output?.appendLine(`[RECAST] ${repository.displayName}：索引已取消，可重试。`);
            request.signal?.throwIfAborted();
            throw error;
          }
          this.logFailure(`index repository ${repository.repositoryId}`, error);
        } finally {
          this.#indexingProgress.delete(repository.repositoryId);
          this.#onChange?.();
        }
      }
      } finally {
        this.#indexingProgress.clear();
        this.#onChange?.();
      }
    }

    // Startup and credential saves can resume modelling without rescanning source.
    // Ordinary registration-only refreshes remain read-only. A target models only
    // its selected project; completed artifacts are reused by ensureProjectAnalysis.
    for (const repository of registered.values()) {
      if (!repository.activeRevision || scannedRepositoryIds.includes(repository.repositoryId) ||
          failedRepositoryIds.includes(repository.repositoryId) ||
          !['ready', 'degraded'].includes(this.presentationAnalysisStatus(repository))) continue;
      const scanRequested = request.scan !== false &&
        (!request.scanRepositoryIds || request.scanRepositoryIds.includes(repository.repositoryId)) &&
        (!requestedScanPaths || requestedScanPaths.has(repositoryInputKey(repository)));
      if (request.resumeProjectAnalysis || scanRequested) {
        request.signal?.throwIfAborted();
        await this.scheduleRepositoryProjects(runtime, repository);
      }
    }

    this.#lastFailure = registrationFailed || failedRepositoryIds.length > 0;
    let presentation: CodeIntelligencePresentation;
    try {
      presentation = await this.presentationFor(runtime);
    } catch (error) {
      this.logFailure('read synchronized code intelligence status', error);
      presentation = this.unavailablePresentation();
    }
    this.#output?.appendLine(
      `[forexplore] code intelligence synchronization complete: ${scannedRepositoryIds.length} scanned, ${failedRepositoryIds.length} failed.`,
    );
    return { presentation, scannedRepositoryIds, failedRepositoryIds };
  }

  /**
   * A failed refresh keeps its last usable revision. If cancellation happens
   * before the coordinator takes ownership, finish the host's 'indexing'
   * transition here so neither first scans nor refreshes retain a spinner.
   */
  private async markIndexFailure(
    runtime: CodeIntelligenceRuntime,
    repositoryId: RepositoryId,
  ): Promise<void> {
    try {
      const current = await runtime.registry.get(repositoryId);
      if (current?.analysisStatus === 'indexing') {
        await runtime.registry.setAnalysisStatus?.(repositoryId, 'failed');
      }
    } catch (error) {
      this.logFailure(`mark index failure ${repositoryId}`, error);
    }
  }

  private async projectAnalysis(): Promise<ProjectAnalysisPort> {
    const runtime = await this.runtime();
    if (!this.#projectAnalysis && !this.#planProject && !this.#hierarchyPlanner && runtime.projectAnalysis) this.#projectAnalysis = runtime.projectAnalysis;
    this.#projectAnalysis ??= new (codeIntelligenceService().ProjectAnalysisCoordinator)({
      store: runtime.store,
      ...(this.#planProject ? { plan: (scope: ProjectAnalysisScope & { objective: string }) => this.#planProject!(scope) } : {}),
      hierarchyPlanner: this.#hierarchyPlanner,
      allowLargeAgentPlan: this.#allowLargeAgentPlan,
      onChange: this.#onChange,
    });
    return this.#projectAnalysis;
  }

  private async scheduleRepositoryProjects(runtime: CodeIntelligenceRuntime, repository: RepositoryRecord): Promise<void> {
    if (!repository.activeRevision) return;
    const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision };
    const projects = runtime.store.listProjects ? await runtime.store.listProjects(scope)
      : (await runtime.queryPort.listProjects(scope)).projects.map(project => project.value);
    const chosen = this.resolveProjectChoice(repository, projects).projectId;
    for (const project of projects) {
      if (repository.role === 'history' || project.projectId === chosen) this.scheduleProject(project);
    }
  }

  /**
   * Module analysis is the only step here that calls a model, so it is refused
   * while the selected provider has no stored API Key. A refusal never blocks
   * indexing: the revision, its symbols and source search stay usable.
   */
  private async moduleAnalysisRefusal(): Promise<string | undefined> {
    if (!this.#modelKeyRefusal) return undefined;
    try {
      return await this.#modelKeyRefusal();
    } catch (error) {
      this.logFailure('check model credential', error);
      return '无法确认模型凭据，已停止模块解析；请在设置中重新配置 API Key。';
    }
  }

  private async ensureProjectAnalysis(scope: ProjectAnalysisScope, force: boolean): Promise<void> {
    const analysis = await this.projectAnalysis();
    // Only a run that would actually call the model needs the credential. Asking
    // first made every synchronization report a refusal for already-modelled
    // projects, which reads as a corpus-wide failure that never happened.
    if (!force) {
      try {
        const record = await analysis.read(scope);
        if (record.state === 'ready' && record.projection === 'ready') return;
      } catch (error) {
        this.logFailure('read project analysis', error);
      }
    }
    const refusal = await this.moduleAnalysisRefusal();
    if (refusal) {
      this.#onModelRefusal?.(refusal);
      throw new Error(refusal);
    }
    await analysis.ensure(scope, force);
  }

  private scheduleProject(scope: ProjectAnalysisScope, force = false): void {
    if (this.#disposed) return;
    const task = this.ensureProjectAnalysis(scope, force)
      .catch((error) => this.logFailure('project module analysis', error))
      .finally(() => this.#projectTasks.delete(task));
    this.#projectTasks.add(task);
  }

  async retryProject(scope: ProjectAnalysisScope, force = false): Promise<void> {
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(scope.repositoryId);
    if (repository?.activeRevision !== scope.analysisRevision) throw new Error('只能重试活动版本的项目。');
    const index = await runtime.store.getStructuralIndex(scope);
    if (!index?.projects.some((p) => p.projectId === scope.projectId)) throw new Error('项目不存在。');
    // An explicit user action fails loudly instead of being logged and forgotten.
    const refusal = await this.moduleAnalysisRefusal();
    if (refusal) throw new Error(refusal);
    this.scheduleProject(scope, force);
  }

  /** A pipeline start owns this wait, but shares the existing modelling job. */
  async ensureProjectModel(scope: ProjectAnalysisScope, signal?: AbortSignal): Promise<ProjectAnalysisRecord> {
    signal?.throwIfAborted();
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(scope.repositoryId);
    if (repository?.activeRevision !== scope.analysisRevision) throw new Error('目标项目版本已更新，请重新选择目标项目。');
    const index = await runtime.store.getStructuralIndex(scope);
    if (!index?.projects.some(project => project.projectId === scope.projectId)) throw new Error('项目不存在。');
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
      // Cancelling one pipeline must not cancel shared repository modelling.
      void this.ensureProjectAnalysis(scope, false).then(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, error => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
    });
    signal?.throwIfAborted();
    if ((await runtime.registry.get(scope.repositoryId))?.activeRevision !== scope.analysisRevision) {
      throw new Error('建模期间目标项目版本已更新，请重新选择目标项目。');
    }
    const record = await (await this.projectAnalysis()).read(scope);
    if (record.state !== 'ready' || record.projection !== 'ready' || !record.proposal) {
      throw new Error(record.error || record.modelingSkippedReason || '目标项目建模未完成，请重试模块建模。');
    }
    return record;
  }

  async waitForProjects(): Promise<void> {
    while (this.#projectTasks.size) await Promise.all([...this.#projectTasks]);
    await this.#projectAnalysis?.idle();
  }

  /** Trusted presentation bridge: no filesystem fallback and no local JSON summaries. */
  async explorerData(): Promise<Array<{
    repository: RepositoryRecord; index: StructuralIndex; projectId: string;
    analysis?: ProjectAnalysisRecord; selectedTarget: boolean;
  }>> {
    const runtime = await this.runtime();
    const repositories = (await runtime.registry.list?.() ?? [])
      .filter((repository) => this.#visibleRepositoryIds.has(repository.repositoryId));
    const target = repositories.find((r) => r.repositoryId === this.#selectedTarget && r.role === 'target')
      ?? repositories.find((r) => r.role === 'target');
    return (await Promise.all(repositories.map(async (repository) => {
      const analysisRevision = this.#selectedRevisions.get(repository.repositoryId) ?? repository.activeRevision;
      if (!analysisRevision) return null;
      const scope = { repositoryId: repository.repositoryId, analysisRevision };
      const projects = await runtime.store.listProjects?.(scope);
      if (projects && !this.resolveProjectChoice(repository, projects).projectId) {
        if (analysisRevision === repository.activeRevision) this.forgetSelectedProject(repository.repositoryId);
        return null;
      }
      const index = await runtime.store.getStructuralIndex(scope);
      if (!index) return null;
      const resolved = this.resolveProjectChoice(repository, projects ?? index.projects);
      // A choice that resolves in no revision of this repository is stale; the
      // one made while browsing an older revision is kept for the active one.
      if (resolved.stale && analysisRevision === repository.activeRevision) {
        this.forgetSelectedProject(repository.repositoryId);
      }
      const projectId = resolved.projectId;
      if (!projectId) return null;
      return {
        repository, index, projectId, selectedTarget: repository.repositoryId === target?.repositoryId,
        analysis: await (await this.projectAnalysis()).read({ repositoryId: repository.repositoryId, analysisRevision, projectId }),
      };
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private async runtime(): Promise<CodeIntelligenceRuntime> {
    if (!this.#runtimePromise) {
      const pending = this.#runtimeFactory(this.#runtimeOptions);
      this.#runtimePromise = pending;
      void pending.catch(() => {
        if (this.#runtimePromise === pending) this.#runtimePromise = undefined;
      });
    }
    return this.#runtimePromise;
  }

  private async repositoryIdFor(localPath: string, persistedId?: RepositoryId): Promise<RepositoryId> {
    const key = stableIdentityKey(await realpath(path.resolve(localPath)).catch(() => path.resolve(localPath)));
    const stored = this.#identityStore?.get<RepositoryId>(key) ?? this.#ephemeralRepositoryIds.get(key);
    if (persistedId) {
      this.#ephemeralRepositoryIds.set(key, persistedId);
      if (stored !== persistedId) await this.#identityStore?.update(key, persistedId);
      return persistedId;
    }
    if (stored) return stored;
    const generated = `repo-${randomUUID()}`;
    this.#ephemeralRepositoryIds.set(key, generated);
    await this.#identityStore?.update(key, generated);
    return generated;
  }

  private async existingRepositoryIdFor(localPath: string): Promise<RepositoryId | null> {
    const key = stableIdentityKey(await realpath(path.resolve(localPath)).catch(() => path.resolve(localPath)));
    return this.#identityStore?.get<RepositoryId>(key) ?? this.#ephemeralRepositoryIds.get(key) ?? null;
  }

  /**
   * Reads the display choice for one repository, restoring it from window UI
   * state after a restart.  The stored value is only ever a candidate: every
   * caller still checks it against the revision it is about to show.
   */
  private selectedProjectFor(repositoryId: RepositoryId): ProjectId | undefined {
    const remembered = this.#selectedProjects.get(repositoryId);
    if (remembered !== undefined) return remembered;
    const stored = this.#identityStore?.get<ProjectId>(selectedProjectKey(repositoryId));
    if (typeof stored !== 'string' || stored.length === 0) return undefined;
    this.#selectedProjects.set(repositoryId, stored);
    return stored;
  }

  private async rememberSelectedProject(repositoryId: RepositoryId, projectId: ProjectId): Promise<void> {
    this.#selectedProjects.set(repositoryId, projectId);
    await this.#identityStore?.update(selectedProjectKey(repositoryId), projectId);
  }

  /**
   * Resolves the project a repository is displayed, analysed and translated
   * with.  An explicit choice always wins; a stale choice is reported so the
   * caller can drop it.  Only a target repository is allowed a default, and
   * only when one real project sits next to pure file groups (the indexer's
   * "unattributed" bucket, e.g. the host-owned `tools/*.mjs` harness): that is
   * not an ambiguous choice, while two real projects still require one.
   */
  private resolveProjectChoice(
    repository: Pick<RepositoryRecord, 'repositoryId' | 'role'>,
    projects: ReadonlyArray<{ projectId: ProjectId; kind?: string }>,
  ): { projectId?: ProjectId; stale: boolean } {
    const requested = this.selectedProjectFor(repository.repositoryId);
    if (requested && projects.some((project) => project.projectId === requested)) {
      return { projectId: requested, stale: false };
    }
    const stale = requested !== undefined;
    if (repository.role === 'history') return { projectId: projects[0]?.projectId, stale };
    if (projects.length === 1) return { projectId: projects[0]?.projectId, stale };
    if (repository.role !== 'target') return { projectId: undefined, stale };
    const real = projects.filter((project) => project.kind !== unattributedProjectKind);
    return { projectId: real.length === 1 && real.length < projects.length ? real[0]!.projectId : undefined, stale };
  }

  /**
   * Drops a choice that no longer resolves in the revision it was made for.
   * The empty write is the removal: the store contract only accepts strings.
   */
  private forgetSelectedProject(repositoryId: RepositoryId): void {
    this.#selectedProjects.delete(repositoryId);
    void Promise.resolve(this.#identityStore?.update(selectedProjectKey(repositoryId), '')).catch(() => undefined);
  }

  private presentationAnalysisStatus(
    repository: Pick<RepositoryRecord, 'repositoryId' | 'activeRevision' | 'analysisStatus'>,
  ): RepositoryAnalysisStatus {
    return this.#readOnlyReadyRevisions.get(repository.repositoryId) === repository.activeRevision
      ? 'ready'
      : repository.analysisStatus;
  }

  private async presentationFor(runtime: CodeIntelligenceRuntime): Promise<CodeIntelligencePresentation> {
    const listed = await runtime.queryPort.listRepositories();
    const repositories = await Promise.all(listed.repositories
      .filter((repository) => this.#visibleRepositoryIds.has(repository.repositoryId))
      .map(async (repository) => {
      const activeRevision = repository.analysisRevision;
      const availableRevisions = await this.revisionPresentations(
        runtime,
        repository.repositoryId,
        activeRevision,
      );
      const selectedRevision = this.selectedRevisionForDisplay(
        repository.repositoryId,
        activeRevision,
        availableRevisions,
      );
      const revisions = availableRevisions.map((revision) => ({
        ...revision,
        isSelected: revision.analysisRevision === selectedRevision?.analysisRevision,
      }));
      if (!selectedRevision) {
        return {
          repositoryId: repository.repositoryId,
          displayName: safeRepositoryDisplayName(repository.displayName),
          role: repository.role,
          analysisStatus: this.presentationAnalysisStatus(repository),
          ...(this.#indexingProgress.has(repository.repositoryId) ? { indexing: this.#indexingProgress.get(repository.repositoryId)! } : {}),
          activeRevision,
          selectedRevision: null,
          revisions,
          languages: [],
          projects: [],
          selectedProjectId: null,
          summary: { status: 'missing' },
        } satisfies CodeIntelligenceRepositoryPresentation;
      }
      const scope = {
        repositoryId: repository.repositoryId,
        analysisRevision: selectedRevision.analysisRevision,
      };
      const [overview, projectsResult] = await Promise.all([
        runtime.queryPort.getRepositoryOverview(scope),
        runtime.queryPort.listProjects(scope),
      ]);
      const projects = await Promise.all(projectsResult.projects.map(async (project) => ({
        projectId: project.value.projectId,
        displayName: project.value.displayName,
        kind: project.value.kind,
        relativePath: project.value.relativePath,
        languageIds: [...project.value.languageIds],
        analysis: projectAnalysisPresentation(await (await this.projectAnalysis()).read(project.value)),
      })));
      const resolved = this.resolveProjectChoice(repository, projects);
      const selectedProjectId = resolved.projectId ?? null;
      if (resolved.stale && selectedRevision.analysisRevision === activeRevision) {
        this.forgetSelectedProject(repository.repositoryId);
      }
      const projectAnalysis = projects.find((project) => project.projectId === selectedProjectId)?.analysis;
      return {
        repositoryId: repository.repositoryId,
        displayName: safeRepositoryDisplayName(repository.displayName),
        role: repository.role,
        analysisStatus: this.presentationAnalysisStatus(repository),
        ...(this.#indexingProgress.has(repository.repositoryId) ? { indexing: this.#indexingProgress.get(repository.repositoryId)! } : {}),
        activeRevision,
        selectedRevision: selectedRevision.analysisRevision,
        revisions,
        languages: overview.overview.value.languages.map((language) => ({ ...language })),
        projects,
        selectedProjectId,
        summary: projectAnalysis?.modelingSkippedReason ? { status: 'missing' } : projectAnalysis?.proposal || projectAnalysis?.state === 'stale' ? {
          status: projectAnalysis?.state === 'stale' ? 'stale' : projectAnalysis?.proposal ? 'current' : 'missing',
          analysisRevision: selectedRevision.analysisRevision,
          ...(projectAnalysis?.planHash ? { planHash: projectAnalysis.planHash } : {}),
        } : await this.summaryPresentation(
          runtime,
          scope,
          activeRevision
            ? { repositoryId: repository.repositoryId, analysisRevision: activeRevision }
            : null,
        ),
      } satisfies CodeIntelligenceRepositoryPresentation;
      }));
    const message = this.#lastFailure
      ? '部分仓库索引失败；请检查扩展输出日志。'
      : this.#storageKind === 'memory'
        ? memoryStorageNotice()
        : undefined;
    const presentation: CodeIntelligencePresentation = {
      status: this.#lastFailure ? 'error' : 'ready', runtimeStatus: 'ready',
      storage: this.#storageKind,
      repositories: repositories.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
      ...(message ? { message } : {}),
    };
    this.#lastPresentation = structuredClone(presentation);
    return presentation;
  }

  private async revisionPresentations(
    runtime: CodeIntelligenceRuntime,
    repositoryId: RepositoryId,
    activeRevision: string | null,
  ): Promise<CodeIntelligenceRepositoryPresentation['revisions']> {
    const records = await runtime.store.listRevisions(repositoryId);
    const candidates = await Promise.all(records.map(async (revision) => {
      if (!isReadOnlyQueryableRevision(revision)) return null;
      const index = await (runtime.store.getStructuralIndexMetadata?.(revision) ?? runtime.store.getStructuralIndex(revision));
      if (!index || index.analysisHash !== revision.analysisHash) return null;
      return {
        analysisRevision: revision.analysisRevision,
        analysisHash: revision.analysisHash,
        status: revision.status,
        createdAt: revision.createdAt,
        ...(revision.completedAt ? { completedAt: revision.completedAt } : {}),
        isActive: revision.analysisRevision === activeRevision,
        isSelected: false,
      } satisfies CodeIntelligenceRepositoryPresentation['revisions'][number];
    }));
    return candidates
      .filter((revision): revision is NonNullable<typeof revision> => revision !== null)
      .sort((left, right) => (
        Number(right.isActive) - Number(left.isActive) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.analysisRevision.localeCompare(right.analysisRevision)
      ));
  }

  private selectedRevisionForDisplay(
    repositoryId: RepositoryId,
    activeRevision: string | null,
    revisions: CodeIntelligenceRepositoryPresentation['revisions'],
  ): CodeIntelligenceRepositoryPresentation['revisions'][number] | null {
    const requested = this.#selectedRevisions.get(repositoryId);
    const selected = requested
      ? revisions.find((revision) => revision.analysisRevision === requested)
      : undefined;
    if (requested && !selected) this.#selectedRevisions.delete(repositoryId);
    return selected ?? revisions.find((revision) => revision.analysisRevision === activeRevision) ?? null;
  }

  private async summaryPresentation(
    runtime: CodeIntelligenceRuntime,
    displayedScope: RepositoryRevisionScope,
    activeScope: RepositoryRevisionScope | null,
  ): Promise<CodeIntelligenceSummaryPresentation> {
    const displayedRevision = await runtime.store.getRevision(displayedScope);
    if (!displayedRevision) return { status: 'missing' };
    const displayedArtifacts = await runtime.store.listModuleArtifacts(displayedScope);

    // Historical revision selection is a view/query concern only. Its summary
    // cannot be presented as current when a different active revision exists.
    if (!activeScope || activeScope.analysisRevision !== displayedScope.analysisRevision) {
      const historical = latestSummaryArtifact(displayedArtifacts, displayedRevision);
      if (!historical) return { status: 'missing' };
      return {
        status: 'stale',
        analysisRevision: displayedScope.analysisRevision,
        analysisHash: historical.analysisHash,
        planHash: historical.planHash,
        updatedAt: historical.updatedAt,
      };
    }

    const current = summaryArtifact(displayedArtifacts, displayedRevision);
    if (current) {
      return {
        status: 'current',
        analysisRevision: displayedScope.analysisRevision,
        analysisHash: current.analysisHash,
        planHash: current.planHash,
        updatedAt: current.updatedAt,
      };
    }

    const revisions = await runtime.store.listRevisions(displayedScope.repositoryId);
    for (const revision of revisions) {
      if (revision.analysisRevision === displayedScope.analysisRevision) continue;
      const artifacts = await runtime.store.listModuleArtifacts(revision);
      const stale = latestSummaryArtifact(artifacts, revision);
      if (stale) {
        return {
          status: 'stale',
          analysisRevision: revision.analysisRevision,
          analysisHash: stale.analysisHash,
          planHash: stale.planHash,
          updatedAt: stale.updatedAt,
        };
      }
    }
    return { status: 'missing' };
  }

  private unavailablePresentation(): CodeIntelligencePresentation {
    if (!this.#lastPresentation) return this.emptyPresentation('error', genericRuntimeFailure());
    const previous = structuredClone(this.#lastPresentation);
    return {
      ...previous, status: 'error', runtimeStatus: 'error',
      message: '状态更新暂时失败，显示上次读取的结果；请稍后刷新或查看扩展输出。',
      repositories: previous.repositories.filter(repository => this.#visibleRepositoryIds.has(repository.repositoryId)).map(repository => {
        const { indexing: _previousProgress, ...snapshot } = repository;
        const indexing = this.#indexingProgress.get(repository.repositoryId);
        return { ...snapshot, ...(indexing ? { analysisStatus: 'indexing' as const, indexing: { ...indexing } } : {}) };
      }),
    };
  }

  private emptyPresentation(
    status: Extract<CodeIntelligencePresentation['status'], 'initializing' | 'error'>,
    message?: string,
  ): CodeIntelligencePresentation {
    return {
      status,
      storage: this.#storageKind,
      repositories: [],
      ...(message ? { message } : {}),
    };
  }

  private logFailure(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#output?.appendLine(`[forexplore] ${action}: ${detail}`);
  }
}

/**
 * SeekDB credentials stay in the local extension process environment.  Empty
 * configuration intentionally selects the in-memory development store rather
 * than guessing credentials or turning a Webview setting into a DB capability.
 */
export function codeIntelligenceRuntimeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: CodeIntelligenceEnvironmentOptions = {},
): CreateCodeIntelligenceRuntimeOptions {
  const database = environment.CODE_INTELLIGENCE_SEEKDB_DATABASE?.trim();
  if (!database) {
    if (options.allowInMemory === false) {
      throw new Error(
        'CODE_INTELLIGENCE_SEEKDB_DATABASE must be configured for a production code-intelligence host.',
      );
    }
    return {};
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_DATABASE must be a SQL identifier.');
  }
  const portValue = environment.CODE_INTELLIGENCE_SEEKDB_PORT?.trim();
  const port = portValue === undefined || portValue === '' ? 2881 : Number(portValue);
  const vectorDimensionValue = environment.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION?.trim();
  const vectorDimension = vectorDimensionValue === undefined || vectorDimensionValue === ''
    ? 384
    : Number(vectorDimensionValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_PORT must be a valid TCP port.');
  }
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION must be a positive integer.');
  }
  const connectionLimitValue = environment.CODE_INTELLIGENCE_SEEKDB_CONNECTION_LIMIT?.trim();
  const connectionLimit = connectionLimitValue ? Number(connectionLimitValue) : undefined;
  if (connectionLimit !== undefined && (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 64)) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_CONNECTION_LIMIT must be an integer in 1..64.');
  }
  const searchQueryConcurrencyValue = environment.CODE_INTELLIGENCE_SEARCH_SQL_CONCURRENCY?.trim();
  const searchQueryConcurrency = searchQueryConcurrencyValue ? Number(searchQueryConcurrencyValue) : undefined;
  if (searchQueryConcurrency !== undefined && (!Number.isInteger(searchQueryConcurrency) || searchQueryConcurrency < 0 || searchQueryConcurrency > 32)) {
    throw new Error('CODE_INTELLIGENCE_SEARCH_SQL_CONCURRENCY must be an integer in 0..32.');
  }
  const embeddingUrl = environment.CODE_INTELLIGENCE_EMBEDDING_URL?.trim();
  const embeddingModel = environment.CODE_INTELLIGENCE_EMBEDDING_MODEL?.trim();
  if (Boolean(embeddingUrl) !== Boolean(embeddingModel)) throw new Error('Configure both CODE_INTELLIGENCE_EMBEDDING_URL and CODE_INTELLIGENCE_EMBEDDING_MODEL.');
  const rerankerUrl = environment.CODE_INTELLIGENCE_RERANK_URL?.trim();
  const rerankerModel = environment.CODE_INTELLIGENCE_RERANK_MODEL?.trim();
  if (Boolean(rerankerUrl) !== Boolean(rerankerModel)) throw new Error('Configure both CODE_INTELLIGENCE_RERANK_URL and CODE_INTELLIGENCE_RERANK_MODEL.');
  return {
    ...(rerankerUrl && rerankerModel ? { moduleReranker: { url: rerankerUrl, model: rerankerModel,
      timeoutMs: Number(environment.CODE_INTELLIGENCE_RERANK_TIMEOUT_MS ?? 4_000) } } : {}),
    seekdb: {
      host: environment.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1',
      port,
      user: environment.CODE_INTELLIGENCE_SEEKDB_USER?.trim() || 'root',
      password: environment.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '',
      database,
      vectorDimension,
      ...(connectionLimit !== undefined ? { connectionLimit } : {}),
      ...(searchQueryConcurrency !== undefined ? { searchQueryConcurrency } : {}),
      ...(embeddingUrl && embeddingModel ? { embedding: {
        url: embeddingUrl, model: embeddingModel, apiKey: environment.CODE_INTELLIGENCE_EMBEDDING_API_KEY ?? '',
        supportsDimensions: environment.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS !== 'false',
        queryPrefix: environment.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ?? '',
        documentPrefix: environment.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ?? '',
        // Which device and precision produced a vector changes the vector, so it
        // belongs to the model identity that scopes embedding reuse. Without it a
        // projection can silently keep vectors from a different provider, which is
        // how a q8/CPU index survived a switch to the GPU.
        variant: environment.CODE_INTELLIGENCE_EMBEDDING_VARIANT?.trim() || undefined,
      } } : {}),
    },
  };
}

export const codeIntelligenceHostInternals = {
  compilerProbeFilesMatchStructuralIndex,
  contentHash,
  isJavaCsharpLegacyFile,
  memoryStorageNotice,
  preferredRepositoryInputs,
  repositoryInputKey,
  safeRepositoryDisplayName,
  stableIdentityKey,
  summaryArtifact,
};
