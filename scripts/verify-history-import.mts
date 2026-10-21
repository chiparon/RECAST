/** Real, durable acceptance: keep the imported repositories and model artifacts. */
import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPlatformWorkspace } from './check-platform-workspace.mjs';
import { CodeIntelligenceHost, codeIntelligenceRuntimeOptionsFromEnvironment } from '../apps/vscode-extension/src/code-intelligence-host';
import { createCodeIntelligenceRuntime } from '../services/code-intelligence-service/src/index';
import { platformLocalPath } from '../services/code-intelligence-service/src/platform-path';
import { HttpModuleHierarchyPlanner } from '../apps/vscode-extension/src/module-hierarchy-client';
import { localFetch, setModelCredentialProvider } from '../apps/vscode-extension/src/local-fetch';
import { requestSemanticModuleMigrationProposal } from '../apps/vscode-extension/src/module-plan-client';
import { DEFAULT_LLM_SETTINGS, parseLlmSettings } from '../packages/contracts/src';

checkPlatformWorkspace(process.cwd());
const names = ['apache-camel', 'apscheduler', 'bullmq', 'commons-fileupload', 'flowable-engine', 'keycloak', 'nopcommerce'];
const output = path.resolve('output/history-import-validation');
await mkdir(output, { recursive: true });
const launch = JSON.parse(await readFile('output/recast-startup/current-launch.json', 'utf8'));
const environment = { ...launch.environment, ...process.env };
const reportOnly = process.argv.includes('--report-only');
const backend = process.env.HISTORY_IMPORT_BACKEND_URL;
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!reportOnly && (!backend || !apiKey)) throw new Error('Set HISTORY_IMPORT_BACKEND_URL and DEEPSEEK_API_KEY in the process environment.');
const model = parseLlmSettings({ ...DEFAULT_LLM_SETTINGS,
  model: process.env.DEEPSEEK_MODEL || DEFAULT_LLM_SETTINGS.model,
  apiBase: process.env.DEEPSEEK_API_BASE || DEFAULT_LLM_SETTINGS.apiBase });
