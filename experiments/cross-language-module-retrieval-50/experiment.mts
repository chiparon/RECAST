/** Host-only preparation and evaluation; all search/model behavior comes from production code. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { parse } from 'dotenv';
import { indexModuleHierarchy, type ModuleTarget, type ProjectAnalysisRecord, type SearchCandidate } from '@forexplore/contracts';
import { CodeIntelligenceHost } from '../../apps/vscode-extension/src/code-intelligence-host.js';
import { HttpModuleHierarchyPlanner } from '../../apps/vscode-extension/src/module-hierarchy-client.js';
import { ConfiguredModelReranker } from '../../apps/vscode-extension/src/model-reranker.js';
import { createCodeIntelligenceRuntime } from '../../services/code-intelligence-service/src/index.js';
import { SeekDbIndexStore } from '../../services/code-intelligence-service/src/seekdb-index-store.js';
import { searchModules, type ModuleRecallObservation, type ModuleSearchTiming } from '../../services/code-intelligence-service/src/module-matching.js';
import { projectPlanHash } from '../../services/code-intelligence-service/src/project-analysis.js';
import { resolveModuleRetrievalTarget } from '../../services/code-intelligence-service/src/module-search-query.js';
import { ModelModuleHierarchyPlanner } from '../../services/code-intelligence-service/src/module-hierarchy-planner.js';
import { scoreCase, summarize } from './scoring.js';
import { boundaryPolicy, fixedBoundaryPlanner } from './fixed-boundary.js';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, '../..');
execFileSync(process.execPath, ['scripts/check-platform-workspace.mjs'], { cwd: repoRoot, stdio: 'inherit' });
const mode = process.argv[2] ?? 'audit';
assert(['audit', 'prepare', 'preflight', 'run'].includes(mode), 'Use audit|prepare|preflight|run [--cases case-001,...] [--rounds 1]');
const option = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const allowedOptions = new Set(['--cases', '--rounds']);
for (let i = 3; i < process.argv.length; i += 2) assert(allowedOptions.has(process.argv[i]!) && process.argv[i + 1], 'Unknown or incomplete option');
const requestedIds = option('cases').split(',').filter(Boolean);
const rounds = Number(option('rounds', '1'));
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const database = 'forexplore_asset_upgrade_20261004';
const envPath = resolve(repoRoot, 'services/adaptation-service/.env');
if (existsSync(envPath)) for (const [key, value] of Object.entries(parse(readFileSync(envPath)))) process.env[key] ??= value;
// This environment is process-local; never configure Codex personal profiles.
const { createHttpServer } = await import('../../services/adaptation-service/src/http-server.js');
const { completeWithDeepSeek } = await import('../../services/adaptation-service/src/deepseek-client.js');
const { deepSeekModelConfig } = await import('../../services/adaptation-service/src/model-config.js');
assert(/^deepseek/i.test(deepSeekModelConfig.model), 'Experiment requires an explicitly configured DeepSeek model');
const embedding = { url: 'http://127.0.0.1:4021/v1/embeddings', apiKey: '',
  model: 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  supportsDimensions: false, queryPrefix: 'query: ', documentPrefix: 'passage: ', variant: 'cuda-fp16' };
const queries: any[] = JSON.parse(readFileSync(resolve(root, 'queries.json'), 'utf8')).cases;
const answers = JSON.parse(readFileSync(resolve(root, 'oracle/answers.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(resolve(root, 'oracle/catalog-snapshot.json'), 'utf8')).modules;
const selected = queries.filter(q => !requestedIds.length || requestedIds.includes(q.caseId));
assert(selected.length && requestedIds.every(id => queries.some(q => q.caseId === id)), 'Unknown case selection');
const out = resolve(root, 'results');
await mkdir(out, { recursive: true });
const write = async (name: string, data: unknown) => writeFile(resolve(out, name), JSON.stringify(data, null, 2) + '\n');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = (q: any) => hash(JSON.stringify(q) + ['README.md', ...q.writeFiles,
  ...['pyproject.toml', 'ParallelModule.csproj', 'pom.xml', 'package.json', 'tsconfig.json', 'go.mod'].filter(f => existsSync(resolve(root, q.targetPath, f)))
].sort().map(f => f + '\0' + hash(readFileSync(resolve(root, q.targetPath, f)))).join('\n'));
const provenance = { database, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  sourceDiffHash: hash(execFileSync('git', ['diff', '--', 'services/code-intelligence-service', 'services/adaptation-service', 'apps/vscode-extension'], { cwd: repoRoot })),
  queriesHash: hash(readFileSync(resolve(root, 'queries.json'))), oracleHash: hash(readFileSync(resolve(root, 'oracle/answers.json'))),
  model: deepSeekModelConfig.model, apiHost: new URL(deepSeekModelConfig.apiBase).host, moduleRecallMode: process.env.CODE_INTELLIGENCE_MODULE_RECALL_MODE ?? 'three-view', embedding, topK: 4,
  sourceMode: 'WSL production implementations, including current uncommitted changes',
  driverHash: hash(readFileSync(fileURLToPath(import.meta.url))), scoringHash: hash(readFileSync(resolve(root, 'scoring.ts'))), candidateLimit: 'production default (currently up to 16 for Top4)',
  boundaryPolicy, boundaryImplementationHash: hash(readFileSync(resolve(root, 'fixed-boundary.ts'))), seed: answers.seed, createdAt: new Date().toISOString() };
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 4 });
const store = new SeekDbIndexStore({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, vectorDimension: 384, embedding }, pool);
const excludedHistoryRepositories = new Set(['flowable-engine']);
const histories = [...new Map(catalog.filter((c: any) => !excludedHistoryRepositories.has(c.repository)).map((c: any) => [c.repositoryId, { repositoryId: c.repositoryId, revision: c.revision, name: c.repository }])).values()] as any[];
async function audit() {
  const health: any = await (await fetch('http://127.0.0.1:4021/health', { signal: AbortSignal.timeout(5000) })).json();
  assert(health.ready && health.model === embedding.model && `${health.device}-${health.dtype}` === embedding.variant, 'Embedding deployment changed');
  const [config]: any = await pool.query('SELECT config_hash FROM search_embedding_configuration WHERE slot=1');
  assert.equal(config[0]?.config_hash, store.embeddingIdentity, 'Stored embedding identity mismatch');
  const issues: string[] = [];
  let indexedSourceHashes = 0, nodeCount = 0;
  const counts = [];
  for (const history of histories) {
    const row = await store.getRepository(history.repositoryId);
    assert(row?.role === 'history' && row.activeRevision === history.revision, 'History revision changed: ' + history.name);
    const [artifacts]: any = await pool.query("SELECT module_artifact_id,plan_hash,analysis_hash,payload FROM module_artifacts WHERE repository_id=? AND analysis_revision=? AND kind='module-summary' AND status='current'", [history.repositoryId, history.revision]);
    const records = artifacts.map((a: any) => ({ id: a.module_artifact_id, planHash: a.plan_hash, analysisHash: a.analysis_hash, payload: typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload }));
    const count = records.reduce((sum: number, a: any) => sum + (a.payload.state === 'ready' ? a.payload.proposal.modules.length : 0), 0);
    const revision = await store.getRevision({ repositoryId: history.repositoryId, analysisRevision: history.revision });
    assert(revision?.status === 'ready', 'Historical structural revision is not ready');
    for (const record of records) if (record.payload.state === 'ready' && (record.planHash !== projectPlanHash(record.payload.proposal) || record.analysisHash !== revision.analysisHash)) issues.push(history.name + ': invalid published plan hash or structural revision binding');
    const [documents]: any = await pool.query("SELECT module_artifact_id,document_text FROM search_documents WHERE repository_id=? AND analysis_revision=? AND kind='summary'", [history.repositoryId, history.revision]);
    const views = documents.map((d: any) => ({ artifactId: d.module_artifact_id, value: JSON.parse(d.document_text) }));
    for (const answer of answers.cases.filter((a: any) => a.gold.repositoryId === history.repositoryId)) {
      if (views.filter((d: any) => d.artifactId === answer.gold.artifactId && d.value.moduleId === answer.gold.moduleId).length < 3) issues.push(answer.caseId + ': historical module views missing');
    }
    nodeCount += count;
    counts.push({ name: history.name, nodes: count });
    const [files]: any = await pool.query('SELECT relative_path,sha256 FROM files WHERE repository_id=? AND analysis_revision=?', [history.repositoryId, history.revision]);
    const byPath = new Map(files.map((f: any) => [f.relative_path, f.sha256]));
    for (const answer of answers.cases.filter((a: any) => a.gold.repositoryId === history.repositoryId)) {
      const artifact = records.find((a: any) => a.id === answer.gold.artifactId);
      if (!artifact || artifact.payload.state !== 'ready' || artifact.payload.planHash !== answer.gold.planHash ||
          artifact.payload.proposal.analysisHash !== answer.gold.analysisHash || !artifact.payload.proposal.modules.some((m: any) => m.id === answer.gold.moduleId)) issues.push(answer.caseId + ': gold artifact changed');
      for (const file of answer.productionSourceHashes) {
        indexedSourceHashes++;
        if (byPath.get(file.path) !== file.sha256) issues.push(answer.caseId + ': source/index mismatch: ' + file.path);
      }
    }
  }
  const report = { ...provenance, historyCount: histories.length, nodeCount, counts, indexedSourceHashes, issues, ok: !issues.length && nodeCount === catalog.filter((c: any) => !excludedHistoryRepositories.has(c.repository)).length };
  await write('history-audit.json', report);
  assert(report.ok, `${issues.length} source/artifact mismatches (see results/history-audit.json), or history population changed`);
  return report;
}
function candidate(c: SearchCandidate) { return { id: c.id, title: c.title, score: c.score, sourceModule: c.sourceModule }; }
let server: ReturnType<typeof createHttpServer> | undefined;
let host: CodeIntelligenceHost | undefined;
let runtime: Awaited<ReturnType<typeof createCodeIntelligenceRuntime>> | undefined;
const preparedPath = resolve(out, 'prepared.json');
const prepared: any = existsSync(preparedPath) ? JSON.parse(readFileSync(preparedPath, 'utf8')) : { cases: {} };
prepared.provenance = provenance;
async function validatePrepared(q: any) {
  const p = prepared.cases[q.caseId];
  assert(p?.status === 'ready', `${q.caseId}: preparation missing`);
  assert.equal(p.fingerprint, fingerprint(q), `${q.caseId}: target changed`);
  assert.equal((await store.getRepository(p.repositoryId))?.activeRevision, p.analysisRevision, `${q.caseId}: revision changed`);
  const artifacts = await store.listModuleArtifacts({ repositoryId: p.repositoryId, analysisRevision: p.analysisRevision });
  const record = artifacts.map(a => a.payload as ProjectAnalysisRecord).find(r => r?.state === 'ready' && r.projectId === p.projectId);
  assert(record?.proposal && record.projection === 'ready' && record.planHash === p.planHash && projectPlanHash(record.proposal) === p.planHash, `${q.caseId}: published target plan changed`);
  assert.equal(p.boundaryPolicy, boundaryPolicy, `${q.caseId}: fixed-boundary preparation required`);
  assert.equal(record.proposal.modules.length, 1, `${q.caseId}: target must have exactly one module`);
  const module = record.proposal.modules[0]!;
  assert.equal(module.id, p.target.id, `${q.caseId}: selected module removed`);
  assert(q.writeFiles.every((f: string) => module.sourceFiles.includes(f)), `${q.caseId}: incomplete skeleton coverage`);
  assert.deepEqual([...p.target.module.sourceFiles].sort(), [...module.sourceFiles].sort(), `${q.caseId}: query file scope differs from published module`);
  assert.equal(p.selectedSourceCoverage, 1, `${q.caseId}: incomplete query coverage`);
  const resolved = await resolveModuleRetrievalTarget(store, p.target);
  assert(resolved !== p.target && resolved.module?.moduleId === p.target.id, `${q.caseId}: production target resolution did not validate the model`);
  return p;
}
try {
  await audit();
  if (mode !== 'audit') {
    assert(process.env.DEEPSEEK_API_KEY?.trim(), 'Experiment DeepSeek key is not configured');
    server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Translation is outside this experiment'); } },
      moduleHierarchyPlanner: new ModelModuleHierarchyPlanner({ timeoutMs: 45000, maxRepairs: 1,
        complete: (messages, signal) => completeWithDeepSeek(messages, { apiKey: () => process.env.DEEPSEEK_API_KEY!, temperature: 0, jsonMode: true }, signal) }) });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const reranker = new ConfiguredModelReranker(() => endpoint, async () => undefined, undefined, () => `${deepSeekModelConfig.apiBase}:${deepSeekModelConfig.model}`);
    if (mode === 'prepare') {
      await write('readiness.json', { ...provenance, ready: false, reason: 'Preparation in progress; run preflight after completion', retrievalExperimentExecuted: false });
      runtime = await createCodeIntelligenceRuntime({ store, initialize: false, projectAnalysis: { hierarchyPlanner: fixedBoundaryPlanner(new HttpModuleHierarchyPlanner(endpoint)) } });
      host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime!, modelKeyRefusal: async () => process.env.DEEPSEEK_API_KEY?.trim() ? undefined : 'Missing key',
        output: { appendLine: line => { if (/failed|error|performance/i.test(line)) console.log(line); } } });
      for (const q of selected) {
        try {
          try { await validatePrepared(q); console.log(q.caseId, 'reused ready model'); continue; } catch {}
          const started = performance.now();
          console.log(q.caseId, q.language, 'indexing and modeling');
          const result = await host.synchronize({ repositories: [{ localPath: resolve(root, q.targetPath), role: 'target' }], scan: true });
          assert.equal(result.failedRepositoryIds.length, 0, 'Structural indexing failed');
          const scope = await host.activeScopeForPath(resolve(root, q.targetPath));
          const index = await store.getStructuralIndex(scope);
          assert(index && q.writeFiles.every((f: string) => index.files.some(x => x.relativePath === f && !['error', 'unsupported'].includes(x.parseStatus))), 'Missing/unparsed target source');
          const project = [...index.projects].sort((a, b) => index.files.filter(f => f.projectId === b.projectId).length - index.files.filter(f => f.projectId === a.projectId).length)[0];
          assert(project, 'No detected project');
          const projectScope = { ...scope, projectId: project.projectId };
          const previous = await runtime.projectAnalysis.read(projectScope);
          const previousModules = previous.proposal?.modules ?? [];
          // Reuse already complete single-node descriptions; regenerate all split trees,
          // including trees whose parent happened to cover the complete source scope.
          await runtime.projectAnalysis.ensure(projectScope, previous.state === 'ready' &&
            (previousModules.length !== 1 || !q.writeFiles.every((f: string) => previousModules[0]!.sourceFiles.includes(f))));
          const record: ProjectAnalysisRecord = await runtime.projectAnalysis.read(projectScope);
          assert(record.state === 'ready' && record.proposal && record.projection === 'ready', record.error ?? 'Project model not queryable');
          assert.equal(record.proposal.modules.length, 1, 'Fixed evaluation boundary was not preserved');
          const m = record.proposal.modules[0]!;
          const files = indexModuleHierarchy(record.proposal.modules).sourceFiles(m.id).files;
          assert(q.writeFiles.every((f: string) => files.includes(f)), 'Published module does not cover the complete skeleton');
          const target: ModuleTarget = { id: m.id, kind: 'module', name: m.name, language: q.language,
            path: files[0]!, signature: m.coreApis?.[0] ?? m.name,
            module: { ...scope, projectId: project.projectId, moduleId: m.id, purpose: m.purpose, description: m.description,
              sourceFiles: files, coreApis: m.coreApis ?? [], dependsOn: m.dependsOn } };
          prepared.cases[q.caseId] = { status: 'ready', ...projectScope, planHash: record.planHash,
            fingerprint: fingerprint(q), target, requirement: q.requirement, moduleCount: record.proposal.modules.length,
            boundaryPolicy, selectionRule: 'Exactly one published module covering all skeleton source files; gold-independent',
            selectedSourceCoverage: 1, modelingMs: performance.now() - started };
          console.log(q.caseId, 'READY', m.name, 'modules=' + record.proposal.modules.length);
        } catch (error) {
          prepared.cases[q.caseId] = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
          console.error(q.caseId, prepared.cases[q.caseId].error);
        }
        await write('prepared.json', prepared);
      }
      await write('prepared.json', prepared);
      assert(selected.every(q => prepared.cases[q.caseId]?.status === 'ready'), 'Some preparations failed; rerun prepare to resume');
    } else if (mode === 'preflight') {
      for (const q of selected) await validatePrepared(q);
      const started = performance.now();
      const result = await reranker.rank('Find a module that parses an HTTP multipart upload stream.', ['HTTP upload parser\nReads multipart request streams.', 'Theme editor\nEdits user interface colors.'], AbortSignal.timeout(25000));
      assert.equal(result.length, 2);
      assert.equal(result[0]?.index, 0, 'Synthetic reranker smoke test failed');
      await write('readiness.json', { ...provenance, ready: true, caseCount: selected.length,
        targetModuleNodes: selected.reduce((n, q) => n + prepared.cases[q.caseId].moduleCount, 0),
        selectedQueries: selected.length, splitTargetCases: [], completeSourceCoverage: true, modelSmokeMs: performance.now() - started,
        preparedHash: hash(readFileSync(preparedPath)), rankingSmoke: result, retrievalExperimentExecuted: false });
    } else if (mode === 'run') {
      for (const q of selected) await validatePrepared(q);
      const runId = new Date().toISOString().replace(/[:.]/g, '-');
      const reports: any[] = [];
      for (let round = 1; round <= rounds; round++) for (const q of selected) {
        const p = await validatePrepared(q);
        let before: readonly SearchCandidate[] = [], recallObservation: readonly ModuleRecallObservation[] = [], timing: Readonly<ModuleSearchTiming> | undefined;
        const started = performance.now();
        let row: any;
        try {
          const after = await searchModules(store, { target: p.target, requirement: q.requirement, topK: 4, repositoryIds: histories.map(h => h.repositoryId) },
            undefined, reranker, undefined, t => { timing = t; }, c => { before = c; }, c => { recallObservation = c; });
          // Oracle scoring only after the production search completes.
          const gold = answers.cases.find((a: any) => a.caseId === q.caseId);
          row = { caseId: q.caseId, language: q.language, round, status: timing?.rerankFallback ? 'rerank-fallback' : 'success',
            before: before.map(candidate), after: after.map(candidate), timing, wallMs: performance.now() - started,
            metrics: scoreCase(gold, before.map(candidate), after.map(candidate)),
            recallDiagnostics: (() => { const exact = recallObservation.find(hit => hit.repositoryId === gold.gold.repositoryId && hit.projectId === gold.gold.projectId && hit.moduleId === gold.gold.moduleId); return { exactGoldRecalledBeforeShortlist: Boolean(exact), exactGoldChannels: exact?.channels ?? [], exactGoldScore: exact?.score ?? null,
              exactGoldChannelRanks: exact?.channelRanks ?? {}, exactGoldChannelScores: exact?.channelScores ?? {}, recalledModuleCountBeforeShortlist: recallObservation.length,
              recallChannelNames: [...new Set(recallObservation.flatMap(hit => hit.channels))].sort(),
              channelModuleCounts: Object.fromEntries([...new Set(recallObservation.flatMap(hit => hit.channels))].sort().map(channel => [channel, recallObservation.filter(hit => hit.channels.includes(channel)).length])) }; })() };
        } catch (error) { row = { caseId: q.caseId, language: q.language, round, status: 'error', timing, wallMs: performance.now() - started, error: String(error) }; }
        reports.push(row);
        await write(`run-${runId}.json`, { ...provenance, histories, rounds, reports, summary: summarize(reports, selected.length * rounds) });
        console.log(q.caseId, round, row.status, Math.round(row.wallMs) + 'ms');
      }
    }
  }
} finally {
  await host?.waitForProjects();
  host?.dispose();
  await runtime?.close();
  if (server) await new Promise<void>((resolveClose, reject) => { server!.close(error => error ? reject(error) : resolveClose()); server!.closeIdleConnections(); });
  await store.close();
}
