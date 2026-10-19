import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStructuralIndex } from '@forexplore/code-indexer';
import { InMemoryIndexStore, sliceSourceText, validateSearchDocumentsAgainstIndex } from './index-store.js';
import { createCodeIntelligenceRuntime } from './index.js';
import { seekDbProjectionInternals } from './seekdb-projection.js';
import { SeekDbIndexStore } from './seekdb-index-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

async function fixture(source: string, store = new InMemoryIndexStore()) {
  const root = await mkdtemp(path.join(tmpdir(), 'bounded-index-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), source);
  const runtime = await createCodeIntelligenceRuntime({ store });
  await runtime.registry.register({ repositoryId: 'bounded', localPath: root, role: 'target' });
  const run = await runtime.coordinator.run({ repositoryId: 'bounded' });
  return { root, runtime, store, scope: run.scope };
}

describe('bounded indexing and local reads', () => {
  it('projects a complete long implementation, including searchable tail ranges', async () => {
    const source = 'export function recoverUpload() {\n' + '  // pending upload progress\n'.repeat(1600) + '  return "tailRecoveryMarker";\n}\n';
    const { store, scope } = await fixture(source);
    const index = (await store.getStructuralIndex(scope))!;
    const fragments = (await store.listSearchDocuments(scope)).filter((document) => document.kind === 'source-fragment')
      .sort((a, b) => a.sourceRange!.startLine - b.sourceRange!.startLine || a.sourceRange!.startColumn - b.sourceRange!.startColumn);
    expect(fragments.map((document) => document.text).join('')).toBe(source);
    expect(fragments.every((document) => document.text.length <= 12000)).toBe(true);
    const hit = (await store.searchSearchDocuments(scope, 'tailRecoveryMarker', 10, 'source-fragment'))[0]!;
    expect(hit.sourceRange!.startLine).toBeGreaterThan(1000);
    const slice = await store.getSourceSlice(scope, 'main.ts', hit.sourceRange, 32000);
    expect(slice?.text).toBe(hit.text);
    expect(slice?.truncated).toBe(false);
    expect(slice?.file.sha256).toBe(index.files[0]!.sha256);
    expect(() => validateSearchDocumentsAgainstIndex(index, [{ ...hit, sourceRange: { ...hit.sourceRange!, endLine: 99999 } }], new Map(), null)).toThrow('declared symbol range');
  });

  it('keeps the previous active revision when a later projection batch fails', async () => {
    const { root, runtime, store, scope } = await fixture('export function stable() { return 1; }');
    const originalAppend = store.appendSearchDocuments.bind(store);
    let calls = 0;
    vi.spyOn(store, 'appendSearchDocuments').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('projection batch unavailable');
      await originalAppend(...args);
    });
    await writeFile(path.join(root, 'main.ts'), Array.from({ length: 350 }, (_, index) => `export function changed${index}() { return ${index}; }`).join('\n'));
    await expect(runtime.coordinator.run({ repositoryId: 'bounded' })).rejects.toThrow('projection batch unavailable');
    expect((await store.getRepository('bounded'))?.activeRevision).toBe(scope.analysisRevision);
    expect(await store.searchSearchDocuments(scope, 'stable', 10)).not.toHaveLength(0);
    expect((await store.listRevisions('bounded')).some((revision) => revision.status === 'failed')).toBe(true);
  });

  it('rebuilds and deduplicates full revisions without hydrating the previous structural index', async () => {
    const { root, runtime, store, scope } = await fixture('export function stable() { return 1; }');
    vi.spyOn(store, 'getStructuralIndex').mockRejectedValue(new Error('whole-index hydration unavailable'));
    const unchanged = await runtime.coordinator.run({ repositoryId: 'bounded', mode: 'full' });
    expect(unchanged.scope).toEqual(scope);
    await writeFile(path.join(root, 'main.ts'), 'export function replacement() { return 2; }');
    const changed = await runtime.coordinator.run({ repositoryId: 'bounded', mode: 'full' });
    expect(changed.scope.analysisRevision).not.toBe(scope.analysisRevision);
    expect((await store.getRepository('bounded'))?.activeRevision).toBe(changed.scope.analysisRevision);
    expect(await store.querySymbols(changed.scope, { relativePaths: ['main.ts'], limit: 10 }))
      .toMatchObject({ symbols: [expect.objectContaining({ name: 'replacement' })], truncated: false });
    expect(await store.querySymbols(scope, { relativePaths: ['main.ts'], limit: 10 }))
      .toMatchObject({ symbols: [expect.objectContaining({ name: 'stable' })], truncated: false });
  });

  it('returns precise end-exclusive slices and marks budget truncation', () => {
    expect(sliceSourceText('first\nsecond\nthird', { startLine: 2, startColumn: 2, endLine: 3, endColumn: 3 }, 32)).toEqual({
      text: 'econd\nth', sourceRange: { startLine: 2, startColumn: 2, endLine: 3, endColumn: 3 }, truncated: false,
    });
    expect(sliceSourceText('first\nsecond', undefined, 7)).toEqual({ text: 'first\ns',
      sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 2 }, truncated: true });
    expect(sliceSourceText('only', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }, 20)).toBeNull();
  });

  it('uses local symbol and dependency filters without whole-index reads', async () => {
    const { store, scope } = await fixture('export function first() {}\nexport function second() {}\n');
    vi.spyOn(store, 'getStructuralIndex').mockRejectedValue(new Error('unbounded read'));
    vi.spyOn(store, 'listSymbols').mockRejectedValue(new Error('unbounded read'));
    expect(await store.getStructuralIndexMetadata(scope)).toMatchObject(scope);
    expect(await store.getRevisionStatistics(scope)).toEqual({ projects: 1, files: 1, symbols: 2, dependencies: 2,
      diagnostics: 0, languages: [{ languageId: 'typescript', fileCount: 1, hasSemanticSymbols: false }] });
    const symbols = await store.querySymbols(scope, { relativePaths: ['main.ts'], kinds: ['function'], limit: 1 });
    expect(symbols.symbols).toHaveLength(1);
    expect(symbols.truncated).toBe(true);
    expect(await store.querySymbols(scope, { relativePaths: ['main.ts'], projectId: 'wrong-project', limit: 10 })).toEqual({ symbols: [], truncated: false });
    const dependencies = await store.queryDependencies(scope, { relativePaths: ['main.ts'], direction: 'outgoing', limit: 10 });
    expect(dependencies.dependencies).toHaveLength(2);
    expect(dependencies.dependencies.every((edge) => edge.kind === 'export')).toBe(true);
    expect(await store.queryDependencies(scope, { relativePaths: ['main.ts'], direction: 'incoming', limit: 10 })).toEqual({ dependencies: [], truncated: false });
    await expect(store.querySymbols(scope, { limit: 10 })).rejects.toThrow('anchors');
  });

  it('covers unsupported text as explicitly unbound chunks', () => {
    const source = '<project>' + 'dependency '.repeat(3000) + '</project>';
    const { index } = buildStructuralIndex({ repositoryId: 'xml', analysisRevision: 'one', files: [{ relativePath: 'pom.xml', content: source }] });
    const fragments = [...seekDbProjectionInternals.sourceDocuments(index, 'pom.xml', source, [])];
    expect(fragments.map((document) => document.text).join('')).toBe(source);
    expect(fragments.every((document) => document.symbolKey === undefined)).toBe(true);
  });

  it('pushes local filters, limits and source ranges into database reads', async () => {
    const query = vi.fn().mockResolvedValue([[]]);
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' },
      { query } as unknown as Pool);
    const scope = { repositoryId: 'repository', analysisRevision: 'revision' };
    await store.querySymbols(scope, { relativePaths: ['src/a.ts'], symbolKeys: ['key'], projectId: 'project', kinds: ['method'], limit: 8 });
    expect(query.mock.calls[0]![0]).toContain('symbol_key IN (?) OR relative_path IN (?)');
    expect(query.mock.calls[0]![0]).toContain('project_id = ? AND kind IN (?)');
    expect(query.mock.calls[0]![1]).toEqual(['repository', 'revision', 'key', 'src/a.ts', 'project', 'method', 9]);
    await store.queryDependencies(scope, { relativePaths: ['src/a.ts'], direction: 'incoming', limit: 4 });
    expect(query.mock.calls[1]![0]).toContain('d.target_relative_path IN (?)');
    expect(query.mock.calls[1]![1]).toEqual(['repository', 'revision', 'src/a.ts', 5]);
    query.mockResolvedValueOnce([[{ file_id: 'file', relative_path: 'src/a.ts', language_id: 'typescript', role: 'source',
      sha256: 'a'.repeat(64), size_bytes: 50, parse_status: 'parsed', project_id: 'project', source_text: 'second\nthird' }]]);
    const range = { startLine: 2, startColumn: 2, endLine: 3, endColumn: 3 };
    const slice = await store.getSourceSlice(scope, 'src/a.ts', range, 100);
    expect(query.mock.calls[2]![0]).toContain('SUBSTRING(source_text');
    expect(query.mock.calls[2]![0]).toContain('SUBSTRING_INDEX');
    expect(slice).toMatchObject({ text: 'econd\nth', sourceRange: range, truncated: false });
    expect(query.mock.calls[2]![1]).toEqual([2, 2, 103, 'repository', 'revision', 'src/a.ts', 2]);
  });

  it('fuses bounded candidate IDs before fetching source documents', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ search_document_id: 'shared', text_score: 4 }, { search_document_id: 'lexical', text_score: 3 }]])
      .mockResolvedValueOnce([[{ search_document_id: 'semantic', semantic_score: 0.9 }, { search_document_id: 'shared', semantic_score: 0.8 }]])
      .mockResolvedValueOnce([[{ search_document_id: 'shared', kind: 'source-fragment', relative_path: 'src/a.ts',
        symbol_key: null, source_range: null, module_artifact_id: null, content_hash: 'a'.repeat(64), title: 'implementation', document_text: 'actual code' }]]);
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' }, { query } as unknown as Pool);
    const results = await store.searchSearchDocuments({ repositoryId: 'repository', analysisRevision: 'revision', projectId: 'project' }, 'matching implementation', 1, 'source-fragment');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ searchDocumentId: 'shared', text: 'actual code', retrievalScore: { lexical: 4, semantic: 0.8 } });
    expect(query.mock.calls[0]![0].split('FROM')[0]).not.toContain('document_text');
    expect(query.mock.calls[0]![0]).toContain('implementation_eligible = 1');
    expect(query.mock.calls[0]![0]).not.toContain('document_text');
    expect(query.mock.calls[0]![1]).toEqual(['matching implementation', 'repository', 'revision', 'source-fragment', 'project', 'matching implementation', 24]);
    expect(query.mock.calls[1]![0].split('FROM')[0]).not.toContain('document_text');
    expect(query.mock.calls[1]![0]).toContain('implementation_eligible = 1');
    expect(query.mock.calls[1]![0]).not.toContain('document_text');
    expect(query.mock.calls[2]![1]).toEqual(['repository', 'revision', 'shared', 1]);
  });

  it('preserves each view under a saturated fragment corpus while sharing embedding and hydration', async () => {
    const kinds = ['symbol', 'source-fragment', 'summary'] as const;
    const embedding = { dimension: 384, identity: 'test', embed: vi.fn(),
      embedQuery: vi.fn(async () => [1, ...Array<number>(383).fill(0)]) };
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('document_text\n') && sql.includes('search_document_id IN')) {
        return [kinds.flatMap((kind) => [0, 1].map((i) => ({ search_document_id: `${kind}-${i}`, kind,
          relative_path: kind === 'summary' ? null : `${kind}.ts`, content_hash: 'hash', title: kind,
          document_text: kind === 'summary' ? '{}' : 'actual code' })))];
      }
      const requested = kinds.filter((kind) => values.includes(kind));
      if (sql.includes('ROW_NUMBER() OVER')) {
        return [requested.flatMap(kind => [0, 1].map(i => ({ repository_id: 'repository', analysis_revision: 'revision',
          search_document_id: `${kind}-${i}`, kind, text_score: 4 - i })))];
      }
      // Reproduce the failure: a union cut contains only fragments, despite
      // there being usable symbol and summary results in their own channels.
      const selected = requested.length === 1 ? requested[0]! : 'source-fragment';
      return [[0, 1].map((i) => ({ search_document_id: `${selected}-${i}`, kind: selected,
        ...(sql.includes('text_score') ? { text_score: 4 - i } : { semantic_score: 0.9 - i / 10 }) }))];
    });
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test',
      embeddingProvider: embedding }, { query } as unknown as Pool);
    const results = await store.searchSearchDocumentsByViews({ repositoryId: 'repository', analysisRevision: 'revision' },
      'implementation', { symbol: 2, 'source-fragment': 2, summary: 2 }, kinds);
    for (const kind of kinds) expect(results[kind]?.map((doc) => doc.searchDocumentId)).toEqual([`${kind}-0`, `${kind}-1`]);
    expect(embedding.embedQuery).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(5); // shared text scan, three scoped vector lookups, one hydration
    const textScans = query.mock.calls.filter(([sql]) => sql.includes('MATCH('));
    expect(textScans).toHaveLength(1);
    expect(textScans[0]![0]).toContain('PARTITION BY repository_id, analysis_revision, kind');
    expect(textScans[0]![0]).toContain('view_rank <= ?');
    expect(query.mock.calls.filter(([sql]) => sql.includes('search_document_id IN'))).toHaveLength(1);
  });

  it('shares one lexical scan across repositories while preserving revisions and unequal view budgets', async () => {
    const scopes = [{ repositoryId: 'a', analysisRevision: 'new-a' }, { repositoryId: 'b', analysisRevision: 'new-b' }];
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('ROW_NUMBER() OVER')) return [scopes.flatMap(scope => [0, 1, 2].map(i => ({
        repository_id: scope.repositoryId, analysis_revision: scope.analysisRevision,
        search_document_id: `${scope.repositoryId}-${i}`, kind: 'symbol', text_score: 5 - i,
      })))];
      if (sql.includes('cosine_distance')) return [[]];
      if (sql.includes('search_document_id IN')) {
        const scope = scopes.find(scope => values.includes(scope.repositoryId))!;
        return [[0, 1, 2].map(i => ({ search_document_id: `${scope.repositoryId}-${i}`, kind: 'symbol', relative_path: 'a.ts',
          content_hash: 'hash', title: 'Symbol', document_text: 'callable body' }))];
      }
      return [[]];
    });
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' }, { query } as unknown as Pool);
    const results = await store.searchSearchDocumentsBatch(scopes.map((scope, i) => ({ scope, query: 'same capability',
      views: ['symbol'], limits: { symbol: i + 1 } })));
    expect(results[0]!.symbol?.map(doc => doc.searchDocumentId)).toEqual(['a-0']);
    expect(results[1]!.symbol?.map(doc => doc.searchDocumentId)).toEqual(['b-0', 'b-1']);
    for (const [i, result] of results.entries()) expect(result.symbol?.every(doc =>
      doc.repositoryId === scopes[i]!.repositoryId && doc.analysisRevision === scopes[i]!.analysisRevision)).toBe(true);
    const scans = query.mock.calls.filter(([sql]) => sql.includes('MATCH('));
    expect(scans).toHaveLength(1);
    expect(scans[0]![1]).toContain('new-a');
    expect(scans[0]![1]).toContain('new-b');
    expect(query.mock.calls.filter(([sql]) => sql.includes('cosine_distance'))).toHaveLength(2);
  });

  it('rejects leaked lexical rows and cancels batches before acquiring connections', async () => {
    const query = vi.fn(async () => [[{ repository_id: 'wrong', analysis_revision: 'old', kind: 'symbol', search_document_id: 'bad', text_score: 1 }]]);
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' }, { query } as unknown as Pool);
    const requests = ['a', 'b'].map(repositoryId => ({ scope: { repositoryId, analysisRevision: 'current' }, query: 'capability',
      views: ['symbol'] as const, limits: { symbol: 1 } }));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(store.searchSearchDocumentsBatch(requests, controller.signal)).rejects.toThrow('cancelled');
    expect(query).not.toHaveBeenCalled();
    await expect(store.searchSearchDocumentsBatch(requests)).rejects.toThrow('outside its requested scopes');
  });

  it('keeps project-scoped lexical scans separate within the same repository revision', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('MATCH(')) return [[{ search_document_id: `project-${values[4]}`, kind: 'symbol', text_score: 5 }]];
      if (sql.includes('cosine_distance')) return [[]];
      if (sql.includes('search_document_id IN')) return [[{ search_document_id: values[2], kind: 'symbol',
        relative_path: 'a.ts', content_hash: 'hash', title: 'Symbol', document_text: 'callable body' }]];
      return [[]];
    });
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' }, { query } as unknown as Pool);
    const results = await store.searchSearchDocumentsBatch(['a', 'b'].map(projectId => ({
      scope: { repositoryId: 'repository', analysisRevision: 'revision', projectId },
      query: 'same capability', views: ['symbol'], limits: { symbol: 1 },
    })));
    expect(results.map(result => result.symbol?.map(doc => doc.searchDocumentId))).toEqual([['project-a'], ['project-b']]);
    const scans = query.mock.calls.filter(([sql]) => sql.includes('MATCH('));
    expect(scans).toHaveLength(2);
    for (const [sql, values] of scans) {
      expect(sql).toContain('AND project_id = ?');
      expect(['a', 'b']).toContain(values[4]);
    }
  });

  it.each([false, true])('resumes the eligibility migration without rebuilding vectors (column already created: %s)', async (columnExists) => {
    const applied = new Set([1, 2, 3]);
    const embedding = { dimension: 384, identity: 'unchanged-model', embed: vi.fn() };
    let store: SeekDbIndexStore;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === 'SELECT VERSION() AS version') return [[{ version: 'seekdb-v1.2' }]];
      if (sql.includes('SELECT version FROM')) return [[...applied].map(version => ({ version }))];
      if (sql.includes("LIKE 'implementation_eligible'")) return [columnExists ? [{ Field: 'implementation_eligible' }] : []];
      if (sql.includes('SELECT config_hash')) return [[{ config_hash: store.embeddingIdentity }]];
      if (sql.includes('INSERT IGNORE INTO') && sql.includes('schema_migrations')) applied.add(Number(values![0]));
      return [[]];
    });
    store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test',
      embeddingProvider: embedding }, { query } as unknown as Pool);
    await store.initialize();
    await store.initialize();
    const alterations = query.mock.calls.filter(([sql]) => sql.includes('ADD COLUMN implementation_eligible'));
    expect(alterations).toHaveLength(columnExists ? 0 : 1);
    if (!columnExists) expect(alterations[0]![0]).toContain('GENERATED ALWAYS AS');
    expect(applied).toEqual(new Set([1, 2, 3, 4]));
    expect(embedding.embed).not.toHaveBeenCalled();
  });
});