if (backend && apiKey) setModelCredentialProvider(async url => url.origin === new URL(backend).origin ? { apiKey, settings: model } : undefined);
const runtimeOptions = codeIntelligenceRuntimeOptionsFromEnvironment(environment, { allowInMemory: false });
const runtime = await createCodeIntelligenceRuntime(runtimeOptions);
const registered = await runtime.registry.list();
const repositories = names.map(name => {
  const matches = registered.filter(repository => repository.role === 'history' && repository.displayName === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one registered history repository named ${name}; found ${matches.length}.`);
  return { repositoryId: matches[0]!.repositoryId, localPath: platformLocalPath(matches[0]!.localPath), role: 'history' as const };
});
const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, runtimeOptions,
  ...(!reportOnly && backend ? {
    hierarchyPlanner: new HttpModuleHierarchyPlanner(backend, localFetch),
    planProject: (scope: Parameters<typeof requestSemanticModuleMigrationProposal>[1]) => requestSemanticModuleMigrationProposal(backend, scope, undefined, AbortSignal.timeout(300_000)),
  } : {}),
  onChange: () => { reportRequested = true; },
  modelKeyRefusal: async () => undefined,
  output: { appendLine: line => { if (/failure|failed|index repository|indexing history/.test(line)) console.log(line); } },
});
let reportRequested = true;
let lastSummary = '';
let reporting = false;
async function report() {
  if (reporting) return;
  reporting = true;
  try {
    reportRequested = false;
    const view = await host.presentation();
    const repositories = view.repositories.map(repository => ({ name: repository.displayName, repositoryId: repository.repositoryId,
      analysisRevision: repository.activeRevision, index: repository.analysisStatus, indexing: repository.indexing,
      projects: repository.projects.length,
      modeled: repository.projects.filter(project => project.analysis?.state === 'ready' && project.analysis.projection === 'ready' && !project.analysis.modelingSkippedReason).length,
      skipped: repository.projects.filter(project => project.analysis?.state === 'ready' && project.analysis.projection === 'ready' && project.analysis.modelingSkippedReason).length,
      failed: repository.projects.filter(project => project.analysis?.state === 'failed' || project.analysis?.projection === 'failed').map(project => ({
        name: project.displayName, projectId: project.projectId, path: project.relativePath, error: project.analysis?.error })),
      details: repository.projects.map(project => ({ projectId: project.projectId, name: project.displayName, path: project.relativePath,
        state: project.analysis?.state, projection: project.analysis?.projection, modeling: project.analysis?.modeling,
        modelingSkippedReason: project.analysis?.modelingSkippedReason,
        modules: project.analysis?.hierarchy?.moduleCount, hierarchy: project.analysis?.hierarchy,
        coverage: project.analysis?.coverage, summary: project.analysis?.proposal?.summary, error: project.analysis?.error })),
    }));
    const passed = view.status === 'ready' && view.runtimeStatus === 'ready' &&
      repositories.length === names.length && new Set(repositories.map(repository => repository.repositoryId)).size === names.length &&
      repositories.every(repository => ['ready', 'degraded'].includes(repository.index) && repository.analysisRevision &&
        repository.projects > 0 && repository.modeled + repository.skipped === repository.projects);
    const result = { at: new Date().toISOString(), database: environment.CODE_INTELLIGENCE_SEEKDB_DATABASE,
      status: view.status, runtimeStatus: view.runtimeStatus, message: view.message, passed, repositories };
    await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
    const summary = JSON.stringify(repositories.map(({ name, index, projects, modeled, skipped, failed }) => ({ name, index, projects, modeled, skipped, failed })));
    if (summary !== lastSummary) { console.log('[history-import]', summary); lastSummary = summary; }
    return result;
  } finally { reporting = false; }
}
const timer = setInterval(() => { if (reportRequested) void report().catch(error => console.error(error.message)); }, 15_000);
let lastProgressAt = 0;
let lastStage = '';
const onProgress = (progress: import('../apps/vscode-extension/src/indexing-progress').RepositoryIndexingProgress) => {
      reportRequested = true;
      const stage = `${progress.repositoryId}:${progress.stage}`;
      if (stage !== lastStage || Date.now() - lastProgressAt > 10_000 || progress.total !== undefined && progress.completed === progress.total) {
        console.log('[history-index]', JSON.stringify(progress)); lastProgressAt = Date.now(); lastStage = stage;
      }
};
try {
  await host.synchronize({ repositories, scan: false });
  if (!reportOnly) {
    await host.synchronize({ repositories, scanNewOnly: true, onProgress });
    for (let retry = 0; retry < 2; retry++) {
      const view = await host.presentation();
      if (!view.repositories.some(repository => repository.analysisStatus === 'failed' || !repository.activeRevision)) break;
      await host.synchronize({ repositories, scanNewOnly: true, onProgress });
    }
    await host.waitForProjects();
    for (let retry = 0; retry < 2; retry++) {
      const view = await host.presentation();
      let retries = 0;
      for (const repository of view.repositories) for (const project of repository.projects) {
        if (repository.activeRevision && (project.analysis?.state === 'failed' || project.analysis?.projection === 'failed')) {
          await host.retryProject({ repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, projectId: project.projectId }); retries++;
        }
      }
      if (!retries) break;
      await host.waitForProjects();
    }
  }
  while (reporting) await new Promise(resolve => setTimeout(resolve, 50));
  const result = await report();
  if (!result?.passed) process.exitCode = 1;
  console.log(`History import acceptance: ${result?.passed ? 'PASSED' : 'FAILED'}; report: ${path.join(output, 'report.json')}`);
} finally {
  clearInterval(timer);
  host.dispose();
  await (runtime.store as unknown as { close(): Promise<void> }).close();
}
