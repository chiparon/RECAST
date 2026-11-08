import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
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
  InMemoryIndexStore,
  type IndexStore,
  type LocalDependencyQuery,
  type LocalSymbolQuery,
  type RevisionStatistics,
  type SearchDocumentQuery,
  type SearchDocumentsByView,
  type SourceSlice,
  type SourceTextReader,
} from './index-store.js';
import { compactLexicalQuery } from './seekdb-index-store.js';

export interface Sag2Bm25Config {
  /** SQLite file path or `:memory:` (default). */
  databasePath?: string;
  /** Weight of the title/symbol-name column in FTS5 bm25(). Default: 3.0. */
  titleWeight?: number;
  /** Weight of the document body column in FTS5 bm25(). Default: 1.0. */
  bodyWeight?: number;
  /** Emit CJK character bigrams in addition to Intl.Segmenter word tokens. Default: true. */
  cjkBigrams?: boolean;
  /** Maximum query terms per FTS5 MATCH expression. Default: 24. */
  maxQueryTerms?: number;
}

const zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const tokenChunkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z0-9_]+/gu;

const sag2StopWords = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'module', 'project', 'target', 'language', 'repository',
  'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'class', 'interface', 'enum',
  'record', 'package', 'import', 'namespace', 'using', 'extends', 'implements', 'override', 'virtual',
  'void', 'object', 'string', 'boolean', 'bool', 'int', 'long', 'double', 'float', 'byte', 'char',
  'return', 'throws', 'throw', 'new', 'null', 'true', 'false', 'async', 'await', 'base', 'get', 'set',
]);

function splitIdentifierParts(identifier: string): string[] {
  const separated = identifier
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ');
  const parts = separated
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 2 && !sag2StopWords.has(part));
  const full = identifier.toLowerCase().replaceAll('_', '');
  if (full.length >= 2 && !sag2StopWords.has(full) && !parts.includes(full)) {
    return [full, ...parts];
  }
  return parts;
}

/**
 * Tokenize code and bilingual text for SAG2 BM25 indexing.
 * Splits camelCase/PascalCase/snake_case identifiers while retaining exact names,
 * and segments Chinese text with both Intl.Segmenter words and overlapping CJK bigrams.
 */
export function tokenizeSag2Text(text: string, cjkBigrams = true): string[] {
  const normalized = text.normalize('NFKC');
  const tokens: string[] = [];
  for (const match of normalized.matchAll(tokenChunkPattern)) {
    const chunk = match[0];
    if (!chunk) continue;
    if (!cjkPattern.test(chunk)) {
      for (const token of splitIdentifierParts(chunk)) {
        tokens.push(token);
      }
      continue;
    }
    const wordSegments = [...zhSegmenter.segment(chunk)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment.trim())
      .filter((segment) => segment.length > 0);
    for (const word of wordSegments) {
      tokens.push(word);
    }
    if (cjkBigrams) {
      const chars = [...chunk];
      if (chars.length === 1 && wordSegments.length === 0) {
        tokens.push(chars[0]!);
      }
      for (let i = 0; i < chars.length - 1; i++) {
        const bigram = chars[i]! + chars[i + 1]!;
        tokens.push(bigram);
      }
    }
  }
  return tokens;
}

function scopeToken(scope: RepositoryRevisionScope): string {
  const digest = createHash('sha256')
    .update(`${scope.repositoryId}\u0000${scope.analysisRevision}`)
    .digest('hex')
    .slice(0, 20);
  return ` sag2scope_${digest} `;
}

function kindToken(kind: SearchDocumentRecord['kind']): string {
  return `sag2kind_${kind.replaceAll('-', '_')}`;
}

function projectToken(projectId: string | null | undefined): string {
  if (!projectId) return 'sag2proj_none';
  const digest = createHash('sha256').update(projectId).digest('hex').slice(0, 16);
  return `sag2proj_${digest}`;
}

/**
 * Build a safe FTS5 MATCH expression that filters scope, view kind, and optional
 * project directly inside the FTS5 inverted index before ranking candidate terms.
 */
