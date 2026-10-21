import { initializeSchema, schemaInitializationError, isSchemaBusy, type SchemaInitializationOptions } from './schema-initialization.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { queryRows } from './abortable-query.js';
import { SearchQueryGate } from './search-query-gate.js';
import { seekDbQueryTimeoutMs } from './seekdb-timeouts.js';
import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type {
  AnalysisRevisionRecord,
  DependencyEdgeRecord,
  IndexDiagnosticRecord,
  IndexedFileRecord,
  ModuleArtifactRecord,
  ProjectRecord,
  RepositoryAnalysisStatus,
  RepositoryId,
  RepositoryRecord,
  RepositoryRevisionScope,
  SearchDocumentRecord,
  SourceRange,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import {
  assertRelativePath,
  validateModuleArtifact,
  validateRevisionWrite,
  validateSearchDocumentRecords,
  validateSearchDocumentsAgainstIndex,
  validateStructuralIndex,
  validateSourceTexts,
  validateSummaryReplacement,
  validateLocalQuery,
  sliceSourceText,
  projectionFactLookup,
  type IndexStore,
  type LocalDependencyQuery,
  type LocalSymbolQuery,
  type SourceSlice,
  type SourceTextReader,
  type ProjectionFactLookup,
  type RevisionStatistics,
  type SearchDocumentQuery,
  type SearchDocumentsByView,
} from './index-store.js';
import {
  HashSearchEmbeddingProvider,
  ModelSearchEmbeddingProvider,
  type ModelSearchEmbeddingConfig,
  type SearchEmbeddingProvider,
} from './search-embedding.js';

const lexicalMetadataLine = /^(?:目标|target)\s*(?:语言|工程|项目|仓库|language|project|repository)\s*[:：=]/iu;
const lexicalBoilerplate = /(?:目标(?:语言|工程|项目|仓库)\s*[:：=][^\n]*|共同构成|用于|提供|包含|负责|定义|实现|以及|其中)/giu;
const lexicalStopWords = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'module', 'project', 'target', 'language', 'repository',
  // Java/C# declarations occur in nearly every indexed file. They are useful
  // to the vector channel, but make the full-text channel scan broad portions
  // of a mixed-language corpus without identifying a behavior or symbol.
  'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'class', 'interface', 'enum',
  'record', 'package', 'import', 'namespace', 'using', 'extends', 'implements', 'override', 'virtual',
  'void', 'object', 'string', 'boolean', 'bool', 'int', 'long', 'double', 'float', 'byte', 'char',
  'return', 'throws', 'throw', 'new', 'null', 'true', 'false', 'async', 'await', 'this', 'base', 'get', 'set',
  'input', 'output', 'args', 'value', 'result', 'context',
  'implement', 'define', 'provide', 'reusable', 'existing', 'must', 'through', 'into',
  'complete', 'preserve', 'without', 'business', 'behavior', 'domain', 'application',
]);

/**
 * The vector channel needs the complete requirement. Full-text search does
 * better with a short set of distinct content terms: build metadata and repeated
 * prose otherwise match huge portions of a code corpus before the scope filter
 * is applied. Identifiers and Chinese compound terms are retained; only exact
 * boilerplate tokens are removed. An empty result falls back to the original
 * bounded query.
 */
export function compactLexicalQuery(query: string, maxChars = 4_096, maxTerms = 16): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const rawLine of query.normalize('NFKC').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || lexicalMetadataLine.test(line)) continue;
    const cleaned = line.replace(lexicalBoilerplate, ' ');
    for (const rawTerm of cleaned.split(/[^\p{L}\p{N}_.:$/-]+/u)) {
      const term = rawTerm.trim();
      if (!term || term.length < 2 || lexicalStopWords.has(term.toLocaleLowerCase())) continue;
      const key = term.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
  }
  // Natural-language full-text matching unions every posting list before
  // the revision filter. A long but valid requirement can therefore scan
  // most of the corpus even after stop-word removal. Bound that lexical work;
  // the vector channel still receives the complete unmodified requirement.
  const compacted = terms.slice(0, maxTerms).join(' ').slice(0, maxChars).trim();
  return compacted || query.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export interface SeekDbIndexStoreConfig {
  initialization?: SchemaInitializationOptions;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Connections shared by search, metadata reads and indexing. */
  connectionLimit?: number;
  /** Concurrent full-text/vector SQL; zero leaves scheduling to the pool. */
  searchQueryConcurrency?: number;
  structuralBatchRows?: number;
  /** Kept for the vector-capable search_documents projection. */
  vectorDimension?: number;
  /** Host-configured model embedding provider; deterministic hashing is the safe local fallback. */
  embeddingProvider?: SearchEmbeddingProvider;
  embedding?: ModelSearchEmbeddingConfig;
}

