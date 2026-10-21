/**
 * Read-only, full module-retrieval benchmark using the extension's real model
 * reranker. No indexing, target edits, translation, or schema setup.
 *
 * npx tsx scripts/benchmark-module-retrieval.mts --rounds 2
 * Options: --database NAME --out DIRECTORY --rounds N --max-modules N
 *          --variants original,optimized --modules ID,ID --concurrent --list
 *
 * "original" reconstructs only the two changes under comparison, inside this
 * process: use the original complete full-text query and bypass the new gate.
 * All other code, SQL, vector queries, candidate limits, model and timeouts are
 * identical. It does not change production settings or claim to run main.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { parse } from 'dotenv';
import { indexModuleHierarchy, type ModuleTarget, type ProjectAnalysisRecord } from '@forexplore/contracts';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store.js';
import { searchModules, moduleMatchingInternals, type ModuleMatchRequest, type ModuleSearchTiming } from '../services/code-intelligence-service/src/module-matching.js';
import { ModelSearchEmbeddingProvider } from '../services/code-intelligence-service/src/search-embedding.js';
import { ConfiguredModelReranker } from '../apps/vscode-extension/src/model-reranker.js';

execFileSync(process.execPath, ['scripts/check-platform-workspace.mjs'], { stdio: 'inherit' });
const option = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1] ?? fallback;
};
const environmentFile = resolve('services/adaptation-service/.env');
if (existsSync(environmentFile)) {
  for (const [key, value] of Object.entries(parse(readFileSync(environmentFile)))) process.env[key] ??= value;
}
// These modules capture model configuration at import time; load the env first.
const { createHttpServer } = await import('../services/adaptation-service/src/http-server.js');
const { rankRetrieval } = await import('../services/adaptation-service/src/retrieval-rerank.js');
const { deepSeekModelConfig } = await import('../services/adaptation-service/src/model-config.js');
const rounds = Number(option('rounds', '2'));
const maxModules = Number(option('max-modules', '0'));
const selectedIds = option('modules', '').split(',').filter(Boolean);
const variants = option('variants', 'original,optimized').split(',');
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10 || !Number.isInteger(maxModules) || maxModules < 0 ||
    variants.some(v => !['original', 'optimized'].includes(v))) throw new Error('Invalid benchmark options.');
const database = option('database', 'forexplore_asset_upgrade_20261004');
const output = resolve(option('out', `tmp/retrieval-rerank-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const context = new AsyncLocalStorage<{ id: string; variant: string; fullQuery: string }>();
const activeQueries = new Map<string, NonNullable<ReturnType<typeof context.getStore>>>();
const measurements: Array<{ request: string; kind: string; stage: string; ms: number; waitMs?: number; repository?: string }> = [];
const modelCalls: Array<Record<string, unknown>> = [];
const backendFailures: Array<Record<string, unknown>> = [];
const reports: Array<Record<string, any>> = [];
const batches: Array<Record<string, unknown>> = [];
const startedAt = new Date().toISOString();
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database,
  connectionLimit: 8, enableKeepAlive: true, decimalNumbers: true });
const sqlStage = (sql: string): string => {
  if (sql.includes('MATCH(search_text)')) return 'fulltext';
  if (sql.includes('cosine_distance(')) return 'vector';
  if (sql.includes('module_artifacts')) return 'artifacts';
  if (sql.includes('search_documents')) return 'hydrate';
  if (sql.includes('analysis_revisions')) return 'revision';
  if (sql.includes('repositories')) return 'repository';
  if (sql.includes('projects')) return 'project';
  if (sql.includes('source_text')) return 'preview';
  return 'other';
};
const monitoredPool = new Proxy(pool, { get(object, key) {
  if (key === 'getConnection') return async () => {
    const own = context.getStore();
    const started = performance.now();
    const connection = await object.getConnection();
    const waitMs = performance.now() - started;
    return new Proxy(connection, { get(conn, member) {
      if (member === 'query') return async (...args: any[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0].sql;
        const stage = sqlStage(sql);
        if (stage === 'fulltext' && own?.variant === 'original') {
          // Both MATCH placeholders used the complete trimmed query before the
          // lexical optimization. The vector input remains untouched.
          const values = [...args[1]];
          values[0] = own.fullQuery.trim(); values[values.length - 2] = own.fullQuery.trim();
          args[1] = values;
        }
        const started = performance.now();
        try { return await (conn.query as any)(...args); }
        finally { measurements.push({ request: own?.id ?? 'setup', kind: 'sql', stage,
          waitMs, ms: performance.now() - started }); }
      };
      const value = Reflect.get(conn, member, conn);
      return typeof value === 'function' ? value.bind(conn) : value;
    } });
  };
  const value = Reflect.get(object, key, object);
  return typeof value === 'function' ? value.bind(object) : value;
} });
// Admission changes are confined to this benchmark process. In sequential runs
// the gate contributes no queue time; concurrent runs exercise both policies.
const gate = moduleMatchingInternals.moduleSearchGate;
const acquire = gate.acquire.bind(gate);
gate.acquire = async (signal?: AbortSignal) => {
  if (context.getStore()?.variant !== 'original') return acquire(signal);
  signal?.throwIfAborted();
  return () => {};
};
const embeddingUrl = process.env.CODE_INTELLIGENCE_EMBEDDING_URL ?? 'http://127.0.0.1:4021/v1/embeddings';
let server: ReturnType<typeof createHttpServer> | undefined;
let metadata: Record<string, any> = {};
const nativeFetch = globalThis.fetch;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const persist = async (): Promise<void> => {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ ...metadata, startedAt, updatedAt: new Date().toISOString(),
    reports, batches, modelCalls, backendFailures, measurements }, null, 2));
  await writeFile(resolve(output, 'report.csv'), [
    'mode,variant,language,module,run,status,queueMs,recallAndAggregateMs,candidatePrepareMs,rerankMs,revisionCheckMs,executionMs,totalMs,rerankCandidates,rerankFallback,rerankError,repository,candidate',
    ...reports.map(r => [r.mode, r.variant, r.language, r.module, r.run, r.status,
      ...['queueMs', 'recallAndAggregateMs', 'candidatePrepareMs', 'rerankMs', 'revisionCheckMs', 'executionMs', 'totalMs'].map(k => Math.round(r.timing?.[k] ?? 0)),
      r.timing?.rerankCandidateCount ?? 0, r.timing?.rerankFallback ?? false, r.timing?.rerankError ?? '',
      r.candidate?.repository ?? '', r.candidate?.module ?? ''].map(v => JSON.stringify(v)).join(',')),
  ].join('\n') + '\n');
};
try {
  const healthResponse = await nativeFetch(new URL('/health', embeddingUrl), { signal: AbortSignal.timeout(5000) });
  if (!healthResponse.ok) throw new Error('Embedding service is not healthy.');
  const embeddingHealth = await healthResponse.json() as { model: string; device: string; dtype: string; pending: number };
  const embedder = new ModelSearchEmbeddingProvider(384, { url: embeddingUrl, apiKey: '', model: embeddingHealth.model,
    supportsDimensions: false, queryPrefix: 'query: ', documentPrefix: 'passage: ', variant: `${embeddingHealth.device}-${embeddingHealth.dtype}` });
  const measuredEmbedder = new Proxy(embedder, { get(object, key) {
    const value = Reflect.get(object, key, object);
    if (typeof value !== 'function') return value;
    if (key !== 'embedQuery') return value.bind(object);
    return async (...args: any[]) => {
      const started = performance.now();
      try { return await value.apply(object, args); }
      finally { measurements.push({ request: context.getStore()?.id ?? 'setup', kind: 'provider', stage: 'embed', ms: performance.now() - started }); }
    };
  } });
  const store = new SeekDbIndexStore({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database,
    vectorDimension: 384, embeddingProvider: measuredEmbedder }, monitoredPool);
  const watched = new Set(['searchSearchDocumentsByViews', 'getModuleArtifacts', 'getProject', 'getSourcePreview']);
  const measuredStore = new Proxy(store, { get(object, key) {
    const value = Reflect.get(object, key, object);
    if (typeof value !== 'function') return value;
    if (!watched.has(String(key))) return value.bind(object);
    return async (...args: any[]) => {
      const started = performance.now();
      try { return await value.apply(object, args); }
      finally { measurements.push({ request: context.getStore()?.id ?? 'setup', kind: 'store', stage: String(key),
        repository: args[0]?.repositoryId, ms: performance.now() - started }); }
    };
  } });
  const histories = (await store.listRepositories()).filter(r => r.role === 'history' && r.activeRevision);
  if (!histories.length) throw new Error('No active historical repositories.');
  const selections = [
    { repositoryId: 'repo-dff00587-724f-41eb-9388-619c8638ba18', language: 'C#', modules: [
      'module-shared-contracts', 'module-domain-model', 'module-policies', 'module-application-services',
      'module-reconciliation', 'module-order-plugin-bridge'] },
    { repositoryId: 'repo-0de2a53d-4338-4c40-bc68-11c477c0e8c9', language: 'Java', modules: [
      'module-9cae2f2e54664b26c5b8aecb', 'module-ac029821f8c153ea5b02e9ee', 'module-23f4cf45df1ed3dbaaace4f8',
      'module-794efe71e0b60c91cf994b43', 'module-e55840bccc9e0bb7061d5bcf', 'module-d1f45ee36196c1e1c09431a6'] },
  ];
  const tasks: Array<{ language: string; module: string; moduleId: string; request: ModuleMatchRequest; fullQuery: string }> = [];
  for (const selection of selections) {
    const repository = await store.getRepository(selection.repositoryId);
    if (!repository?.activeRevision || repository.role !== 'target') throw new Error(`Target scope is unavailable: ${selection.repositoryId}`);
    const [rows]: any = await pool.query('SELECT payload FROM module_artifacts WHERE repository_id=? AND analysis_revision=? AND kind=? AND status=?',
      [repository.repositoryId, repository.activeRevision, 'module-summary', 'current']);
    const records: ProjectAnalysisRecord[] = rows.map((r: any) => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
    for (const id of selection.modules.slice(0, maxModules || undefined)) {
      if (selectedIds.length && !selectedIds.includes(id)) continue;
      const record = records.find(r => r.proposal?.modules.some(m => m.id === id));
      const module = record?.proposal?.modules.find(m => m.id === id);
      if (!record?.proposal || !module) throw new Error(`Selected module is missing in active target scope: ${id}`);
      const files = indexModuleHierarchy(record.proposal.modules).sourceFiles(id).files;
      if (!files.length) throw new Error(`Selected module has no source manifest: ${id}`);
      const project = await store.getProject({ repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision }, record.projectId);
      const requirement = [module.description, module.purpose, `目标语言：${selection.language}`, `目标工程：${project?.displayName ?? repository.displayName}`].filter(Boolean).join('\n');
      const target: ModuleTarget = { id, kind: 'module', name: module.name, language: selection.language as ModuleTarget['language'],
        path: files[0]!, signature: module.coreApis?.[0] ?? module.name,
        module: { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, projectId: record.projectId,
          moduleId: module.id, purpose: module.purpose, description: module.description,
          sourceFiles: files, coreApis: module.coreApis ?? [], dependsOn: module.dependsOn ?? [] } };
      const fullQuery = [target.name, target.signature, target.documentation, requirement, ...(target.module?.coreApis ?? [])].filter(Boolean).join('\n');
      tasks.push({ language: selection.language, module: module.name, moduleId: id, fullQuery,
        request: { target, requirement, topK: 1, repositoryIds: histories.map(r => r.repositoryId) } });
    }
  }
  if (selectedIds.some(id => !tasks.some(task => task.moduleId === id))) throw new Error('Unknown selected module ID.');
  if (process.argv.includes('--list')) { console.log(JSON.stringify(tasks, null, 2)); }
  else {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('RECAST DEEPSEEK_API_KEY is missing.');
    await mkdir(output, { recursive: true });
    metadata = { database, poolSize: 8, optimizedConcurrency: gate.limit, moduleBudgetMs: 60000, rerankBudgetMs: 25000,
      reranker: 'extension ConfiguredModelReranker -> adaptation /v1/retrieval-rerank -> rankRetrieval',
      model: deepSeekModelConfig.model, apiHost: new URL(deepSeekModelConfig.apiBase).host, embeddingHealth,
      originalPolicy: 'benchmark-only complete full-text query + no admission gate; all other code identical',
      histories: histories.map(r => ({ repositoryId: r.repositoryId, name: r.displayName, analysisRevision: r.activeRevision })),
      tasks, rounds, variants, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
    // Record only model identity, usage and duration. Never record credentials,
    // HTTP headers, prompts or historical source in the report.
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.host !== metadata.apiHost || !url.pathname.endsWith('/chat/completions')) return nativeFetch(input, init);
      const started = performance.now();
      const record: Record<string, unknown> = { request: context.getStore()?.id, requestedModel: deepSeekModelConfig.model, host: url.host };
      try {
        const response = await nativeFetch(input, init);
        record.status = response.status;
        const data: any = await response.clone().json().catch(() => ({}));
        record.responseModel = data.model; record.usage = data.usage;
        // Only retain a parsed ID array, never arbitrary model text or source.
        const content = data.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          try {
            const order: unknown = JSON.parse(content.slice(content.indexOf('['), content.lastIndexOf(']') + 1));
            if (Array.isArray(order) && order.every(id => typeof id === 'string' && /^c\d+$/.test(id))) record.returnedCandidateIds = order;
          } catch { record.candidateIdsParseable = false; }
        }
        return response;
      } catch (error) { record.error = error instanceof Error ? error.name : 'error'; throw error; }
      finally { record.ms = performance.now() - started; modelCalls.push(record); }
    };
    server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Translation is disabled in retrieval benchmarks.'); } },
      retrievalRerank: (input, signal) => context.run(activeQueries.get(input.requirement)!, async () => {
        try { return await rankRetrieval(input, signal); }
        catch (error) {
          backendFailures.push({ request: context.getStore()?.id, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }) });
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const configured = new ConfiguredModelReranker(() => `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, async () => {});
    const reranker = { model: configured.model, rank: async (query: string, documents: readonly string[], signal: AbortSignal) => {
      const own = context.getStore()!;
      activeQueries.set(query.slice(0, 8000), own);
      try { return await configured.rank(query, documents, signal); }
      finally { activeQueries.delete(query.slice(0, 8000)); }
    } };
    console.log(JSON.stringify({ output, database, model: metadata.model, apiHost: metadata.apiHost,
      embedding: embeddingHealth, histories: histories.length, modules: tasks.length, rounds, variants }));
    await persist();
    const execute = async (task: typeof tasks[number], variant: string, run: number, mode = 'serial'): Promise<void> => {
      const id = `${mode}-${variant}-${task.moduleId}-${run}`;
      const row: Record<string, any> = { id, variant, mode, run, language: task.language, module: task.module, moduleId: task.moduleId,
        queryHash: hash(task.fullQuery), startedAt: new Date().toISOString(), status: 'error' };
      try {
        const candidates = await context.run({ id, variant, fullQuery: task.fullQuery }, () => searchModules(measuredStore, task.request,
          undefined, reranker, undefined, timing => { row.timing = timing; }));
        row.status = candidates.length ? 'success' : 'empty';
        row.candidate = candidates[0] && { repository: candidates[0].repository, module: candidates[0].title,
          sourceModule: candidates[0].sourceModule };
      } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
      row.finishedAt = new Date().toISOString();
      const own = measurements.filter(m => m.request === id);
      row.sql = Object.fromEntries(['fulltext', 'vector', 'hydrate', 'preview', 'artifacts', 'project'].map(stage => {
        const samples = own.filter(m => m.kind === 'sql' && m.stage === stage);
        return [stage, { calls: samples.length, sumMs: samples.reduce((s, m) => s + m.ms, 0), maxMs: Math.max(0, ...samples.map(m => m.ms)),
          maxPoolWaitMs: Math.max(0, ...samples.map(m => m.waitMs ?? 0)) }];
      }));
      row.recallByRepository = own.filter(m => m.kind === 'store' && m.stage === 'searchSearchDocumentsByViews')
        .map(m => ({ repository: histories.find(r => r.repositoryId === m.repository)?.displayName, ms: m.ms }));
      row.modelCalls = modelCalls.filter(m => m.request === id);
      reports.push(row);
      console.log(JSON.stringify({ ...row, candidate: row.candidate && { repository: row.candidate.repository, module: row.candidate.module } }));
      if (mode === 'serial') await persist();
    };
    // Alternating order reduces systematic cache/order bias. Failed requests are
    // kept in reports, not retried or silently excluded.
    for (let run = 1; run <= rounds; run++) {
      for (const [index, task] of tasks.entries()) {
        const order = (index + run) % 2 ? [...variants].reverse() : variants;
        for (const variant of order) await execute(task, variant, run);
      }
    }
    if (process.argv.includes('--concurrent')) {
      const batchTasks = tasks.filter(t => t.language === 'Java').slice(0, 4);
      for (const variant of variants) {
        const started = performance.now(); const offset = reports.length;
        await Promise.all(batchTasks.map(task => execute(task, variant, 1, 'concurrent-4')));
        const batch = reports.slice(offset);
        batches.push({ variant, wallMs: performance.now() - started, requests: batch.length,
          eventualSuccess: batch.filter(r => r.status === 'success').length,
          successWithin60Seconds: batch.filter(r => r.status === 'success' && r.timing.totalMs <= 60000).length });
        await persist();
      }
    }
    console.log(JSON.stringify({ finished: true, output, requests: reports.length, successful: reports.filter(r => r.status === 'success').length }));
  }
} finally {
  globalThis.fetch = nativeFetch;
  gate.acquire = acquire;
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
  await pool.end();
}