export function buildSag2FtsMatchQuery(
  scope: RepositoryRevisionScope & { projectId?: string },
  query: string,
  kinds: readonly SearchDocumentRecord['kind'][],
  options: { cjkBigrams?: boolean; maxQueryTerms?: number } = {},
): string | null {
  const compacted = compactLexicalQuery(query, 4_096, options.maxQueryTerms ?? 24);
  const rawTokens = tokenizeSag2Text(compacted, options.cjkBigrams ?? true);
  const uniqueTokens = [...new Set(rawTokens.filter((token) => token.length >= 2 || cjkPattern.test(token)))]
    .slice(0, options.maxQueryTerms ?? 24);
  if (uniqueTokens.length === 0 || kinds.length === 0) return null;

  const quote = (token: string): string => `"${token.replaceAll('"', '""')}"`;
  const scopeFilter = `scope_token : ${quote(scopeToken(scope).trim())}`;
  const kindFilter = kinds.length === 1
    ? `kind_token : ${quote(kindToken(kinds[0]!))}`
    : `(${kinds.map((kind) => `kind_token : ${quote(kindToken(kind))}`).join(' OR ')})`;
  const projectFilter = scope.projectId
    ? ` AND project_token : ${quote(projectToken(scope.projectId))}`
    : '';
  const contentClause = `{title_tokens body_tokens} : (${uniqueTokens.map(quote).join(' OR ')})`;
  return `${scopeFilter} AND ${kindFilter}${projectFilter} AND ${contentClause}`;
}

function extractSummarySearchText(document: SearchDocumentRecord): { searchableText: string; projectId: string | null } {
  if (document.kind !== 'summary') {
    return { searchableText: document.text, projectId: null };
  }
  try {
    const parsed = JSON.parse(document.text) as Record<string, unknown>;
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : null;
    const parts = [
      typeof parsed.name === 'string' ? parsed.name : '',
      typeof parsed.purpose === 'string' ? parsed.purpose : '',
      typeof parsed.description === 'string' ? parsed.description : '',
      typeof parsed.domain === 'string' ? parsed.domain : '',
      Array.isArray(parsed.coreApis) ? parsed.coreApis.filter((v): v is string => typeof v === 'string').join('\n') : '',
      Array.isArray(parsed.dependsOn) ? parsed.dependsOn.filter((v): v is string => typeof v === 'string').join(' ') : '',
      Array.isArray(parsed.sourceFiles) ? parsed.sourceFiles.filter((v): v is string => typeof v === 'string').join(' ') : '',
      Array.isArray(parsed.symbolCards)
        ? parsed.symbolCards
            .flatMap((card) => {
              if (!card || typeof card !== 'object') return [];
              const record = card as Record<string, unknown>;
              return [record.name, record.signature, record.path].filter((v): v is string => typeof v === 'string');
            })
            .join('\n')
        : '',
    ].filter(Boolean);
    return {
      searchableText: parts.length > 0 ? parts.join('\n') : document.text,
      projectId,
    };
  } catch {
    return { searchableText: document.text, projectId: null };
  }
}

/**
 * Embedding-free SQLite FTS5 + BM25 index following SAG2 architecture.
 *
 * Scope (`repositoryId + analysisRevision`), view (`kind`), and `projectId` are
 * indexed as dedicated FTS5 columns so every query executes entirely through the
 * FTS5 inverted index (`VIRTUAL TABLE INDEX`) rather than scanning a relational
 * scope index first.
 */
export class Sag2SqliteBm25Index {
  readonly db: DatabaseSync;
  readonly #titleWeight: number;
  readonly #bodyWeight: number;
  readonly #cjkBigrams: boolean;
  readonly #maxQueryTerms: number;
  readonly #statements = new Map<string, StatementSync>();
  #closed = false;

  constructor(config: Sag2Bm25Config = {}) {
    this.#titleWeight = config.titleWeight ?? 3.0;
    this.#bodyWeight = config.bodyWeight ?? 1.0;
    this.#cjkBigrams = config.cjkBigrams ?? true;
    this.#maxQueryTerms = config.maxQueryTerms ?? 24;
    this.db = new DatabaseSync(config.databasePath ?? ':memory:');
    this.#initializeSchema();
  }