interface RepositoryRow extends RowDataPacket {
  repository_id: string | Buffer;
  display_name: string;
  local_path: string;
  role: RepositoryRecord['role'];
  analysis_status: RepositoryRecord['analysisStatus'];
  active_revision: string | Buffer | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface RevisionRow extends RowDataPacket {
  repository_id: string | Buffer;
  analysis_revision: string | Buffer;
  status: AnalysisRevisionRecord['status'];
  analysis_hash: string;
  source_revision: string | null;
  indexer_version: string;
  created_at: string | Date;
  completed_at: string | Date | null;
  activated_at: string | Date | null;
  failure_reason: string | null;
  failure_stage?: AnalysisRevisionRecord['failureStage'] | null;
}

interface ProjectRow extends RowDataPacket {
  project_id: string | Buffer;
  kind: string;
  display_name: string;
  relative_path: string;
  manifest_paths: string | string[];
  source_roots: string | string[];
  test_roots: string | string[];
  language_ids: string | string[];
}

interface FileRow extends RowDataPacket {
  file_id: string | Buffer;
  relative_path: string;
  language_id: string | null;
  role: IndexedFileRecord['role'];
  sha256: string;
  size_bytes: number | string;
  parse_status: IndexedFileRecord['parseStatus'];
  project_id: string | Buffer | null;
  source_text?: string | null;
}

interface SymbolRow extends RowDataPacket {
  symbol_id: string | Buffer;
  symbol_key: string;
  ast_declaration_id: string;
  name: string;
  qualified_name: string;
  kind: SymbolRecord['kind'];
  language_id: string;
  relative_path: string;
  source_range: string | object;
  signature: string | null;
  container_symbol_key: string | null;
  project_id: string | Buffer | null;
  exported: number | boolean;
  provider: SymbolRecord['provider'];
  confidence: number | string;
  evidence_level: SymbolRecord['evidenceLevel'];
}

interface DependencyRow extends RowDataPacket {
  dependency_edge_id: string | Buffer;
  kind: DependencyEdgeRecord['kind'];
  source_symbol_key: string | null;
  target_symbol_key: string | null;
  source_relative_path: string;
  target_relative_path: string | null;
  target_reference: string | null;
  internal: number | boolean;
  resolution: DependencyEdgeRecord['resolution'];
  provider: DependencyEdgeRecord['provider'];
  confidence: number | string;
  evidence_level: DependencyEdgeRecord['evidenceLevel'];
  evidence_ranges: string | object;
}

interface DiagnosticRow extends RowDataPacket {
  diagnostic_id: string | Buffer;
  severity: IndexDiagnosticRecord['severity'];
  message: string;
  code: string | null;
  relative_path: string | null;
  source_range: string | object | null;
  provider: IndexDiagnosticRecord['provider'];
  confidence: number | string;
  evidence_level: IndexDiagnosticRecord['evidenceLevel'];
}

interface ModuleArtifactRow extends RowDataPacket {
  module_artifact_id: string | Buffer;
  kind: ModuleArtifactRecord['kind'];
  status: ModuleArtifactRecord['status'];
  analysis_hash: string;
  plan_hash: string | null;
  content_hash: string;
  created_at: string | Date;
  updated_at: string | Date;
  payload: string | object | null;
}

interface SearchDocumentRow extends RowDataPacket {
  search_document_id: string | Buffer;
  kind: SearchDocumentRecord['kind'];
  relative_path: string | null;
  symbol_key: string | null;
  source_range?: string | object | null;
  module_artifact_id: string | Buffer | null;
  content_hash: string;
  title: string;
  document_text: string;
  text_score?: number | string;
  semantic_score?: number | string;
}

function vectorHex(vector: readonly number[]): string {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return `X'${buffer.toString('hex')}'`;
}

function assertEmbedding(vector: readonly number[], dimension: number): void {
  if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Search embedding must contain ${dimension} finite values.`);
  }
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('SeekDB database identifiers may contain only letters, digits, and _.');
  }
  return `\`${value}\``;
}

function stringValue(value: string | Buffer | null): string | null {
  if (value === null) return null;
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function timestamp(value: string | Date | null): string | undefined {
  if (value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numberValue(value: number | string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`SeekDB returned an invalid number: ${String(value)}`);
  return result;
}

function booleanValue(value: number | boolean): boolean {
  return value === true || value === 1;
}

function json<T>(value: string | object | null, fallback: T): T {
  if (value === null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  const parsed = json<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function scopeParams(scope: RepositoryRevisionScope): [string, string] {
  return [scope.repositoryId, scope.analysisRevision];
}

function toRepository(row: RepositoryRow): RepositoryRecord {
  return {
    repositoryId: stringValue(row.repository_id)!,
    displayName: row.display_name,
    localPath: row.local_path,
    role: row.role,
    analysisStatus: row.analysis_status,
    activeRevision: stringValue(row.active_revision),
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}

function toRevision(row: RevisionRow): AnalysisRevisionRecord {
  const sourceRevision = row.source_revision ?? undefined;
  const completedAt = timestamp(row.completed_at);
  const activatedAt = timestamp(row.activated_at);
  const failureReason = row.failure_reason ?? undefined;
  return {
    repositoryId: stringValue(row.repository_id)!,
    analysisRevision: stringValue(row.analysis_revision)!,
    status: row.status,
    analysisHash: row.analysis_hash,
    ...(sourceRevision ? { sourceRevision } : {}),
    indexerVersion: row.indexer_version,
    createdAt: timestamp(row.created_at)!,
    ...(completedAt ? { completedAt } : {}),
    ...(activatedAt ? { activatedAt } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(row.failure_stage ? { failureStage: row.failure_stage } : {}),
  };
}

function toProject(scope: RepositoryRevisionScope, row: ProjectRow): ProjectRecord {
  return {
    ...scope,
    projectId: stringValue(row.project_id)!,
    kind: row.kind,
    displayName: row.display_name,
    relativePath: row.relative_path,
    manifestPaths: jsonArray(row.manifest_paths),
    sourceRoots: jsonArray(row.source_roots),
    testRoots: jsonArray(row.test_roots),
    languageIds: jsonArray(row.language_ids),
  };
}

function toFile(scope: RepositoryRevisionScope, row: FileRow): IndexedFileRecord {
  const languageId = row.language_id ?? undefined;
  const projectId = stringValue(row.project_id);
  return {
    ...scope,
    fileId: stringValue(row.file_id)!,
    relativePath: row.relative_path,
    ...(languageId ? { languageId } : {}),
    role: row.role,
    sha256: row.sha256,
    sizeBytes: numberValue(row.size_bytes),
    parseStatus: row.parse_status,
    ...(projectId ? { projectId } : {}),
  };
}

function toSymbol(scope: RepositoryRevisionScope, row: SymbolRow): SymbolRecord {
  const signature = row.signature ?? undefined;
  const containerSymbolKey = row.container_symbol_key ?? undefined;
  const projectId = stringValue(row.project_id);
  return {
    ...scope,
    symbolId: stringValue(row.symbol_id)!,
    symbolKey: row.symbol_key,
    astDeclarationId: row.ast_declaration_id,
    name: row.name,
    qualifiedName: row.qualified_name,
    kind: row.kind,
    languageId: row.language_id,
    relativePath: row.relative_path,
    sourceRange: json(row.source_range, {} as SymbolRecord['sourceRange']),
    ...(signature ? { signature } : {}),
    ...(containerSymbolKey ? { containerSymbolKey } : {}),
    ...(projectId ? { projectId } : {}),
    exported: booleanValue(row.exported),
    provider: row.provider,
    confidence: numberValue(row.confidence),
    evidenceLevel: row.evidence_level,
  };
}

function toDependency(scope: RepositoryRevisionScope, row: DependencyRow): DependencyEdgeRecord {
  const sourceSymbolKey = row.source_symbol_key ?? undefined;
  const targetSymbolKey = row.target_symbol_key ?? undefined;
  const targetRelativePath = row.target_relative_path ?? undefined;
  const targetReference = row.target_reference ?? undefined;
  return {
    ...scope,
    dependencyEdgeId: stringValue(row.dependency_edge_id)!,
    kind: row.kind,
    ...(sourceSymbolKey ? { sourceSymbolKey } : {}),
    ...(targetSymbolKey ? { targetSymbolKey } : {}),
    sourceRelativePath: row.source_relative_path,
    ...(targetRelativePath ? { targetRelativePath } : {}),
    ...(targetReference ? { targetReference } : {}),
    internal: booleanValue(row.internal),
    resolution: row.resolution,
    provider: row.provider,
    confidence: numberValue(row.confidence),
    evidenceLevel: row.evidence_level,
    evidenceRanges: json(row.evidence_ranges, []),
  };
}

function toDiagnostic(scope: RepositoryRevisionScope, row: DiagnosticRow): IndexDiagnosticRecord {
  const code = row.code ?? undefined;
  return {
    ...scope,
    diagnosticId: stringValue(row.diagnostic_id)!,
    severity: row.severity,
    message: row.message,
    ...(code ? { code } : {}),
    relativePath: row.relative_path,
    sourceRange: json(row.source_range, null),
    provider: row.provider,
    confidence: numberValue(row.confidence),
    evidenceLevel: row.evidence_level,
  };
}

function toModuleArtifact(scope: RepositoryRevisionScope, row: ModuleArtifactRow): ModuleArtifactRecord {
  const planHash = row.plan_hash ?? undefined;
  const payload = json<unknown>(row.payload, undefined);
  return {
    ...scope,
    moduleArtifactId: stringValue(row.module_artifact_id)!,
    kind: row.kind,
    status: row.status,
    analysisHash: row.analysis_hash,
    ...(planHash ? { planHash } : {}),
    contentHash: row.content_hash,
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
    ...(payload === undefined ? {} : { payload }),
  };
}

function toSearchDocument(scope: RepositoryRevisionScope, row: SearchDocumentRow): SearchDocumentRecord {
  const symbolKey = row.symbol_key ?? undefined;
  const moduleArtifactId = stringValue(row.module_artifact_id);
  return {
    ...scope,
    searchDocumentId: stringValue(row.search_document_id)!,
    kind: row.kind,
    relativePath: row.relative_path,
    ...(symbolKey ? { symbolKey } : {}),
    ...(row.source_range ? { sourceRange: json<SourceRange | undefined>(row.source_range, undefined) } : {}),
    ...(moduleArtifactId ? { moduleArtifactId } : {}),
    contentHash: row.content_hash,
    title: row.title,
    text: row.document_text,
  };
}

/** Call only for reads or writes whose committed result can be recognized on retry. */
async function retryTransientSql<T>(operation: () => Promise<T>, signal?: AbortSignal,
  wait: (ms: number) => Promise<unknown> = ms => delay(ms, undefined, { signal })): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      const failure = error as { code?: string; errno?: number; message?: string };
      const transient = ['ER_QUERY_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT',
        'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(failure?.code ?? '') ||
        [4012, 1205, 1213].includes(failure?.errno ?? 0) || /maximum query timeout|query has reached.*timeout/i.test(failure?.message ?? '');
      if (!transient || attempt >= 2) throw error;
      console.warn('[forexplore] Retrying transient database operation', { attempt: attempt + 1, code: failure.code, errno: failure.errno });
      await wait(1000 * (attempt + 1));
    }
  }
}

async function withTransaction<T>(pool: Pool, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  let previousTimeout: number | undefined;
  let timeoutChanged = false;
  let transactionStarted = false;
  let reusable = true;
  const started = performance.now();
  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT @@session.ob_query_timeout AS query_timeout');
    previousTimeout = Number(rows[0]!.query_timeout);
    // Bulk index writes also pay for secondary indexes and log flushes at COMMIT.
    const ceiling = seekDbQueryTimeoutMs * 1_000;
    if (previousTimeout > 0 && previousTimeout < ceiling) {
      await connection.query('SET SESSION ob_query_timeout = ?', [ceiling]);
      timeoutChanged = true;
    }
    await connection.beginTransaction();
    transactionStarted = true;
    const value = await operation(connection);
    const commitStarted = performance.now();
    await connection.commit();
    transactionStarted = false;
    console.info('[forexplore:performance]', JSON.stringify({ stage: 'seekdb-transaction',
      durationMs: Math.round(performance.now() - started), commitMs: Math.round(performance.now() - commitStarted) }));
    return value;
  } catch (error) {
    if (transactionStarted) {
      try { await connection.rollback(); }
      catch { reusable = false; }
    }
    throw error;
  } finally {
    if (timeoutChanged && reusable) {
      try { await connection.query('SET SESSION ob_query_timeout = ?', [previousTimeout]); }
      catch { reusable = false; }
    }
    if (reusable) connection.release();
    else connection.destroy();
  }
}

type InsertRow = { values: unknown[]; vector?: string };

/** Fused score of one search document inside a single view. */
type RankedScores = { score: number; retrievalScore: NonNullable<SearchDocumentRecord['retrievalScore']> };

function* insertRows<T>(rows: readonly T[], convert: (row: T, index: number) => InsertRow): Iterable<InsertRow> {
  for (let index = 0; index < rows.length; index++) yield convert(rows[index]!, index);
}

// Limit both row count and escaped SQL size; a single large source stays intact.
async function insertBatches(connection: PoolConnection, sql: string, rows: Iterable<InsertRow>): Promise<number> {
  let batch: InsertRow[] = [];
  let bytes = 0;
  let statements = 0;
  const flush = async () => {
    if (!batch.length) return;
    const tuples = batch.map((row) => `(${row.values.map(() => '?').join(', ')}${row.vector ? `, ${row.vector}` : ''})`);
    await connection.query(`${sql} VALUES ${tuples.join(', ')}`, batch.flatMap((row) => row.values));
    statements += 1;
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = row.values.reduce<number>((total, value) => total +
      (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') * 2 + 2 : 32), 0) + (row.vector?.length ?? 0);
    if (batch.length && (batch.length >= 250 || bytes + size > 512 * 1024)) await flush();
    batch.push(row);
    bytes += size;
  }
  await flush();
  return statements;
}

/** Owning project stored beside each search document, so project-scoped recall filters inside the vector pre-filter. */
function searchDocumentProjectId(document: SearchDocumentRecord, filesByPath: ReadonlyMap<string, IndexedFileRecord>): string | null {
  if (document.kind !== 'summary') return (document.relativePath === null ? undefined : filesByPath.get(document.relativePath)?.projectId) ?? null;
  try {
    const { projectId } = JSON.parse(document.text) as { projectId?: unknown };
    return typeof projectId === 'string' ? projectId : null;
  } catch {
    return null;
  }
}

/** Version of the last migration in SeekDbIndexStore.#migrate(); read-only tools compare against it. */
export const seekDbSchemaVersion = 5;

function connectionLimit(config: SeekDbIndexStoreConfig): number {
  const limit = config.connectionLimit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('SeekDB connection limit must be an integer in 1..64.');
  return limit;
}

/**
 * SeekDB persistence for the authoritative revision model. It uses dedicated
 * tables instead of expanding legacy `code_symbols`; each replacement DELETE
 * is bound to one repository + analysis revision.
 */
export class SeekDbIndexStore implements IndexStore {
  readonly #projectionFacts = new WeakMap<StructuralIndex, ProjectionFactLookup>();
  readonly #structuralBatchRows: number;
  readonly #database: string;
  readonly #tables: Record<string, string>;
  readonly #vectorDimension: number;
  readonly #embeddingProvider: SearchEmbeddingProvider;
  readonly #embeddingIdentity: string;
  readonly #legacyHashCompatible: boolean;
  readonly #persistEmbeddings: boolean;
  #persistentEmbeddingHits = 0;
  #embeddingProviderDocuments = 0;
  readonly #searchQueryGate: SearchQueryGate | undefined;

  constructor(private readonly config: SeekDbIndexStoreConfig, private readonly pool: Pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectionLimit: connectionLimit(config),
    enableKeepAlive: true,
    decimalNumbers: true,
  } satisfies PoolOptions)) {
    connectionLimit(config);
    const concurrency = config.searchQueryConcurrency ?? 0;
    if (!Number.isInteger(concurrency) || concurrency < 0 || concurrency > 32) throw new Error('Search SQL concurrency must be an integer in 0..32.');
    this.#searchQueryGate = concurrency ? new SearchQueryGate(concurrency) : undefined;
    this.#structuralBatchRows = config.structuralBatchRows ?? 250;
    if (!Number.isInteger(this.#structuralBatchRows) || this.#structuralBatchRows < 1 || this.#structuralBatchRows > 2048) throw new Error('Structural batch rows must be in 1..2048.');
    this.#database = identifier(config.database);
    this.#vectorDimension = config.vectorDimension ?? 384;
    if (!Number.isInteger(this.#vectorDimension) || this.#vectorDimension < 1) {
      throw new Error('SeekDB vectorDimension must be a positive integer.');
    }
    if (config.embeddingProvider && config.embedding) throw new Error('Choose an embedding provider or model configuration.');
    if (config.embeddingProvider && !config.embeddingProvider.identity?.trim()) {
      throw new Error('Custom persisted embedding providers require an immutable model/configuration identity.');
    }
    this.#embeddingProvider = config.embeddingProvider ?? (config.embedding
      ? new ModelSearchEmbeddingProvider(this.#vectorDimension, config.embedding)
      : new HashSearchEmbeddingProvider(this.#vectorDimension));
    this.#legacyHashCompatible = !config.embedding && !config.embeddingProvider;
    this.#persistEmbeddings = Boolean(config.embedding);
    // Every pooled session gets the raised ceiling: a recall can wait behind an
    // indexing COMMIT, and the 10 s server default then fails the whole search
    // ("query has reached the maximum query timeout").  Registered before the
    // first statement, so no query runs under the default.
    const registerSessionCeiling = (this.pool as unknown as {
      on?: (event: 'connection', listener: (connection: unknown) => void) => unknown;
    }).on;
    if (typeof registerSessionCeiling === 'function') {
      registerSessionCeiling.call(this.pool, 'connection', (connection: unknown) => {
        const statement = `SET SESSION ob_query_timeout = ${seekDbQueryTimeoutMs * 1_000}`;
        // The pool event hands over the callback-style connection, whose query()
        // is not a promise; use the wrapper when it exists and ignore the rest.
        const promiseFactory = (connection as { promise?: () => { query: (sql: string) => Promise<unknown> } }).promise;
        if (typeof promiseFactory === 'function') {
          void promiseFactory.call(connection).query(statement).catch(() => undefined);
          return;
        }
        try {
          (connection as { query: (sql: string, callback: () => void) => unknown }).query(statement, () => undefined);
        } catch {
          // A pool double without query support must not break construction.
        }
      });
    }
    this.#embeddingIdentity = createHash('sha256').update(JSON.stringify({
      dimension: this.#vectorDimension,
      provider: config.embedding ? 'model-v1' : config.embeddingProvider ? config.embeddingProvider.identity : 'hash-v1',
      ...(config.embedding ? { url: config.embedding.url, model: config.embedding.model,
        queryPrefix: config.embedding.queryPrefix ?? '', documentPrefix: config.embedding.documentPrefix ?? '',
        supportsDimensions: config.embedding.supportsDimensions ?? true } : {}),
    })).digest('hex');
    if (this.#embeddingProvider.dimension !== this.#vectorDimension) {
      throw new Error('SeekDB embeddingProvider dimension must match vectorDimension.');
    }
    const qualify = (name: string): string => `${this.#database}.${identifier(name)}`;
    this.#tables = {
      repositories: qualify('repositories'),
      analysisRevisions: qualify('analysis_revisions'),
      projects: qualify('projects'),
      files: qualify('files'),
      symbols: qualify('symbols'),
      dependencyEdges: qualify('dependency_edges'),
      moduleArtifacts: qualify('module_artifacts'),
      searchDocuments: qualify('search_documents'),
      embeddingConfiguration: qualify('search_embedding_configuration'),
      embeddingCache: qualify('search_embedding_cache'),
      diagnostics: qualify('index_diagnostics'),
      schemaMigrations: qualify('schema_migrations'),
    };
  }

  async initialize(): Promise<void> {
    await initializeSchema(this.pool, this.config.database, connection => this.initializeLocked(connection), this.config.initialization);
  }

  private async initializeLocked(connection: PoolConnection): Promise<void> {
    const [versions] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const version = /seekdb-v(\d+)\.(\d+)/i.exec(String(versions[0]?.version ?? ''));
    const supportsAsyncIndex = version !== null && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 3);
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${this.#database}`);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.repositories} (
        repository_id VARCHAR(256) PRIMARY KEY NOT NULL,
        display_name VARCHAR(1024) NOT NULL,
        local_path TEXT NOT NULL,
        role VARCHAR(32) NOT NULL,
        analysis_status VARCHAR(32) NOT NULL,
        active_revision VARCHAR(256) NULL,
        created_at VARCHAR(64) NOT NULL,
        updated_at VARCHAR(64) NOT NULL
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.analysisRevisions} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        status VARCHAR(32) NOT NULL,
        analysis_hash CHAR(64) NOT NULL,
        source_revision VARCHAR(512) NULL,
        indexer_version VARCHAR(512) NOT NULL,
        created_at VARCHAR(64) NOT NULL,
        completed_at VARCHAR(64) NULL,
        activated_at VARCHAR(64) NULL,
        failure_reason TEXT NULL,
        failure_stage VARCHAR(32) NULL,
        PRIMARY KEY (repository_id, analysis_revision),
        INDEX idx_analysis_revisions_repository (repository_id, created_at)
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.projects} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        project_id VARCHAR(256) NOT NULL,
        kind VARCHAR(128) NOT NULL,
        display_name VARCHAR(1024) NOT NULL,
        relative_path VARCHAR(4096) NOT NULL,
        manifest_paths JSON NOT NULL,
        source_roots JSON NOT NULL,
        test_roots JSON NOT NULL,
        language_ids JSON NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, project_id)
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.files} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        file_id VARCHAR(256) NOT NULL,
        relative_path VARCHAR(4096) NOT NULL,
        language_id VARCHAR(128) NULL,
        role VARCHAR(32) NOT NULL,
        sha256 CHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL,
        parse_status VARCHAR(32) NOT NULL,
        project_id VARCHAR(256) NULL,
        source_text LONGTEXT NULL,
        PRIMARY KEY (repository_id, analysis_revision, file_id),
        INDEX idx_files_path (repository_id, analysis_revision, relative_path(512))
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.symbols} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        symbol_id VARCHAR(256) NOT NULL,
        symbol_key VARCHAR(512) NOT NULL,
        ast_declaration_id VARCHAR(512) NOT NULL,
        name VARCHAR(1024) NOT NULL,
        qualified_name TEXT NOT NULL,
        kind VARCHAR(128) NOT NULL,
        language_id VARCHAR(128) NOT NULL,
        relative_path VARCHAR(4096) NOT NULL,
        source_range JSON NOT NULL,
        signature TEXT NULL,
        container_symbol_key VARCHAR(512) NULL,
        project_id VARCHAR(256) NULL,
        exported BOOLEAN NOT NULL,
        provider VARCHAR(64) NOT NULL,
        confidence DOUBLE NOT NULL,
        evidence_level VARCHAR(32) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, symbol_id),
        UNIQUE KEY uq_symbols_key (repository_id, analysis_revision, symbol_key)
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.dependencyEdges} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        dependency_edge_id VARCHAR(256) NOT NULL,
        kind VARCHAR(128) NOT NULL,
        source_symbol_key VARCHAR(512) NULL,
        target_symbol_key VARCHAR(512) NULL,
        source_relative_path VARCHAR(4096) NOT NULL,
        target_relative_path VARCHAR(4096) NULL,
        target_reference TEXT NULL,
        internal BOOLEAN NOT NULL,
        resolution VARCHAR(32) NOT NULL,
        provider VARCHAR(64) NOT NULL,
        confidence DOUBLE NOT NULL,
        evidence_level VARCHAR(32) NOT NULL,
        evidence_ranges JSON NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, dependency_edge_id)
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.diagnostics} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        diagnostic_id VARCHAR(256) NOT NULL,
        severity VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        code VARCHAR(256) NULL,
        relative_path VARCHAR(4096) NULL,
        source_range JSON NULL,
        provider VARCHAR(64) NOT NULL,
        confidence DOUBLE NOT NULL,
        evidence_level VARCHAR(32) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, diagnostic_id)
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.moduleArtifacts} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        module_artifact_id VARCHAR(256) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        analysis_hash CHAR(64) NOT NULL,
        plan_hash VARCHAR(128) NULL,
        content_hash CHAR(64) NOT NULL,
        created_at VARCHAR(64) NOT NULL,
        updated_at VARCHAR(64) NOT NULL,
        payload JSON NULL,
        PRIMARY KEY (repository_id, analysis_revision, module_artifact_id)
      ) ORGANIZATION = HEAP
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.searchDocuments} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        search_document_id VARCHAR(256) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        relative_path VARCHAR(4096) NULL,
        symbol_key VARCHAR(512) NULL,
        source_range JSON NULL,
        module_artifact_id VARCHAR(256) NULL,
        content_hash CHAR(64) NOT NULL,
        title VARCHAR(2048) NOT NULL,
        document_text LONGTEXT NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.#vectorDimension}) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, search_document_id),
        FULLTEXT INDEX idx_search_documents_text (search_text) WITH PARSER ik,
        VECTOR INDEX idx_search_documents_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag${supportsAsyncIndex ? ', SYNC_MODE=immediate' : ''})
      ) ORGANIZATION = HEAP
    `);
    await this.#migrate(connection);
    await connection.query(`CREATE TABLE IF NOT EXISTS ${this.#tables.embeddingConfiguration} (
      slot INT PRIMARY KEY, config_hash CHAR(64) NOT NULL
    ) ORGANIZATION = HEAP`);
    const [configured] = await connection.query<RowDataPacket[]>(`SELECT config_hash FROM ${this.#tables.embeddingConfiguration} WHERE slot = 1`);
    if (!configured.length && !this.#legacyHashCompatible) {
      const [existing] = await connection.query<RowDataPacket[]>(`SELECT search_document_id FROM ${this.#tables.searchDocuments} LIMIT 1`);
      if (existing.length) throw new Error('Existing vectors have no model identity. Use a separate database and rebuild projections for this embedding model.');
    }
    await connection.query(`INSERT IGNORE INTO ${this.#tables.embeddingConfiguration} (slot, config_hash) VALUES (1, ?)`, [this.#embeddingIdentity]);
    const [identity] = await connection.query<RowDataPacket[]>(`SELECT config_hash FROM ${this.#tables.embeddingConfiguration} WHERE slot = 1`);
    if (String(identity[0]?.config_hash) !== this.#embeddingIdentity) {
      throw new Error('Embedding model/configuration does not match stored vectors. Use a separate database and rebuild projections.');
    }
    if (supportsAsyncIndex) {
      const [definitions] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${this.#tables.searchDocuments}`);
      if (!/sync_mode\s*=\s*'?immediate'?/i.test(String(definitions[0]?.['Create Table'] ?? ''))) {
        throw new Error('Existing search index uses an incompatible asynchronous configuration. If the old analysis data is disposable, run scripts/reset-code-intelligence-index.ts --database <database> --apply, then reload the extension and reanalyze the selected repositories.');
      }
    }
    if (this.#persistEmbeddings) await connection.query(`CREATE TABLE IF NOT EXISTS ${this.#tables.embeddingCache} (
      content_hash CHAR(64) PRIMARY KEY, embedding JSON NOT NULL
    ) ORGANIZATION = HEAP`);
  }

  /**
   * The CREATE TABLE statements in initialize() are the frozen baseline; later schema
   * changes are appended here and never edited. Each step is probe-guarded, so a crash
   * between a change and its record only re-runs an idempotent step.
   */
  async #migrate(connection: PoolConnection): Promise<void> {
    const migrations: ReadonlyArray<readonly [version: number, name: string, up: () => Promise<void>]> = [
      [1, 'search_documents.source_range and path/project/symbol lookup indexes', async () => {
        const [sourceRangeColumns] = await connection.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${this.#tables.searchDocuments} LIKE 'source_range'`);
        if (!sourceRangeColumns.length) await connection.query(`ALTER TABLE ${this.#tables.searchDocuments} ADD COLUMN source_range JSON NULL`);
        for (const [table, name, columns] of [
          [this.#tables.files, 'idx_files_project', 'repository_id, analysis_revision, project_id'],
          [this.#tables.symbols, 'idx_symbols_path', 'repository_id, analysis_revision, relative_path(512)'],
          [this.#tables.dependencyEdges, 'idx_dependencies_source_path', 'repository_id, analysis_revision, source_relative_path(512)'],
          [this.#tables.dependencyEdges, 'idx_dependencies_target_path', 'repository_id, analysis_revision, target_relative_path(512)'],
          [this.#tables.dependencyEdges, 'idx_dependencies_source_symbol', 'repository_id, analysis_revision, source_symbol_key'],
          [this.#tables.dependencyEdges, 'idx_dependencies_target_symbol', 'repository_id, analysis_revision, target_symbol_key'],
        ]) {
          const [indexes] = await connection.query<RowDataPacket[]>(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
          if (!indexes.length) await connection.query(`ALTER TABLE ${table} ADD INDEX ${name} (${columns})`);
        }
      }],
      [2, 'search_documents.project_id backfill and scope index', async () => {
        const [projectColumns] = await connection.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${this.#tables.searchDocuments} LIKE 'project_id'`);
        if (!projectColumns.length) await connection.query(`ALTER TABLE ${this.#tables.searchDocuments} ADD COLUMN project_id VARCHAR(256) NULL`);
        await this.backfillSearchDocumentProjects(connection);
        const [indexes] = await connection.query<RowDataPacket[]>(`SHOW INDEX FROM ${this.#tables.searchDocuments} WHERE Key_name = 'idx_search_documents_scope'`);
        if (!indexes.length) await connection.query(`ALTER TABLE ${this.#tables.searchDocuments} ADD INDEX idx_search_documents_scope (repository_id, analysis_revision, kind, project_id)`);
      }],
      [3, 'analysis_revisions.failure_stage for safe parse reuse', async () => {
        const [columns] = await connection.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${this.#tables.analysisRevisions} LIKE 'failure_stage'`);
        if (!columns.length) await connection.query(`ALTER TABLE ${this.#tables.analysisRevisions} ADD COLUMN failure_stage VARCHAR(32) NULL`);
      }],
      [4, 'stored source-fragment eligibility for bounded search', async () => {
        const [columns] = await connection.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${this.#tables.searchDocuments} LIKE 'implementation_eligible'`);
        // A stored generated column applies the same predicate to existing,
        // newly indexed and restored documents. Reading long source text and
        // evaluating REGEXP in each lookup can force a full scope scan instead
        // of the full-text index; eligibility is computed only when a row changes.
        if (!columns.length) await connection.query(`ALTER TABLE ${this.#tables.searchDocuments}
          ADD COLUMN implementation_eligible TINYINT GENERATED ALWAYS AS
            (CASE WHEN kind = 'source-fragment'
              THEN LENGTH(document_text) >= 24 AND document_text REGEXP '[^[:space:]]'
              ELSE 1 END) STORED`);
      }],
      [5, 'covering indexes for revision language statistics', async () => {
        // Status polling must not scan the full symbols table or fetch source
        // rows through a secondary index on every refresh of a large corpus.
        for (const [table, name, columns] of [
          [this.#tables.files, 'idx_files_language_statistics', 'repository_id, analysis_revision, language_id'],
          [this.#tables.symbols, 'idx_symbols_language_statistics', 'repository_id, analysis_revision, language_id, provider'],
        ]) {
          const [indexes] = await connection.query<RowDataPacket[]>(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
          if (!indexes.length) await connection.query(`ALTER TABLE ${table} ADD INDEX ${name} (${columns})`);
        }
      }],
    ];
    await connection.query(`CREATE TABLE IF NOT EXISTS ${this.#tables.schemaMigrations} (
      version INT PRIMARY KEY, name VARCHAR(256) NOT NULL, applied_at VARCHAR(64) NOT NULL
    ) ORGANIZATION = HEAP`);
    const [rows] = await connection.query<RowDataPacket[]>(`SELECT version FROM ${this.#tables.schemaMigrations}`);
    const applied = new Set(rows.map((row) => Number(row.version)));
    const supported = migrations.at(-1)![0];
    if (supported !== seekDbSchemaVersion) throw new Error('seekDbSchemaVersion must equal the last migration version.');
    const current = Math.max(0, ...applied);
    if (current > supported) {
      throw new Error(`Database schema version ${current} is newer than this build supports (${supported}). Upgrade ForeXplore or use a different database.`);
    }
    for (const [version, name, up] of migrations) {
      if (applied.has(version)) continue;
      this.config.initialization?.onProgress?.({ stage: 'migrating', migration: version, message: `正在升级索引数据库（第 ${version} 项），完成后自动继续；请勿关闭窗口…` });
      try { await up(); }
      catch (error) {
        if (isSchemaBusy(error)) throw error;
        throw schemaInitializationError(error, `结构升级 ${version}: ${name}`);
      }
      await connection.query(`INSERT IGNORE INTO ${this.#tables.schemaMigrations} (version, name, applied_at) VALUES (?, ?, ?)`,
        [version, name, new Date().toISOString()]);
    }
  }

  /**
   * Derive search_documents.project_id for rows written without it: rows that predate
   * migration 2, and rows restored from such a backup. Idempotent; touches NULLs only.
   */
  async backfillSearchDocumentProjects(connection: Pick<PoolConnection, 'query'> = this.pool): Promise<void> {
    await connection.query(`UPDATE ${this.#tables.searchDocuments} d JOIN ${this.#tables.files} f
      ON f.repository_id = d.repository_id AND f.analysis_revision = d.analysis_revision AND f.relative_path = d.relative_path
      SET d.project_id = f.project_id WHERE d.kind <> 'summary' AND d.project_id IS NULL`);
    await connection.query(`UPDATE ${this.#tables.searchDocuments}
      SET project_id = JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(document_text), document_text, '{}'), '$.projectId'))
      WHERE kind = 'summary' AND project_id IS NULL`);
  }

  /** Hash of the configured embedding model/configuration, as stored in search_embedding_configuration. */
  get embeddingIdentity(): string {
    return this.#embeddingIdentity;
  }

  get embeddingReuseStats(): { persistentHits: number; providerDocuments: number } {
    return { persistentHits: this.#persistentEmbeddingHits, providerDocuments: this.#embeddingProviderDocuments };
  }

  /** Reuse exact model inputs across revisions and process restarts. Model identity is bound during initialize. */
  private async embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    if (!this.#persistEmbeddings || texts.length === 0) return this.#embeddingProvider.embed(texts, signal);
    const keys = texts.map((text) => createHash('sha256').update(this.#embeddingIdentity).update('\0').update(text).digest('hex'));
    const unique = [...new Map(keys.map((key, index) => [key, texts[index]!])).entries()];
    const vectors = new Map<string, number[]>();
    for (let offset = 0; offset < unique.length; offset += 128) {
      signal?.throwIfAborted();
      const batch = unique.slice(offset, offset + 128);
      const [cached] = await retryTransientSql(() => this.pool.query<RowDataPacket[]>(`SELECT content_hash, embedding FROM ${this.#tables.embeddingCache}
        WHERE content_hash IN (${batch.map(() => '?').join(',')})`, batch.map(([key]) => key)), signal);
      for (const row of cached) {
        const vector = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
        if (!Array.isArray(vector)) throw new Error('Invalid persisted embedding.');
        assertEmbedding(vector, this.#vectorDimension);
        vectors.set(String(row.content_hash), vector);
      }
      this.#persistentEmbeddingHits += cached.length;
      const missing = batch.filter(([key]) => !vectors.has(key));
      for (let start = 0; start < missing.length; start += 16) {
        const inputs = missing.slice(start, start + 16);
        const encoded = await this.#embeddingProvider.embed(inputs.map(([, text]) => text), signal);
        if (encoded.length !== inputs.length) throw new Error('Embedding provider returned an unexpected document count.');
        this.#embeddingProviderDocuments += inputs.length;
        const parameters = inputs.flatMap(([key], index) => {
          const vector = encoded[index]!;
          assertEmbedding(vector, this.#vectorDimension);
          vectors.set(key, vector);
          return [key, JSON.stringify(vector)];
        });
        await retryTransientSql(() => this.pool.query(`INSERT IGNORE INTO ${this.#tables.embeddingCache} (content_hash, embedding)
          VALUES ${inputs.map(() => '(?, ?)').join(',')}`, parameters), signal);
      }
    }
    return keys.map((key) => [...vectors.get(key)!]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async putRepository(repository: RepositoryRecord): Promise<void> {
    await this.pool.query<ResultSetHeader>(`
      INSERT INTO ${this.#tables.repositories} (
        repository_id, display_name, local_path, role, analysis_status, active_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name), local_path = VALUES(local_path), role = VALUES(role),
        analysis_status = VALUES(analysis_status), active_revision = VALUES(active_revision), updated_at = VALUES(updated_at)
    `, [
      repository.repositoryId, repository.displayName, repository.localPath, repository.role,
      repository.analysisStatus, repository.activeRevision, repository.createdAt, repository.updatedAt,
    ]);
  }

  async getRepository(repositoryId: RepositoryId, signal?: AbortSignal): Promise<RepositoryRecord | null> {
    const rows = await queryRows<RepositoryRow[]>(this.pool,
      `SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ?`, [repositoryId], signal,
    );
    const row = rows[0];
    return row ? toRepository(row) : null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const [rows] = await this.pool.query<RepositoryRow[]>(
      `SELECT * FROM ${this.#tables.repositories} ORDER BY repository_id`,
    );
    return rows.map(toRepository);
  }

  async removeRepository(repositoryId: RepositoryId): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const tables = [
        this.#tables.searchDocuments,
        this.#tables.moduleArtifacts,
        this.#tables.dependencyEdges,
        this.#tables.symbols,
        this.#tables.files,
        this.#tables.projects,
        this.#tables.diagnostics,
        this.#tables.analysisRevisions,
        this.#tables.repositories,
      ];
      for (const table of tables) {
        await connection.query(`DELETE FROM ${table} WHERE repository_id = ?`, [repositoryId]);
      }
    });
  }

  async deleteRevision(scope: RepositoryRevisionScope): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      // Lock the pointer so a concurrent activateRevision cannot make the
      // target active between this check and the deletes.
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [scope.repositoryId]);
      if (stringValue(repositories[0]?.active_revision ?? null) === scope.analysisRevision) {
        throw new Error('Cannot delete the active analysis revision.');
      }
      for (const table of [this.#tables.searchDocuments, this.#tables.moduleArtifacts]) {
        await connection.query(`DELETE FROM ${table} WHERE repository_id = ? AND analysis_revision = ?`, scopeParams(scope));
      }
      await this.#deleteRevisionStructuralRecords(connection, scope);
      await connection.query(`DELETE FROM ${this.#tables.analysisRevisions} WHERE repository_id = ? AND analysis_revision = ?`, scopeParams(scope));
    });
  }

  /**
   * Evicts model-embedding cache rows that no stored search document still
   * references. The key is recomputed from `search_text`, the exact model input
   * that `embedDocuments` hashed. Returns the number of evicted rows.
   */
  async pruneEmbeddingCache(): Promise<number> {
    if (!this.#persistEmbeddings) return 0;
    const [result] = await this.pool.query<ResultSetHeader>(`
      DELETE FROM ${this.#tables.embeddingCache} WHERE content_hash NOT IN (
        SELECT SHA2(CONCAT(?, CHAR(0), search_text), 256) FROM ${this.#tables.searchDocuments}
      )
    `, [this.#embeddingIdentity]);
    return result.affectedRows;
  }

  async putRevision(revision: AnalysisRevisionRecord): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT repository_id FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [revision.repositoryId]);
      if (!repositories[0]) {
        throw new Error(`Repository ${revision.repositoryId} is not registered.`);
      }
      const [rows] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(revision));
      const existing = rows[0] ? toRevision(rows[0]) : null;
      validateRevisionWrite(existing, revision);
      if (!existing) {
        await connection.query<ResultSetHeader>(`
          INSERT INTO ${this.#tables.analysisRevisions} (
            repository_id, analysis_revision, status, analysis_hash, source_revision, indexer_version,
            created_at, completed_at, activated_at, failure_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          revision.repositoryId, revision.analysisRevision, revision.status, revision.analysisHash,
          revision.sourceRevision ?? null, revision.indexerVersion, revision.createdAt,
          null, null, null,
        ]);
        return;
      }
      const [result] = await connection.query<ResultSetHeader>(`
        UPDATE ${this.#tables.analysisRevisions}
        SET status = ?, analysis_hash = ?, source_revision = ?, completed_at = ?, failure_reason = ?, failure_stage = ?
        WHERE repository_id = ? AND analysis_revision = ? AND status = 'building'
      `, [
        revision.status, revision.analysisHash, revision.sourceRevision ?? null,
        revision.completedAt ?? null, revision.failureReason ?? null, revision.failureStage ?? null,
        ...scopeParams(revision),
      ]);
      if (result.affectedRows !== 1) {
        throw new Error(`Analysis revision ${revision.analysisRevision} changed while it was being finalized.`);
      }
    });
  }

  async getRevision(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<AnalysisRevisionRecord | null> {
    const rows = await queryRows<RevisionRow[]>(this.pool, `
      SELECT * FROM ${this.#tables.analysisRevisions}
      WHERE repository_id = ? AND analysis_revision = ?
    `, scopeParams(scope), signal);
    const row = rows[0];
    return row ? toRevision(row) : null;
  }

  async listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]> {
    const [rows] = await this.pool.query<RevisionRow[]>(`
      SELECT * FROM ${this.#tables.analysisRevisions}
      WHERE repository_id = ? ORDER BY created_at DESC
    `, [repositoryId]);
    return rows.map(toRevision);
  }

  async putStructuralIndex(index: StructuralIndex, sourceTexts: ReadonlyMap<string, string> = new Map()): Promise<void> {
    validateStructuralIndex(index);
    validateSourceTexts(index, sourceTexts);
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(index));
      const revision = revisions[0];
      if (!revision) throw new Error('Cannot write an index for an unknown analysis revision.');
      if (revision.status !== 'building') {
        throw new Error('Structural indexes may be written only while an analysis revision is building.');
      }
      if (revision.analysis_hash !== index.analysisHash) {
        throw new Error('Structural index analysisHash must match its analysis revision.');
      }
      await this.#deleteRevisionStructuralRecords(connection, index);
      const started = performance.now();
      let statements = await this.#insertProjects(connection, index.projects);
      statements += await this.#insertFiles(connection, index.files, sourceTexts);
      statements += await this.#insertSymbols(connection, index.symbols);
      statements += await this.#insertDependencies(connection, index.dependencyEdges);
      statements += await this.#insertDiagnostics(connection, index.diagnostics);
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'structural-insert', repositoryId: index.repositoryId,
        durationMs: Math.round(performance.now() - started), files: index.files.length, symbols: index.symbols.length,
        dependencies: index.dependencyEdges.length, insertStatements: statements }));
    });
  }

  async getStructuralIndex({ repositoryId, analysisRevision }: RepositoryRevisionScope): Promise<StructuralIndex | null> {
    const scope = { repositoryId, analysisRevision };
    const revision = await this.getRevision(scope);
    if (!revision) return null;
    const [projects, files, symbols, dependencyEdges, diagnostics] = await Promise.all([
      this.listProjects(scope), this.listFiles(scope), this.listSymbols(scope),
      this.listDependencyEdges(scope), this.listDiagnostics(scope),
    ]);
    // An empty valid repository still has a structural revision, so the
    // revision row is authoritative instead of using a non-empty array test.
    return {
      ...scope,
      analysisHash: revision.analysisHash,
      projects,
      files,
      symbols,
      dependencyEdges,
      diagnostics,
    };
  }

  async getStructuralIndexMetadata(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<Pick<StructuralIndex, 'repositoryId' | 'analysisRevision' | 'analysisHash'> | null> {
    const revision = await this.getRevision(scope, signal);
    return revision ? { ...scope, analysisHash: revision.analysisHash } : null;
  }

  async getRevisionStatistics(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<RevisionStatistics | null> {
    if (!await this.getRevision(scope, signal)) return null;
    const tables = [this.#tables.projects, this.#tables.files, this.#tables.symbols, this.#tables.dependencyEdges, this.#tables.diagnostics];
    const fields = ['projects', 'files', 'symbols', 'dependencies', 'diagnostics'];
    const counts = await queryRows<RowDataPacket[]>(this.pool, `SELECT ${tables.map((table, index) =>
      `(SELECT COUNT(*) FROM ${table} WHERE repository_id = ? AND analysis_revision = ?) AS ${fields[index]}`).join(', ')}`,
    tables.flatMap(() => scopeParams(scope)), signal);
    const rows = await queryRows<RowDataPacket[]>(this.pool, `SELECT language_id, COUNT(*) AS file_count, 0 AS has_semantic_symbols
      FROM ${this.#tables.files} WHERE repository_id = ? AND analysis_revision = ? AND language_id IS NOT NULL GROUP BY language_id
      UNION ALL SELECT language_id, 0 AS file_count, MAX(provider <> 'tree-sitter') AS has_semantic_symbols
      FROM ${this.#tables.symbols} WHERE repository_id = ? AND analysis_revision = ? GROUP BY language_id`,
    [...scopeParams(scope), ...scopeParams(scope)], signal);
    const languages = new Map<string, RevisionStatistics['languages'][number]>();
    for (const row of rows) {
      const languageId = String(row.language_id);
      const previous = languages.get(languageId) ?? { languageId, fileCount: 0, hasSemanticSymbols: false };
      previous.fileCount += Number(row.file_count);
      previous.hasSemanticSymbols ||= Boolean(Number(row.has_semantic_symbols));
      languages.set(languageId, previous);
    }
    return { projects: Number(counts[0]!.projects), files: Number(counts[0]!.files), symbols: Number(counts[0]!.symbols),
      dependencies: Number(counts[0]!.dependencies), diagnostics: Number(counts[0]!.diagnostics),
      languages: [...languages.values()].filter(language => language.fileCount > 0).sort((a, b) => a.languageId.localeCompare(b.languageId)) };
  }

  async #writeBuilding(index: StructuralIndex, write: (connection: PoolConnection) => Promise<unknown>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.query<RevisionRow[]>(`SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE`, scopeParams(index));
      if (rows[0]?.status !== 'building' || rows[0].analysis_hash !== index.analysisHash) throw new Error('Index batches require their matching building revision.');
      signal?.throwIfAborted();
      await write(connection);
      signal?.throwIfAborted();
    });
  }

  async putStructuralIndexFromSource(index: StructuralIndex, source: SourceTextReader, signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void): Promise<void> {
    validateStructuralIndex(index);
    const batchRows = this.#structuralBatchRows;
    const total = index.projects.length + index.files.length + index.symbols.length + index.dependencyEdges.length + index.diagnostics.length;
    let completed = 0;
    const progress = (count: number) => { completed += count; onProgress?.(completed, total); };
    await this.#writeBuilding(index, (connection) => this.#deleteRevisionStructuralRecords(connection, index), signal);
    for (let offset = 0; offset < index.projects.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertProjects(connection, index.projects.slice(offset, offset + batchRows)), signal);
      progress(Math.min(batchRows, index.projects.length - offset));
    }
    let files: IndexedFileRecord[] = [];
    let texts = new Map<string, string>();
    let bytes = 0;
    const flush = async () => {
      if (!files.length) return;
      await this.#writeBuilding(index, (connection) => this.#insertFiles(connection, files, texts), signal);
      progress(files.length);
      files = []; texts = new Map(); bytes = 0;
    };
    for (const file of index.files) {
      signal?.throwIfAborted();
      const text = await source.read(file.relativePath);
      if (text === null && file.parseStatus !== 'failed') throw new Error(`Captured source is unavailable: ${file.relativePath}`);
      if (text !== null && createHash('sha256').update(text).digest('hex') !== file.sha256) throw new Error(`Source snapshot hash mismatch: ${file.relativePath}`);
      if (files.length >= 64 || (files.length && bytes + file.sizeBytes > 2 * 1024 * 1024)) await flush();
      files.push(file);
      if (text !== null) { texts.set(file.relativePath, text); bytes += Buffer.byteLength(text, 'utf8'); }
    }
    await flush();
    for (let offset = 0; offset < index.symbols.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertSymbols(connection, index.symbols.slice(offset, offset + batchRows)), signal);
      progress(Math.min(batchRows, index.symbols.length - offset));
    }
    for (let offset = 0; offset < index.dependencyEdges.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertDependencies(connection, index.dependencyEdges.slice(offset, offset + batchRows)), signal);
      progress(Math.min(batchRows, index.dependencyEdges.length - offset));
    }
    for (let offset = 0; offset < index.diagnostics.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertDiagnostics(connection, index.diagnostics.slice(offset, offset + batchRows)), signal);
      progress(Math.min(batchRows, index.diagnostics.length - offset));
    }
  }

  async appendSearchDocuments(index: StructuralIndex, documents: SearchDocumentRecord[], signal?: AbortSignal): Promise<void> {
    if (documents.length > 2048 || documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0) > 8 * 1024 * 1024 || documents.some((document) => document.kind === 'summary')) throw new Error('Base projection batches accept at most 2048 symbol/source documents and 8 MiB.');
    let facts = this.#projectionFacts.get(index);
    if (!facts) { facts = projectionFactLookup(index); this.#projectionFacts.set(index, facts); }
    validateSearchDocumentsAgainstIndex(index, documents, new Map(), null, facts);
    const texts = documents.map((document) => [document.title, document.relativePath ?? '', document.text].join('\n'));
    signal?.throwIfAborted();
    const embeddings = await this.embedDocuments(texts, signal);
    if (embeddings.length !== documents.length) throw new Error('Embedding provider returned an unexpected document count.');
    if (!documents.length) return;
    await retryTransientSql(() => this.#writeBuilding(index, async connection => {
      // A COMMIT acknowledgement can be lost even though the rows are durable.
      // The revision lock serializes retries; matching immutable rows are reused.
      const [existing] = await connection.query<RowDataPacket[]>(`SELECT search_document_id, content_hash, kind FROM ${this.#tables.searchDocuments}
        WHERE repository_id = ? AND analysis_revision = ? AND search_document_id IN (${documents.map(() => '?').join(',')})`,
      [...scopeParams(index), ...documents.map(document => document.searchDocumentId)]);
      const saved = new Map(existing.map(row => [String(row.search_document_id), row]));
      const pending = documents.flatMap((document, position) => {
        const prior = saved.get(document.searchDocumentId);
        if (prior && (prior.content_hash !== document.contentHash || prior.kind !== document.kind)) {
          throw new Error('Persisted search document conflicts with the immutable projection batch.');
        }
        return prior ? [] : [{ document, position }];
      });
      await insertBatches(connection, `INSERT INTO ${this.#tables.searchDocuments} (
      repository_id, analysis_revision, search_document_id, kind, relative_path, symbol_key, source_range,
      module_artifact_id, content_hash, title, document_text, search_text, project_id, embedding
    )`, insertRows(pending, ({ document, position }) => {
      const embedding = embeddings[position]!;
      assertEmbedding(embedding, this.#vectorDimension);
      return { vector: vectorHex(embedding), values: [document.repositoryId, document.analysisRevision, document.searchDocumentId,
        document.kind, document.relativePath, document.symbolKey ?? null, document.sourceRange ? JSON.stringify(document.sourceRange) : null,
        null, document.contentHash, document.title, document.text, texts[position]!, searchDocumentProjectId(document, facts.filesByPath)] };
      }));
    }, signal), signal);
  }

  async getSourceText(scope: RepositoryRevisionScope, relativePath: string): Promise<string | null> {
    assertRelativePath(relativePath, 'Source text path');
    const [rows] = await this.pool.query<FileRow[]>(`
      SELECT source_text FROM ${this.#tables.files}
      WHERE repository_id = ? AND analysis_revision = ? AND relative_path = ?
    `, [...scopeParams(scope), relativePath]);
    return rows[0]?.source_text ?? null;
  }

  async listProjects(scope: RepositoryRevisionScope): Promise<ProjectRecord[]> {
    const [rows] = await this.pool.query<ProjectRow[]>(`
      SELECT project_id, kind, display_name, relative_path, manifest_paths, source_roots, test_roots, language_ids
      FROM ${this.#tables.projects}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY project_id
    `, scopeParams(scope));
    return rows.map((row) => toProject(scope, row));
  }

  async getProject(scope: RepositoryRevisionScope, projectId: string, signal?: AbortSignal): Promise<ProjectRecord | null> {
    const rows = await queryRows<ProjectRow[]>(this.pool, `
      SELECT project_id, kind, display_name, relative_path, manifest_paths, source_roots, test_roots, language_ids
      FROM ${this.#tables.projects}
      WHERE repository_id = ? AND analysis_revision = ? AND project_id = ? LIMIT 1
    `, [...scopeParams(scope), projectId], signal);
    return rows[0] ? toProject(scope, rows[0]) : null;
  }

  async getSourcePreview(scope: RepositoryRevisionScope, relativePath: string, maxChars: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean } | null> {
    assertRelativePath(relativePath, 'Source preview path');
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 32_000) throw new Error('Source preview must be bounded to 1..32000 characters.');
    const rows = await queryRows<RowDataPacket[]>(this.pool, `SELECT SUBSTRING(source_text, 1, ?) AS preview,
      CHAR_LENGTH(source_text) > ? AS truncated FROM ${this.#tables.files}
      WHERE repository_id = ? AND analysis_revision = ? AND relative_path = ? LIMIT 1`,
    [maxChars, maxChars, ...scopeParams(scope), relativePath], signal);
    return rows[0]?.preview == null ? null : { text: String(rows[0].preview), truncated: Boolean(Number(rows[0].truncated)) };
  }

  async queryFiles(scope: RepositoryRevisionScope, query: { projectId?: string; relativePaths?: readonly string[]; after?: string; limit: number }, signal?: AbortSignal): Promise<{ files: IndexedFileRecord[]; truncated: boolean }> {
    validateLocalQuery(query, false);
    const conditions = ['repository_id = ?', 'analysis_revision = ?'];
    const values: unknown[] = scopeParams(scope);
    if (query.projectId) { conditions.push('project_id = ?'); values.push(query.projectId); }
    if (query.relativePaths?.length) { conditions.push(`relative_path IN (${query.relativePaths.map(() => '?').join(',')})`); values.push(...query.relativePaths); }
    if (query.after) { conditions.push('relative_path > ?'); values.push(query.after); }
    const rows = await queryRows<FileRow[]>(this.pool, `SELECT file_id, relative_path, language_id, role, sha256, size_bytes, parse_status, project_id
      FROM ${this.#tables.files} WHERE ${conditions.join(' AND ')} ORDER BY relative_path LIMIT ?`, [...values, query.limit + 1], signal);
    return { files: rows.slice(0, query.limit).map((row) => toFile(scope, row)), truncated: rows.length > query.limit };
  }

  async querySymbols(scope: RepositoryRevisionScope, query: LocalSymbolQuery, signal?: AbortSignal): Promise<{ symbols: SymbolRecord[]; truncated: boolean }> {
    validateLocalQuery(query);
    const anchors: string[] = [];
    const values: unknown[] = scopeParams(scope);
    if (query.symbolKeys?.length) { anchors.push(`symbol_key IN (${query.symbolKeys.map(() => '?').join(',')})`); values.push(...query.symbolKeys); }
    if (query.relativePaths?.length) { anchors.push(`relative_path IN (${query.relativePaths.map(() => '?').join(',')})`); values.push(...query.relativePaths); }
    const conditions = ['repository_id = ?', 'analysis_revision = ?', `(${anchors.join(' OR ')})`];
    if (query.projectId) { conditions.push('project_id = ?'); values.push(query.projectId); }
    if (query.kinds?.length) { conditions.push(`kind IN (${query.kinds.map(() => '?').join(',')})`); values.push(...query.kinds); }
    const rows = await queryRows<SymbolRow[]>(this.pool, `SELECT symbol_id, symbol_key, ast_declaration_id, name, qualified_name, kind, language_id,
      relative_path, source_range, signature, container_symbol_key, project_id, exported, provider, confidence, evidence_level
      FROM ${this.#tables.symbols} WHERE ${conditions.join(' AND ')} ORDER BY symbol_key LIMIT ?`, [...values, query.limit + 1], signal);
    return { symbols: rows.slice(0, query.limit).map((row) => toSymbol(scope, row)), truncated: rows.length > query.limit };
  }

  async queryDependencies(scope: RepositoryRevisionScope, query: LocalDependencyQuery, signal?: AbortSignal): Promise<{ dependencies: DependencyEdgeRecord[]; truncated: boolean }> {
    validateLocalQuery(query);
    if (query.direction && !['incoming', 'outgoing', 'both'].includes(query.direction)) throw new Error('Invalid dependency direction.');
    const anchors: string[] = [];
    const values: unknown[] = scopeParams(scope);
    const sides = query.direction === 'incoming' ? ['target'] : query.direction === 'outgoing' ? ['source'] : ['source', 'target'];
    for (const side of sides) {
      if (query.symbolKeys?.length) { anchors.push(`d.${side}_symbol_key IN (${query.symbolKeys.map(() => '?').join(',')})`); values.push(...query.symbolKeys); }
      if (query.relativePaths?.length) { anchors.push(`d.${side}_relative_path IN (${query.relativePaths.map(() => '?').join(',')})`); values.push(...query.relativePaths); }
    }
    const conditions = ['d.repository_id = ?', 'd.analysis_revision = ?', `(${anchors.join(' OR ')})`];
    if (query.projectId) {
      conditions.push(`EXISTS (SELECT 1 FROM ${this.#tables.files} f WHERE f.repository_id = d.repository_id AND f.analysis_revision = d.analysis_revision
        AND f.project_id = ? AND (f.relative_path = d.source_relative_path OR f.relative_path = d.target_relative_path))`);
      values.push(query.projectId);
    }
    const rows = await queryRows<DependencyRow[]>(this.pool, `SELECT dependency_edge_id, kind, source_symbol_key, target_symbol_key, source_relative_path,
      target_relative_path, target_reference, internal, resolution, provider, confidence, evidence_level, evidence_ranges
      FROM ${this.#tables.dependencyEdges} d WHERE ${conditions.join(' AND ')} ORDER BY dependency_edge_id LIMIT ?`, [...values, query.limit + 1], signal);
    return { dependencies: rows.slice(0, query.limit).map((row) => toDependency(scope, row)), truncated: rows.length > query.limit };
  }

  async getSourceSlice(scope: RepositoryRevisionScope, relativePath: string, range: SourceRange | undefined, maxChars: number, signal?: AbortSignal): Promise<SourceSlice | null> {
    assertRelativePath(relativePath, 'Source slice path');
    sliceSourceText('', range, maxChars);
    const startLine = range?.startLine ?? 1;
    const startColumn = range?.startColumn ?? 1;
    if (startColumn > 128_000) throw new Error('Source slice columns exceed the local read budget.');
    const limit = maxChars + startColumn + 1;
    const rows = await queryRows<FileRow[]>(this.pool, `SELECT file_id, relative_path, language_id, role, sha256, size_bytes, parse_status, project_id,
      SUBSTRING(source_text, IF(? = 1, 1, CHAR_LENGTH(SUBSTRING_INDEX(source_text, '\\n', ? - 1)) + 2), ?) AS source_text
      FROM ${this.#tables.files} WHERE repository_id = ? AND analysis_revision = ? AND relative_path = ?
      AND CHAR_LENGTH(source_text) - CHAR_LENGTH(REPLACE(source_text, '\\n', '')) >= ? - 1 LIMIT 1`,
    [startLine, startLine, limit, ...scopeParams(scope), relativePath, startLine], signal);
    const row = rows[0];
    if (!row || row.source_text == null) return null;
    const slice = sliceSourceText(row.source_text, range, maxChars, startLine, row.source_text.length >= limit);
    return slice ? { file: toFile(scope, row), ...slice } : null;
  }

  async getModuleArtifacts(scope: RepositoryRevisionScope, ids: readonly string[], signal?: AbortSignal): Promise<ModuleArtifactRecord[]> {
    if (ids.length > 200) throw new Error('At most 200 artifact IDs may be fetched.');
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await queryRows<ModuleArtifactRow[]>(this.pool, `
      SELECT module_artifact_id, kind, status, analysis_hash, plan_hash, content_hash, created_at, updated_at, payload
      FROM ${this.#tables.moduleArtifacts}
      WHERE repository_id = ? AND analysis_revision = ? AND module_artifact_id IN (${unique.map(() => '?').join(',')})
      LIMIT 200
    `, [...scopeParams(scope), ...unique], signal);
    return rows.map((row) => toModuleArtifact(scope, row));
  }

  async listFiles(scope: RepositoryRevisionScope): Promise<IndexedFileRecord[]> {
    const [rows] = await this.pool.query<FileRow[]>(`
      SELECT file_id, relative_path, language_id, role, sha256, size_bytes, parse_status, project_id
      FROM ${this.#tables.files}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY relative_path
    `, scopeParams(scope));
    return rows.map((row) => toFile(scope, row));
  }

  async listSymbols(scope: RepositoryRevisionScope): Promise<SymbolRecord[]> {
    const [rows] = await this.pool.query<SymbolRow[]>(`
      SELECT symbol_id, symbol_key, ast_declaration_id, name, qualified_name, kind, language_id,
        relative_path, source_range, signature, container_symbol_key, project_id, exported,
        provider, confidence, evidence_level
      FROM ${this.#tables.symbols}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY symbol_key
    `, scopeParams(scope));
    return rows.map((row) => toSymbol(scope, row));
  }

  async listDependencyEdges(scope: RepositoryRevisionScope): Promise<DependencyEdgeRecord[]> {
    const [rows] = await this.pool.query<DependencyRow[]>(`
      SELECT dependency_edge_id, kind, source_symbol_key, target_symbol_key, source_relative_path,
        target_relative_path, target_reference, internal, resolution, provider, confidence,
        evidence_level, evidence_ranges
      FROM ${this.#tables.dependencyEdges}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY dependency_edge_id
    `, scopeParams(scope));
    return rows.map((row) => toDependency(scope, row));
  }

  async listDiagnostics(scope: RepositoryRevisionScope): Promise<IndexDiagnosticRecord[]> {
    const [rows] = await this.pool.query<DiagnosticRow[]>(`
      SELECT diagnostic_id, severity, message, code, relative_path, source_range, provider, confidence, evidence_level
      FROM ${this.#tables.diagnostics}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY diagnostic_id
    `, scopeParams(scope));
    return rows.map((row) => toDiagnostic(scope, row));
  }

  async putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(artifact));
      const revision = revisions[0];
      if (!revision) throw new Error('Cannot write an artifact for an unknown analysis revision.');
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [artifact.repositoryId]);
      const repository = repositories[0];
      if (!repository) throw new Error('Cannot write an artifact for an unknown repository.');
      if (artifact.kind === 'module-summary' && artifact.status === 'current' && revision.status !== 'ready') {
        throw new Error('A current module summary requires a completed ready analysis revision.');
      }
      validateModuleArtifact(artifact, toRevision(revision), toRepository(repository));
      await connection.query<ResultSetHeader>(`
        INSERT INTO ${this.#tables.moduleArtifacts} (
          repository_id, analysis_revision, module_artifact_id, kind, status, analysis_hash, plan_hash,
          content_hash, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          kind = VALUES(kind), status = VALUES(status), analysis_hash = VALUES(analysis_hash),
          plan_hash = VALUES(plan_hash), content_hash = VALUES(content_hash), updated_at = VALUES(updated_at),
          payload = VALUES(payload)
      `, [
        artifact.repositoryId, artifact.analysisRevision, artifact.moduleArtifactId, artifact.kind,
        artifact.status, artifact.analysisHash, artifact.planHash ?? null, artifact.contentHash,
        artifact.createdAt, artifact.updatedAt, artifact.payload === undefined ? null : JSON.stringify(artifact.payload),
      ]);
    });
  }

  async listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]> {
    const [rows] = await this.pool.query<ModuleArtifactRow[]>(`
      SELECT module_artifact_id, kind, status, analysis_hash, plan_hash, content_hash, created_at, updated_at, payload
      FROM ${this.#tables.moduleArtifacts}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY module_artifact_id
    `, scopeParams(scope));
    return rows.map((row) => toModuleArtifact(scope, row));
  }

  async replaceSearchDocuments(scope: RepositoryRevisionScope, documents: SearchDocumentRecord[], moduleArtifactId?: string): Promise<void> {
    // Validate scope, document shape, and repository-relative paths before
    // opening the delete-and-replace transaction.
    validateSearchDocumentRecords(scope, documents);
    validateSummaryReplacement(documents, moduleArtifactId);
    const [repository, revision, index, artifacts] = await Promise.all([
      this.getRepository(scope.repositoryId),
      this.getRevision(scope),
      this.getStructuralIndex(scope),
      this.listModuleArtifacts(scope),
    ]);
    if (!repository || !revision || !index) {
      throw new Error('Cannot project search documents before its structural index exists.');
    }
    if (revision.status !== 'building' && revision.status !== 'ready') {
      throw new Error('Search documents may be projected only for a building or ready analysis revision.');
    }
    validateSearchDocumentsAgainstIndex(
      index,
      documents,
      new Map(artifacts.map((artifact) => [artifact.moduleArtifactId, artifact])),
      repository,
    );
    const searchable = documents.map((document) => [
      document.title,
      document.relativePath ?? '',
      document.text,
    ].join('\n'));
    const embeddings = await this.embedDocuments(searchable);
    if (embeddings.length !== documents.length) {
      throw new Error('Search embedding provider returned an unexpected document count.');
    }
    const projected = documents.map((document, index) => {
      const embedding = embeddings[index];
      if (!embedding) throw new Error('Search embedding provider omitted a document vector.');
      assertEmbedding(embedding, this.#vectorDimension);
      return { document, searchText: searchable[index]!, embedding };
    });
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(scope));
      const lockedRevision = revisions[0];
      if (!lockedRevision || (lockedRevision.status !== 'building' && lockedRevision.status !== 'ready')) {
        throw new Error('Search documents may be projected only for a building or ready analysis revision.');
      }
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [scope.repositoryId]);
      const lockedRepository = repositories[0];
      if (!lockedRepository) throw new Error('Cannot project search documents for an unknown repository.');
      const [artifactRows] = await connection.query<ModuleArtifactRow[]>(`
        SELECT module_artifact_id, kind, status, analysis_hash, plan_hash, content_hash, created_at, updated_at, payload
        FROM ${this.#tables.moduleArtifacts}
        WHERE repository_id = ? AND analysis_revision = ?
      `, scopeParams(scope));
      validateSearchDocumentsAgainstIndex(
        index,
        documents,
        new Map(artifactRows.map((artifact) => {
          const converted = toModuleArtifact(scope, artifact);
          return [converted.moduleArtifactId, converted] as const;
        })),
        toRepository(lockedRepository),
      );
      await connection.query(
        `DELETE FROM ${this.#tables.searchDocuments} WHERE repository_id = ? AND analysis_revision = ?${moduleArtifactId === undefined ? '' : " AND kind = 'summary' AND module_artifact_id = ?"}`,
        [...scopeParams(scope), ...(moduleArtifactId === undefined ? [] : [moduleArtifactId])],
      );
      const filesByPath = new Map(index.files.map((file) => [file.relativePath, file]));
      const started = performance.now();
      const statements = await insertBatches(connection, `
          INSERT INTO ${this.#tables.searchDocuments} (
            repository_id, analysis_revision, search_document_id, kind, relative_path, symbol_key, source_range,
            module_artifact_id, content_hash, title, document_text, search_text, project_id, embedding
          )
        `, insertRows(projected, ({ document, searchText, embedding }) => ({ vector: vectorHex(embedding), values: [
          document.repositoryId, document.analysisRevision, document.searchDocumentId, document.kind,
          document.relativePath, document.symbolKey ?? null, document.sourceRange ? JSON.stringify(document.sourceRange) : null, document.moduleArtifactId ?? null,
          document.contentHash, document.title, document.text, searchText, searchDocumentProjectId(document, filesByPath),
        ] })));
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'search-insert', repositoryId: scope.repositoryId,
        moduleArtifactId, durationMs: Math.round(performance.now() - started), documents: documents.length, insertStatements: statements }));
    });
  }

  async listSearchDocuments(scope: RepositoryRevisionScope): Promise<SearchDocumentRecord[]> {
    const [rows] = await this.pool.query<SearchDocumentRow[]>(`
      SELECT search_document_id, kind, relative_path, symbol_key, source_range, module_artifact_id, content_hash, title, document_text
      FROM ${this.#tables.searchDocuments}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY search_document_id
    `, scopeParams(scope));
    return rows.map((row) => toSearchDocument(scope, row));
  }

  /**
   * Hybrid full-text/vector lookup over the revision-local symbol projection.
   * The structural index remains the source of truth; callers use returned
   * symbol keys only to select authoritative records in the same scope.
   */
  async searchSearchDocuments(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limit: number,
    kind: SearchDocumentRecord['kind'] = 'symbol',
    signal?: AbortSignal,
  ): Promise<SearchDocumentRecord[]> {
    const perView = await this.#searchViews(scope, query, { [kind]: limit }, [kind], signal);
    return perView[kind] ?? [];
  }

  /**
   * Batched recall over several views at once.
   *
   * Views sharing a question reuse one embedding and one hydration statement.
   * Each view retains its own text/vector lookup and top-N budget so fragments
   * cannot displace symbols or summaries before module aggregation.
   */
  async searchSearchDocumentsByViews(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limits: Partial<Record<SearchDocumentRecord['kind'], number>>,
    views: readonly SearchDocumentRecord['kind'][],
    signal?: AbortSignal,
  ): Promise<Partial<Record<SearchDocumentRecord['kind'], SearchDocumentRecord[]>>> {
    return this.#searchViews(scope, query, limits, views, signal);
  }

  async #searchViews(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limits: Partial<Record<SearchDocumentRecord['kind'], number>>,
    views: readonly SearchDocumentRecord['kind'][],
    signal?: AbortSignal,
  ): Promise<Partial<Record<SearchDocumentRecord['kind'], SearchDocumentRecord[]>>> {
    return (await this.searchSearchDocumentsBatch([{ scope, query, limits, views }], signal))[0]!;
  }

  /** One full-text scan per lexical question, with independent scope/view
   * top-Ns. All shared state lives in this invocation, never across revisions. */
  async searchSearchDocumentsBatch(requests: readonly SearchDocumentQuery[], signal?: AbortSignal, concurrency = 4): Promise<SearchDocumentsByView[]> {
    signal?.throwIfAborted();
    if (requests.length > 256) throw new Error('Search batches require at most 256 queries.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Search concurrency must be in 1..32.');
    const outputs: SearchDocumentsByView[] = requests.map(() => ({}));
    const prepared = requests.flatMap((request, index) => {
      const text = request.query.trim();
      const planned = [...new Set(request.views)].flatMap(view => {
        if (!['summary', 'symbol', 'source-fragment'].includes(view)) throw new Error('Invalid search view.');
        const limit = request.limits[view];
        if (!Number.isInteger(limit) || (limit ?? 0) < 1) return [];
        const boundedLimit = Math.min(limit!, 200);
        return [{ view, boundedLimit, candidateLimit: Math.min(Math.max(boundedLimit * 4, 24), 800) }];
      });
      return text && planned.length ? [{ ...request, index, text, lexicalText: compactLexicalQuery(text), planned }] : [];
    });
    const scopeKey = (scope: SearchDocumentQuery['scope']) => JSON.stringify([scope.repositoryId, scope.analysisRevision, scope.projectId ?? null]);
    const lexicalKey = (item: typeof prepared[number]) => JSON.stringify([item.lexicalText, item.scope.projectId ?? null]);
    const lexicalGroups = new Map<string, typeof prepared>();
    const scopes = new Map<string, typeof prepared>();
    for (const item of prepared) {
      lexicalGroups.set(lexicalKey(item), [...(lexicalGroups.get(lexicalKey(item)) ?? []), item]);
      scopes.set(scopeKey(item.scope), [...(scopes.get(scopeKey(item.scope)) ?? []), item]);
    }
    const lexical = new Map([...lexicalGroups].map(([key, items]) => [key, this.#lexicalCandidatesBatch(items.flatMap(item =>
      item.planned.map(plan => ({ scope: item.scope, view: plan.view, candidateLimit: plan.candidateLimit }))), items[0]!.lexicalText, signal)]));
    // Observe rejected scans immediately, even when their scope is still waiting
    // for a worker. The original promises are awaited below and still reject.
    for (const promise of lexical.values()) void promise.catch(() => undefined);
    const work = [...scopes.values()];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, async () => {
      while (next < work.length) {
        const items = work[next++]!;
        await Promise.all(items.map(async item => {
          signal?.throwIfAborted();
          const embedding = this.#embeddingProvider.embedQuery
            ? await this.#embeddingProvider.embedQuery(item.text, signal)
            : (await this.#embeddingProvider.embed([item.text], signal))[0];
          if (!embedding) throw new Error('Search embedding provider omitted a query vector.');
          assertEmbedding(embedding, this.#vectorDimension);
          const selected = new Map<SearchDocumentRecord['kind'], Array<[string, RankedScores]>>();
          await Promise.all(item.planned.map(async plan => {
            const [allTextRows, vectorRows] = await Promise.all([
              lexical.get(lexicalKey(item))!,
              this.#vectorCandidates({ scope: item.scope, embedding, kinds: [plan.view], candidateLimit: plan.candidateLimit, signal }),
            ]);
            const textRows = allTextRows.filter(row => row.repository_id === item.scope.repositoryId &&
              row.analysis_revision === item.scope.analysisRevision && row.kind === plan.view).slice(0, plan.candidateLimit);
            selected.set(plan.view, this.#fuseCandidates(textRows, vectorRows, plan.view, plan.boundedLimit));
          }));
          const wanted = [...new Set([...selected.values()].flatMap(entries => entries.map(([id]) => id)))];
          const documents = await this.#hydrateDocuments(item.scope, wanted, signal);
          outputs[item.index] = Object.fromEntries(item.planned.map(({ view }) => [view, (selected.get(view) ?? []).flatMap(([id, scores]) => {
            const document = documents.get(id);
            if (document && document.kind !== view) throw new Error('Search returned a document from another view.');
            return document ? [{ ...document, retrievalScore: scores.retrievalScore }] : [];
          })]));
        }));
      }
    }));
    return outputs;
  }

  async #lexicalCandidatesBatch(entries: readonly { scope: SearchDocumentQuery['scope']; view: SearchDocumentRecord['kind']; candidateLimit: number }[],
    text: string, signal?: AbortSignal): Promise<RowDataPacket[]> {
    const units = new Map<string, typeof entries[number]>();
    for (const entry of entries) {
      const key = JSON.stringify([entry.scope.repositoryId, entry.scope.analysisRevision, entry.view]);
      const previous = units.get(key);
      if (!previous || previous.candidateLimit < entry.candidateLimit) units.set(key, entry);
    }
    if (!units.size) return [];
    const planned = [...units.values()];
    const match = 'MATCH(search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const projectId = planned[0]!.scope.projectId;
    const projectFilter = projectId ? ' AND project_id = ?' : '';
    if (planned.length === 1) {
      const { scope, view, candidateLimit } = planned[0]!;
      const rows = await this.#searchQuery(`
        SELECT search_document_id, kind, ${match} AS text_score FROM ${this.#tables.searchDocuments}
        WHERE repository_id = ? AND analysis_revision = ? AND kind = ?${projectFilter}${view === 'source-fragment' ? ' AND implementation_eligible = 1' : ''} AND ${match}
        ORDER BY text_score DESC LIMIT ?
      `, [text, ...scopeParams(scope), view, ...(projectId ? [projectId] : []), text, candidateLimit], signal);
      return rows.map(row => ({ ...row, repository_id: scope.repositoryId, analysis_revision: scope.analysisRevision, kind: row.kind ?? view }));
    }
    const scopes = new Map<string, { scope: SearchDocumentQuery['scope']; views: SearchDocumentRecord['kind'][] }>();
    for (const { scope, view } of planned) {
      const key = JSON.stringify(scopeParams(scope));
      const entry = scopes.get(key) ?? { scope, views: [] };
      entry.views.push(view);
      scopes.set(key, entry);
    }
    const where = [...scopes.values()].map(({ views }) => `(repository_id = ? AND analysis_revision = ? AND kind IN (${views.map(() => '?').join(',')}))`).join(' OR ');
    const values = [...scopes.values()].flatMap(({ scope, views }) => [...scopeParams(scope), ...views]);
    const cutoff = planned.map(() => '(repository_id = ? AND analysis_revision = ? AND kind = ? AND view_rank <= ?)').join(' OR ');
    const cutoffs = planned.flatMap(({ scope, view, candidateLimit }) => [...scopeParams(scope), view, candidateLimit]);
    const rows = await this.#searchQuery(`
      SELECT repository_id, analysis_revision, search_document_id, kind, text_score FROM (
        SELECT repository_id, analysis_revision, search_document_id, kind, ${match} AS text_score,
          ROW_NUMBER() OVER (PARTITION BY repository_id, analysis_revision, kind ORDER BY ${match} DESC, search_document_id) AS view_rank
        FROM ${this.#tables.searchDocuments}
        WHERE (${where})${projectFilter} AND (kind <> 'source-fragment' OR implementation_eligible = 1) AND ${match}
      ) ranked WHERE ${cutoff}
      ORDER BY repository_id, analysis_revision, kind, view_rank
    `, [text, text, ...values, ...(projectId ? [projectId] : []), text, ...cutoffs], signal);
    for (const row of rows) if (!units.has(JSON.stringify([row.repository_id, row.analysis_revision, row.kind]))) {
      throw new Error('Full-text batch returned a row outside its requested scopes.');
    }
    return rows;
  }

  async #vectorCandidates(input: {
    scope: RepositoryRevisionScope & { projectId?: string };
    embedding: number[];
    kinds: readonly SearchDocumentRecord['kind'][];
    candidateLimit: number;
    signal?: AbortSignal;
  }): Promise<RowDataPacket[]> {
    const { scope, embedding, kinds, candidateLimit, signal } = input;
    const kindFilter = kinds.length === 1 ? 'kind = ?' : `kind IN (${kinds.map(() => '?').join(',')})`;
    // project_id sits in idx_search_documents_scope, so the vector pre-filter applies it before the top-N cut.
    const projectFilter = scope.projectId ? ' AND project_id = ?' : '';
    // Filter whitespace-only and very short fragments before top-N without
    // reading their long source text. The stored flag uses the original byte
    // length/non-whitespace predicate, including for pre-migration documents.
    const implementationFilter = kinds.includes('source-fragment')
      ? ' AND implementation_eligible = 1' : '';
    const filterValues = [...scopeParams(scope), ...kinds, ...(scope.projectId ? [scope.projectId] : [])];
    return this.#searchQuery(`
        SELECT search_document_id, kind, GREATEST(0, 1 - cosine_distance(embedding, ${vectorHex(embedding)})) AS semantic_score
        FROM ${this.#tables.searchDocuments}
        WHERE repository_id = ? AND analysis_revision = ? AND ${kindFilter}${projectFilter}${implementationFilter}
        ORDER BY cosine_distance(embedding, ${vectorHex(embedding)})
        APPROXIMATE
        LIMIT ?
      `, [...filterValues, candidateLimit], signal);
  }

  #searchQuery(sql: string, values: unknown[], signal?: AbortSignal): Promise<RowDataPacket[]> {
    const execute = () => queryRows<RowDataPacket[]>(this.pool, sql, values, signal);
    return this.#searchQueryGate ? this.#searchQueryGate.run(execute, signal) : execute();
  }

  /** Reciprocal-rank fusion of both candidate sets, for one view. */
  #fuseCandidates(
    textRows: RowDataPacket[],
    vectorRows: RowDataPacket[],
    view: SearchDocumentRecord['kind'],
    boundedLimit: number,
  ): Array<[string, RankedScores]> {
    const byId = new Map<string, RankedScores>();
    const add = (rows: RowDataPacket[]): void => {
      let rank = 0;
      for (const row of rows) {
        if (row.kind !== undefined && row.kind !== view) continue;
        const searchDocumentId = stringValue(row.search_document_id)!;
        const existing = byId.get(searchDocumentId);
        const score = (existing?.score ?? 0) + 1 / (60 + rank + 1);
        const retrievalScore = {
          ...existing?.retrievalScore,
          ...(row.semantic_score !== undefined ? { semantic: numberValue(row.semantic_score) } : {}),
          ...(row.text_score !== undefined ? { lexical: numberValue(row.text_score) } : {}),
          fusion: score,
        };
        byId.set(searchDocumentId, { score, retrievalScore });
        rank += 1;
      }
    };
    add(textRows);
    add(vectorRows);
    return [...byId.entries()]
      .sort(([leftId, left], [rightId, right]) => right.score - left.score || leftId.localeCompare(rightId))
      .slice(0, boundedLimit);
  }

  /** Long source text is fetched only after both candidate sets were bounded and fused. */
  async #hydrateDocuments(
    scope: RepositoryRevisionScope,
    searchDocumentIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, SearchDocumentRecord>> {
    if (!searchDocumentIds.length) return new Map();
    const select = `
      search_document_id, kind, relative_path, symbol_key, source_range, module_artifact_id, content_hash, title, document_text
    `;
    const rows = await queryRows<SearchDocumentRow[]>(this.pool, `SELECT ${select} FROM ${this.#tables.searchDocuments}
      WHERE repository_id = ? AND analysis_revision = ? AND search_document_id IN (${searchDocumentIds.map(() => '?').join(',')})
      LIMIT ?`, [...scopeParams(scope), ...searchDocumentIds, searchDocumentIds.length], signal);
    return new Map(rows.map(row => {
      const document = toSearchDocument(scope, row);
      return [document.searchDocumentId, document] as const;
    }));
  }

  async activateRevision(
    scope: RepositoryRevisionScope,
    status: Extract<RepositoryAnalysisStatus, 'ready' | 'degraded'> = 'ready',
  ): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(scope));
      const revision = revisions[0];
      if (!revision || revision.status !== 'ready') throw new Error('Only a ready revision can be activated.');
      if (!revision.completed_at || revision.failure_reason !== null) {
        throw new Error('Only a completed successful analysis revision can be activated.');
      }
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [scope.repositoryId]);
      const repository = repositories[0];
      if (!repository) throw new Error('Cannot activate a revision for an unknown repository.');
      const previousRevision = stringValue(repository.active_revision);
      if (previousRevision === scope.analysisRevision) return;
      const now = new Date().toISOString();
      if (previousRevision && previousRevision !== scope.analysisRevision) {
        await connection.query(`
          UPDATE ${this.#tables.analysisRevisions}
          SET status = 'superseded'
          WHERE repository_id = ? AND analysis_revision = ? AND status = 'ready'
        `, [scope.repositoryId, previousRevision]);
        await connection.query(`
          UPDATE ${this.#tables.moduleArtifacts}
          SET status = 'stale', updated_at = ?
          WHERE repository_id = ? AND analysis_revision = ? AND status = 'current'
        `, [now, scope.repositoryId, previousRevision]);
        // Summary projections have no mutable status column. Drop only those
        // documents when their bound artifact becomes stale; the prior
        // revision's source/symbol projections remain queryable by scope.
        await connection.query(`
          DELETE FROM ${this.#tables.searchDocuments}
          WHERE repository_id = ? AND analysis_revision = ? AND kind = 'summary'
        `, [scope.repositoryId, previousRevision]);
      }
      await connection.query(`
        UPDATE ${this.#tables.analysisRevisions}
        SET activated_at = ? WHERE repository_id = ? AND analysis_revision = ?
      `, [now, ...scopeParams(scope)]);
      await connection.query(`
        UPDATE ${this.#tables.repositories}
        SET active_revision = ?, analysis_status = ?, updated_at = ? WHERE repository_id = ?
      `, [scope.analysisRevision, status, now, scope.repositoryId]);
    });
  }

  async #deleteRevisionStructuralRecords(connection: PoolConnection, scope: RepositoryRevisionScope): Promise<void> {
    const tables = [
      this.#tables.dependencyEdges,
      this.#tables.symbols,
      this.#tables.files,
      this.#tables.projects,
      this.#tables.diagnostics,
    ];
    for (const table of tables) {
      await connection.query(`DELETE FROM ${table} WHERE repository_id = ? AND analysis_revision = ?`, scopeParams(scope));
    }
  }

  async #insertProjects(connection: PoolConnection, projects: ProjectRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.projects} (
        repository_id, analysis_revision, project_id, kind, display_name, relative_path,
        manifest_paths, source_roots, test_roots, language_ids
      )
    `, insertRows(projects, (project) => ({ values: [
      project.repositoryId, project.analysisRevision, project.projectId, project.kind, project.displayName,
      project.relativePath, JSON.stringify(project.manifestPaths), JSON.stringify(project.sourceRoots),
      JSON.stringify(project.testRoots), JSON.stringify(project.languageIds),
    ] })));
  }

  async #insertFiles(connection: PoolConnection, files: IndexedFileRecord[], sourceTexts: ReadonlyMap<string, string>): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.files} (
        repository_id, analysis_revision, file_id, relative_path, language_id, role, sha256,
        size_bytes, parse_status, project_id, source_text
      )
    `, insertRows(files, (file) => ({ values: [
      file.repositoryId, file.analysisRevision, file.fileId, file.relativePath, file.languageId ?? null,
      file.role, file.sha256, file.sizeBytes, file.parseStatus, file.projectId ?? null, sourceTexts.get(file.relativePath) ?? null,
    ] })));
  }

  async #insertSymbols(connection: PoolConnection, symbols: SymbolRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.symbols} (
        repository_id, analysis_revision, symbol_id, symbol_key, ast_declaration_id, name, qualified_name,
        kind, language_id, relative_path, source_range, signature, container_symbol_key, project_id,
        exported, provider, confidence, evidence_level
      )
    `, insertRows(symbols, (symbol) => ({ values: [
      symbol.repositoryId, symbol.analysisRevision, symbol.symbolId, symbol.symbolKey, symbol.astDeclarationId,
      symbol.name, symbol.qualifiedName, symbol.kind, symbol.languageId, symbol.relativePath,
      JSON.stringify(symbol.sourceRange), symbol.signature ?? null, symbol.containerSymbolKey ?? null,
      symbol.projectId ?? null, symbol.exported, symbol.provider, symbol.confidence, symbol.evidenceLevel,
    ] })));
  }

  async #insertDependencies(connection: PoolConnection, edges: DependencyEdgeRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.dependencyEdges} (
        repository_id, analysis_revision, dependency_edge_id, kind, source_symbol_key, target_symbol_key,
        source_relative_path, target_relative_path, target_reference, internal, resolution, provider,
        confidence, evidence_level, evidence_ranges
      )
    `, insertRows(edges, (edge) => ({ values: [
      edge.repositoryId, edge.analysisRevision, edge.dependencyEdgeId, edge.kind,
      edge.sourceSymbolKey ?? null, edge.targetSymbolKey ?? null, edge.sourceRelativePath,
      edge.targetRelativePath ?? null, edge.targetReference ?? null, edge.internal, edge.resolution,
      edge.provider, edge.confidence, edge.evidenceLevel, JSON.stringify(edge.evidenceRanges),
    ] })));
  }

  async #insertDiagnostics(connection: PoolConnection, diagnostics: IndexDiagnosticRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.diagnostics} (
        repository_id, analysis_revision, diagnostic_id, severity, message, code, relative_path,
        source_range, provider, confidence, evidence_level
      )
    `, insertRows(diagnostics, (diagnostic) => ({ values: [
      diagnostic.repositoryId, diagnostic.analysisRevision, diagnostic.diagnosticId, diagnostic.severity,
      diagnostic.message, diagnostic.code ?? null, diagnostic.relativePath,
      diagnostic.sourceRange === null ? null : JSON.stringify(diagnostic.sourceRange), diagnostic.provider,
      diagnostic.confidence, diagnostic.evidenceLevel,
    ] })));
  }
}

export const seekDbIndexStoreInternals = {
  retryTransientSql,
  compactLexicalQuery,
  withTransaction,
  insertBatches,
  assertEmbedding,
  identifier,
  json,
  jsonArray,
  stringValue,
  toDependency,
  toDiagnostic,
  toFile,
  toProject,
  toRepository,
  toRevision,
  toSearchDocument,
  toSymbol,
  vectorHex,
};