  #initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS sag2_documents (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id TEXT NOT NULL,
        analysis_revision TEXT NOT NULL,
        search_document_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        module_artifact_id TEXT,
        relative_path TEXT,
        symbol_key TEXT,
        source_range_json TEXT,
        content_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        document_text TEXT NOT NULL,
        UNIQUE(repository_id, analysis_revision, search_document_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sag2_documents_scope
        ON sag2_documents(repository_id, analysis_revision, kind);

      CREATE VIRTUAL TABLE IF NOT EXISTS sag2_fts USING fts5(
        scope_token,
        kind_token,
        project_token,
        title_tokens,
        body_tokens,
        tokenize = 'unicode61'
      );
    `);
  }

  #statement(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  indexDocuments(
    scope: RepositoryRevisionScope,
    documents: readonly SearchDocumentRecord[],
    fileProjectMap: ReadonlyMap<string, string | undefined> = new Map(),
  ): void {
    if (documents.length === 0) return;
    const findExisting = this.#statement(`
      SELECT rowid FROM sag2_documents
      WHERE repository_id = ? AND analysis_revision = ? AND search_document_id = ?
    `);
    const deleteExistingDoc = this.#statement('DELETE FROM sag2_documents WHERE rowid = ?');
    const deleteExistingFts = this.#statement('DELETE FROM sag2_fts WHERE rowid = ?');
    const insertDoc = this.#statement(`
      INSERT INTO sag2_documents (
        repository_id, analysis_revision, search_document_id, kind, project_id,
        module_artifact_id, relative_path, symbol_key, source_range_json,
        content_hash, title, document_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.#statement(`
      INSERT INTO sag2_fts (rowid, scope_token, kind_token, project_token, title_tokens, body_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const sToken = scopeToken(scope).trim();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const doc of documents) {
        const existing = findExisting.get(doc.repositoryId, doc.analysisRevision, doc.searchDocumentId) as { rowid?: number | bigint } | undefined;
        if (existing?.rowid !== undefined) {
          deleteExistingFts.run(Number(existing.rowid));
          deleteExistingDoc.run(Number(existing.rowid));
        }
        const { searchableText, projectId: summaryProjectId } = extractSummarySearchText(doc);
        const projectId = doc.relativePath
          ? (fileProjectMap.get(doc.relativePath) ?? null)
          : summaryProjectId;
        const result = insertDoc.run(
          doc.repositoryId,
          doc.analysisRevision,
          doc.searchDocumentId,
          doc.kind,
          projectId,
          doc.moduleArtifactId ?? null,
          doc.relativePath,
          doc.symbolKey ?? null,
          doc.sourceRange ? JSON.stringify(doc.sourceRange) : null,
          doc.contentHash,
          doc.title,
          doc.text,
        );
        const rowid = Number(result.lastInsertRowid);
        const titleTokens = tokenizeSag2Text(`${doc.title} ${doc.relativePath ?? ''}`, this.#cjkBigrams).join(' ');
        const bodyTokens = tokenizeSag2Text(searchableText, this.#cjkBigrams).join(' ');
        insertFts.run(
          rowid,
          sToken,
          kindToken(doc.kind),
          projectToken(projectId),
          titleTokens,
          bodyTokens,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteScopeDocuments(
    scope: RepositoryRevisionScope,
    options: { kind?: SearchDocumentRecord['kind']; moduleArtifactId?: string } = {},
  ): void {
    const clauses = ['repository_id = ?', 'analysis_revision = ?'];
    const params: SQLInputValue[] = [scope.repositoryId, scope.analysisRevision];
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options.moduleArtifactId !== undefined) {
      clauses.push('module_artifact_id = ?');
      params.push(options.moduleArtifactId);
    }
    const where = clauses.join(' AND ');
    const rows = this.#statement(`SELECT rowid FROM sag2_documents WHERE ${where}`).all(...params) as Array<{ rowid: number | bigint }>;
    if (rows.length === 0) return;
    const deleteFts = this.#statement('DELETE FROM sag2_fts WHERE rowid = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        deleteFts.run(Number(row.rowid));
      }
      this.#statement(`DELETE FROM sag2_documents WHERE ${where}`).run(...params);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteRepository(repositoryId: RepositoryId): void {
    const rows = this.#statement('SELECT rowid FROM sag2_documents WHERE repository_id = ?').all(repositoryId) as Array<{ rowid: number | bigint }>;
    if (rows.length === 0) return;
    const deleteFts = this.#statement('DELETE FROM sag2_fts WHERE rowid = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        deleteFts.run(Number(row.rowid));
      }
      this.#statement('DELETE FROM sag2_documents WHERE repository_id = ?').run(repositoryId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  searchByViews(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limits: Partial<Record<SearchDocumentRecord['kind'], number>>,
    views: readonly SearchDocumentRecord['kind'][],
  ): Partial<Record<SearchDocumentRecord['kind'], SearchDocumentRecord[]>> {
    if (!query.trim()) return {};
    const result: Partial<Record<SearchDocumentRecord['kind'], SearchDocumentRecord[]>> = {};
    const sql = `
      SELECT
        d.repository_id,
        d.analysis_revision,
        d.search_document_id,
        d.kind,
        d.module_artifact_id,
        d.relative_path,
        d.symbol_key,
        d.source_range_json,
        d.content_hash,
        d.title,
        d.document_text,
        -bm25(sag2_fts, 0.0, 0.0, 0.0, ?, ?) AS bm25_score
      FROM sag2_fts
      CROSS JOIN sag2_documents d ON d.rowid = sag2_fts.rowid
      WHERE sag2_fts MATCH ?
      ORDER BY bm25(sag2_fts, 0.0, 0.0, 0.0, ?, ?), d.search_document_id
      LIMIT ?
    `;
    const stmt = this.#statement(sql);
    for (const view of new Set(views)) {
      const rawLimit = limits[view];
      if (!rawLimit || !Number.isInteger(rawLimit) || rawLimit < 1) continue;
      const limit = Math.min(rawLimit, 200);
      const matchExpr = buildSag2FtsMatchQuery(scope, query, [view], {
        cjkBigrams: this.#cjkBigrams,
        maxQueryTerms: this.#maxQueryTerms,
      });
      if (!matchExpr) {
        result[view] = [];
        continue;
      }
      const rows = stmt.all(
        this.#titleWeight,
        this.#bodyWeight,
        matchExpr,
        this.#titleWeight,
        this.#bodyWeight,
        limit,
      ) as Array<Record<string, unknown>>;
      result[view] = rows.map((row) => {
        const score = Math.max(0, Number(row.bm25_score ?? 0));
        const record: SearchDocumentRecord = {
          repositoryId: String(row.repository_id),
          analysisRevision: String(row.analysis_revision),
          searchDocumentId: String(row.search_document_id),
          kind: String(row.kind) as SearchDocumentRecord['kind'],
          relativePath: row.relative_path === null ? null : String(row.relative_path),
          ...(row.symbol_key !== null ? { symbolKey: String(row.symbol_key) } : {}),
          ...(row.source_range_json !== null ? { sourceRange: JSON.parse(String(row.source_range_json)) as SourceRange } : {}),
          ...(row.module_artifact_id !== null ? { moduleArtifactId: String(row.module_artifact_id) } : {}),
          contentHash: String(row.content_hash),
          title: String(row.title),
          text: String(row.document_text),
          retrievalScore: {
            lexical: score,
            fusion: score,
          },
        };
        return record;
      });
    }
    return result;
  }

  /** Inspect SQLite's query plan to verify FTS5 inverted-index driving order. */
  explainQueryPlan(): string[] {
    const sql = `
      EXPLAIN QUERY PLAN
      SELECT d.search_document_id, -bm25(sag2_fts, 0.0, 0.0, 0.0, 3.0, 1.0)
      FROM sag2_fts
      CROSS JOIN sag2_documents d ON d.rowid = sag2_fts.rowid
      WHERE sag2_fts MATCH ?
      ORDER BY bm25(sag2_fts, 0.0, 0.0, 0.0, 3.0, 1.0), d.search_document_id
      LIMIT 32
    `;
    const rows = this.db.prepare(sql).all('scope_token : "sag2scope_test"') as Array<{ detail?: unknown }>;
    return rows.map((row) => String(row.detail ?? ''));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.db.close();
  }
}

/**
 * Embedding-free IndexStore backed by SQLite FTS5 BM25 (SAG2).
 * Delegates structural revision storage to an inner IndexStore while serving
 * all search document projections via Sag2SqliteBm25Index with zero embeddings.
 */
export class Sag2Bm25IndexStore implements IndexStore {
  readonly bm25: Sag2SqliteBm25Index;
  readonly #inner: IndexStore;

  constructor(options: { inner?: IndexStore; bm25?: Sag2Bm25Config } = {}) {
    this.#inner = options.inner ?? new InMemoryIndexStore();
    this.bm25 = new Sag2SqliteBm25Index(options.bm25);
  }

  async initialize(): Promise<void> {
    await this.#inner.initialize?.();
  }

  async close(): Promise<void> {
    this.bm25.close();
    await this.#inner.close?.();
  }

  putRepository(repository: RepositoryRecord): Promise<void> {
    return this.#inner.putRepository(repository);
  }

  getRepository(repositoryId: RepositoryId, signal?: AbortSignal): Promise<RepositoryRecord | null> {
    return this.#inner.getRepository(repositoryId, signal);
  }

  listRepositories(): Promise<RepositoryRecord[]> {
    return this.#inner.listRepositories();
  }

  async removeRepository(repositoryId: RepositoryId): Promise<void> {
    await this.#inner.removeRepository(repositoryId);
    this.bm25.deleteRepository(repositoryId);
  }

  putRevision(revision: AnalysisRevisionRecord): Promise<void> {
    return this.#inner.putRevision(revision);
  }

  getRevision(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<AnalysisRevisionRecord | null> {
    return this.#inner.getRevision(scope, signal);
  }

  listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]> {
    return this.#inner.listRevisions(repositoryId);
  }

  async deleteRevision(scope: RepositoryRevisionScope): Promise<void> {
    await this.#inner.deleteRevision(scope);
    this.bm25.deleteScopeDocuments(scope);
  }

  async putStructuralIndex(index: StructuralIndex, sourceTexts?: ReadonlyMap<string, string>): Promise<void> {
    await this.#inner.putStructuralIndex(index, sourceTexts);
    this.bm25.deleteScopeDocuments(index);
  }

  getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null> {
    return this.#inner.getStructuralIndex(scope);
  }

  getStructuralIndexMetadata(
    scope: RepositoryRevisionScope,
    signal?: AbortSignal,
  ): Promise<Pick<StructuralIndex, 'repositoryId' | 'analysisRevision' | 'analysisHash'> | null> {
    if (this.#inner.getStructuralIndexMetadata) {
      return this.#inner.getStructuralIndexMetadata(scope, signal);
    }
    return this.#inner.getStructuralIndex(scope).then((idx) =>
      idx ? { repositoryId: idx.repositoryId, analysisRevision: idx.analysisRevision, analysisHash: idx.analysisHash } : null,
    );
  }

  getRevisionStatistics(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<RevisionStatistics | null> {
    if (!this.#inner.getRevisionStatistics) return Promise.resolve(null);
    return this.#inner.getRevisionStatistics(scope, signal);
  }

  async putStructuralIndexFromSource(
    index: StructuralIndex,
    source: SourceTextReader,
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<void> {
    if (this.#inner.putStructuralIndexFromSource) {
      await this.#inner.putStructuralIndexFromSource(index, source, signal, onProgress);
    } else {
      await this.#inner.putStructuralIndex(index);
    }
    this.bm25.deleteScopeDocuments(index);
  }

  async appendSearchDocuments(
    index: StructuralIndex,
    documents: SearchDocumentRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#inner.appendSearchDocuments) {
      await this.#inner.appendSearchDocuments(index, documents, signal);
    } else {
      await this.#inner.replaceSearchDocuments(index, documents);
    }
    const fileMap = new Map(index.files.map((file) => [file.relativePath, file.projectId]));
    this.bm25.indexDocuments(index, documents, fileMap);
  }

  getSourceText(scope: RepositoryRevisionScope, relativePath: string): Promise<string | null> {
    return this.#inner.getSourceText(scope, relativePath);
  }

  getSourcePreview(
    scope: RepositoryRevisionScope,
    relativePath: string,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean } | null> {
    if (!this.#inner.getSourcePreview) return Promise.resolve(null);
    return this.#inner.getSourcePreview(scope, relativePath, maxChars, signal);
  }

  listProjects(scope: RepositoryRevisionScope): Promise<ProjectRecord[]> {
    return this.#inner.listProjects(scope);
  }

  getProject(scope: RepositoryRevisionScope, projectId: string, signal?: AbortSignal): Promise<ProjectRecord | null> {
    if (!this.#inner.getProject) {
      return this.#inner.listProjects(scope).then((projects) => projects.find((p) => p.projectId === projectId) ?? null);
    }
    return this.#inner.getProject(scope, projectId, signal);
  }

  getModuleArtifacts(
    scope: RepositoryRevisionScope,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<ModuleArtifactRecord[]> {
    if (!this.#inner.getModuleArtifacts) {
      return this.#inner.listModuleArtifacts(scope).then((all) => all.filter((a) => ids.includes(a.moduleArtifactId)));
    }
    return this.#inner.getModuleArtifacts(scope, ids, signal);
  }

  listFiles(scope: RepositoryRevisionScope): Promise<IndexedFileRecord[]> {
    return this.#inner.listFiles(scope);
  }

  listSymbols(scope: RepositoryRevisionScope): Promise<SymbolRecord[]> {
    return this.#inner.listSymbols(scope);
  }

  listDependencyEdges(scope: RepositoryRevisionScope): Promise<DependencyEdgeRecord[]> {
    return this.#inner.listDependencyEdges(scope);
  }

  listDiagnostics(scope: RepositoryRevisionScope): Promise<IndexDiagnosticRecord[]> {
    return this.#inner.listDiagnostics(scope);
  }

  queryFiles(
    scope: RepositoryRevisionScope,
    query: { projectId?: string; relativePaths?: readonly string[]; after?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<{ files: IndexedFileRecord[]; truncated: boolean }> {
    if (!this.#inner.queryFiles) return Promise.resolve({ files: [], truncated: false });
    return this.#inner.queryFiles(scope, query, signal);
  }

  querySymbols(
    scope: RepositoryRevisionScope,
    query: LocalSymbolQuery,
    signal?: AbortSignal,
  ): Promise<{ symbols: SymbolRecord[]; truncated: boolean }> {
    if (!this.#inner.querySymbols) return Promise.resolve({ symbols: [], truncated: false });
    return this.#inner.querySymbols(scope, query, signal);
  }

  queryDependencies(
    scope: RepositoryRevisionScope,
    query: LocalDependencyQuery,
    signal?: AbortSignal,
  ): Promise<{ dependencies: DependencyEdgeRecord[]; truncated: boolean }> {
    if (!this.#inner.queryDependencies) return Promise.resolve({ dependencies: [], truncated: false });
    return this.#inner.queryDependencies(scope, query, signal);
  }

  getSourceSlice(
    scope: RepositoryRevisionScope,
    relativePath: string,
    sourceRange: SourceRange | undefined,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<SourceSlice | null> {
    if (!this.#inner.getSourceSlice) return Promise.resolve(null);
    return this.#inner.getSourceSlice(scope, relativePath, sourceRange, maxChars, signal);
  }

  putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void> {
    return this.#inner.putModuleArtifact(artifact);
  }

  listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]> {
    return this.#inner.listModuleArtifacts(scope);
  }

  async replaceSearchDocuments(
    scope: RepositoryRevisionScope,
    documents: SearchDocumentRecord[],
    moduleArtifactId?: string,
  ): Promise<void> {
    await this.#inner.replaceSearchDocuments(scope, documents, moduleArtifactId);
    const files = await this.#inner.listFiles(scope);
    const fileMap = new Map(files.map((file) => [file.relativePath, file.projectId]));
    if (moduleArtifactId !== undefined) {
      this.bm25.deleteScopeDocuments(scope, { kind: 'summary', moduleArtifactId });
    } else {
      this.bm25.deleteScopeDocuments(scope);
    }
    this.bm25.indexDocuments(scope, documents, fileMap);
  }

  listSearchDocuments(scope: RepositoryRevisionScope): Promise<SearchDocumentRecord[]> {
    return this.#inner.listSearchDocuments(scope);
  }

  async searchSearchDocuments(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limit: number,
    kind: SearchDocumentRecord['kind'] = 'symbol',
    signal?: AbortSignal,
  ): Promise<SearchDocumentRecord[]> {
    signal?.throwIfAborted();
    return this.bm25.searchByViews(scope, query, { [kind]: limit }, [kind])[kind] ?? [];
  }

  async searchSearchDocumentsByViews(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limits: Partial<Record<SearchDocumentRecord['kind'], number>>,
    views: readonly SearchDocumentRecord['kind'][],
    signal?: AbortSignal,
  ): Promise<Partial<Record<SearchDocumentRecord['kind'], SearchDocumentRecord[]>>> {
    signal?.throwIfAborted();
    return this.bm25.searchByViews(scope, query, limits, views);
  }

  async searchSearchDocumentsBatch(
    requests: readonly SearchDocumentQuery[],
    signal?: AbortSignal,
  ): Promise<SearchDocumentsByView[]> {
    signal?.throwIfAborted();
    return requests.map((request) => {
      signal?.throwIfAborted();
      return this.bm25.searchByViews(request.scope, request.query, request.limits, request.views);
    });
  }

  async activateRevision(
    scope: RepositoryRevisionScope,
    status: Extract<RepositoryAnalysisStatus, 'ready' | 'degraded'> = 'ready',
  ): Promise<void> {
    const previous = await this.#inner.getRepository(scope.repositoryId);
    await this.#inner.activateRevision(scope, status);
    if (previous?.activeRevision && previous.activeRevision !== scope.analysisRevision) {
      this.bm25.deleteScopeDocuments(
        { repositoryId: scope.repositoryId, analysisRevision: previous.activeRevision },
        { kind: 'summary' },
      );
    }
  }
}
