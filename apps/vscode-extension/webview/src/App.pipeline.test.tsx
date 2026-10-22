/// <reference types="node" />
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator, projectPlanHash } from '@forexplore/code-intelligence-service';
import type { ProjectAnalysisScope, ModuleTarget, SearchCandidate, WorkspaceTranslationRun } from '@forexplore/contracts';
import { CodeIntelligenceHost } from '../../src/code-intelligence-host';
import { buildProjectExplorer, readExplorerChildren, type ExplorerChildrenIndex } from '../../src/project-explorer';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import { isWebviewToHostMessage } from '../../src/protocol/messages';
import App from './App';
import type { ModuleExplorerPresentation } from '../../src/ui-types';

let reactRoot: Root | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot!.unmount());
  document.body.innerHTML = '';
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('automatically selects a module reference, prepares and starts generation, then supports rollback', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const target: ModuleTarget = { id: 'target-module', name: 'Limit module', kind: 'module', language: 'TypeScript', path: 'target.ts', signature: '',
    module: { sourceFiles: ['target.ts', 'policy.ts'], coreApis: ['limit'], dependsOn: [] } };
  const candidate: SearchCandidate = { id: 'history-module', title: 'Java limit module', kind: 'module', language: 'Java', repository: 'History', path: 'Limit.java',
    signature: 'limit(int)', summary: 'Boundary policy', preview: 'class Limit {}', license: 'MIT', dependencies: [], compatibility: [], risks: [],
    score: { overall: 0.9, semantic: 0.9, symbol: 1, contract: 1 },
    sourceModule: { repositoryId: 'history', analysisRevision: 'r1', projectId: 'history-project', projectPath: '', moduleId: 'limit', name: 'Limit', sourceFiles: ['Limit.java'], coreApis: ['limit'] } };
  const complementary: SearchCandidate = { ...candidate, id: 'history-retry', title: 'Java retry module',
    sourceModule: { ...candidate.sourceModule!, moduleId: 'retry', name: 'Retry', sourceFiles: ['Retry.java'] } };
  const explorer: ModuleExplorerPresentation = { generatedAt: '', history: [], target: {
    id: 'target', repositoryId: 'target', projectId: 'project', revision: 'revision', mode: 'target', name: 'Target', rootLabel: '.', tree: [],
    stats: { modules: 1, files: 2, types: 0, methods: 0, implemented: 0, unimplemented: 1, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' },
  } };
  const scopeId = 'a'.repeat(64);
  const run: WorkspaceTranslationRun = { id: '11111111-2222-3333-4444-555555555555', workspaceRoot: '/target', status: 'completed', acceptance: 'behavior-verified',
    request: { spec: 'Limit', sourceLanguage: 'Java', targetLanguage: 'TypeScript', context: [], workspaceFiles: ['target.ts', 'policy.ts'], writeFiles: ['target.ts', 'policy.ts'] },
    createdAt: '', updatedAt: '', completedSteps: [], changes: ['target.ts', 'policy.ts'].map(file => ({ path: file, before: '// original', after: '// translated', applied: true })),
    compilations: [], modelTurns: 8, events: [{ at: new Date().toISOString(), phase: 'translating', message: '目标代码生成完成' }] };
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const sent: WebviewToHostMessage[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: (raw) => {
    const message = raw as WebviewToHostMessage; sent.push(message);
    expect(isWebviewToHostMessage(message)).toBe(true);
    if (message.type === 'START_SEARCH') post({ type: 'SEARCH_RESULT', candidates: [candidate, complementary] });
    if (message.type === 'START_ADAPT') post({ type: 'MODULE_TRANSLATION_READY', targetId: target.id, candidateId: candidate.id, candidateIds: [candidate.id], moduleScopeId: scopeId });
    if (message.type === 'WORKSPACE_TRANSLATION') post({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: message.requestId,
      ...(message.action === 'describe' ? { profile: { profileId: 'profile', moduleScopeId: scopeId, workspaceRoot: '/target', sourceLanguage: 'Java', targetLanguage: 'TypeScript',
        workspaceFiles: ['target.ts', 'policy.ts'], writeFiles: ['target.ts', 'policy.ts'], behavioralVerification: true } }
        : { run: message.action === 'rollback' ? { ...run, status: 'rolled-back' } : run }) });
  } });
  const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  await act(async () => post({ type: 'INIT', payload: { target, workspaceRoot: '/target',
    settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [], moduleExplorer: explorer,
    codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { moduleSearch: 'connected', adaptation: 'connected', executionMode: 'real' }, searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' } }));
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
  await act(async () => button('单模块调试').click());
  expect(container.querySelector('.workspace-translation')).toBeNull();
  expect(button('开始执行').disabled).toBe(true);
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('#pipeline-requirement')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '实现限额策略并验证边界条件');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('开始执行').click());
  expect(sent).toContainEqual({ type: 'START_SEARCH', requirement: '实现限额策略并验证边界条件', topK: 4 });
  expect(sent).toContainEqual({ type: 'SELECT_CANDIDATES', candidateIds: [candidate.id] });
  expect(sent).toContainEqual(expect.objectContaining({ type: 'WORKSPACE_TRANSLATION', action: 'describe', moduleScopeId: scopeId }));
  expect(container.textContent).toContain('target.ts、policy.ts');
  expect(sent).toContainEqual(expect.objectContaining({ type: 'WORKSPACE_TRANSLATION', action: 'start', profileId: 'profile', moduleScopeId: scopeId }));
  expect(container.textContent).toContain('行为测试通过');
  expect(container.textContent).toContain('// translated');
  expect(container.querySelector('[role="log"]')!.textContent).toContain('目标代码生成完成');
  expect(sent.filter(item => item.type === 'WORKSPACE_TRANSLATION' && item.action === 'start')).toHaveLength(1);
  await act(async () => button('回滚本次修改').click());
  expect(sent).toContainEqual(expect.objectContaining({ type: 'WORKSPACE_TRANSLATION', action: 'rollback', runId: run.id }));
  expect(container.textContent).toContain('已回滚');
  await act(async () => post({ type: 'TARGET_SELECTED', target }));
  expect(container.querySelector('.workspace-translation')).toBeNull();
  expect(button('重新开始')).toBeDefined();
  await act(async () => post({ type: 'TARGET_CLEARED' }));
  expect(container.querySelector('.workspace-translation')).toBeNull();
});

it('opens without a method, saves two history paths, displays durable summaries and switches project scope', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  directory = await mkdtemp(path.join(tmpdir(), 'forexplore-webview-pipeline-'));
  const paths = ['history-a', 'history-b', 'target'].map((name) => path.join(directory!, name));
  for (const root of paths) {
    await mkdir(root);
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
    await writeFile(path.join(root, 'index.ts'), 'export function run() { return 1; }');
    // A conflicting legacy export must have no influence on the module tree.
    await mkdir(path.join(root, '.forexplore'));
    await writeFile(path.join(root, '.forexplore/module-summary.json'), '{"name":"WRONG DISK SUMMARY"}');
  }
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const plan = vi.fn(async (scope: ProjectAnalysisScope & { objective: string }) => {
    const index = (await runtime.store.getStructuralIndex(scope))!;
    const repository = (await runtime.registry.get(scope.repositoryId))!;
    const proposal = {
      repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, analysisHash: index.analysisHash,
      objective: scope.objective, summary: `Stored summary: ${repository.displayName}`, unassignedFiles: [],
      modules: [{ id: 'core', kind: 'feature', name: `Agent module ${repository.displayName}`, description: 'Core behavior',
        sourceFiles: index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath),
        symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] }],
    };
    return { proposal, evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
  });
  const jobs = new ProjectAnalysisCoordinator({ store: runtime.store, plan });
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, planProject: plan, projectAnalysisPort: jobs });
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  let historyPaths: string[] = [];
  let moduleChildren: ExplorerChildrenIndex = new Map();
  const explorerPresentation = async () => {
    const explorer = await buildProjectExplorer(host);
    moduleChildren = explorer.childrenByNodeId;
    return explorer.presentation;
  };
  const assertLightweightProjectAnalysis = async () => {
    const presentation = await host.presentation();
    const analysis = presentation.repositories[0]?.projects[0]?.analysis;
    expect(analysis?.proposal?.summary).toContain('Stored summary:');
    expect(analysis?.proposal).not.toHaveProperty('modules');
    expect(analysis?.projection).toBe('ready');
  };
  const inputs = () => [...historyPaths.map((localPath) => ({ localPath, role: 'history' as const })), { localPath: paths[2]!, role: 'target' as const }];
  const emit = async () => {
    post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
    post({ type: 'MODULE_EXPLORER', explorer: await explorerPresentation() });
  };
  const sent: WebviewToHostMessage[] = [];
  const pending: Promise<void>[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: (raw) => {
    const message = raw as WebviewToHostMessage; sent.push(message);
    expect(isWebviewToHostMessage(message)).toBe(true);
    if (message.type === 'LOAD_MODULE_CHILDREN') post({ type: 'MODULE_CHILDREN', requestId: message.requestId,
      page: readExplorerChildren(moduleChildren, message.request) });
    if (message.type === 'SAVE_SETTINGS') pending.push((async () => {
      historyPaths = message.settings.repositoryPaths;
      post({ type: 'SETTINGS_UPDATED', settings: message.settings });
      await host.synchronize({ repositories: inputs() }); await host.waitForProjects(); await emit();
    })());
    if (message.type === 'SELECT_CODE_INTELLIGENCE_PROJECT') pending.push((async () => {
      await host.selectProjectForDisplay(message); await emit();
    })());
  } });
  await host.synchronize({ repositories: inputs() }); await host.waitForProjects();
  await assertLightweightProjectAnalysis();
  const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  await act(async () => post({ type: 'INIT', payload: {
    target: null, workspaceRoot: paths[2]!, settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [],
    codeIntelligence: await host.presentation(), moduleExplorer: await explorerPresentation(),
    serviceStatus: { moduleSearch: 'connected', adaptation: 'connected', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
  } }));
  expect(container.querySelector<HTMLElement>('.module-sidebar')!.hidden).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('.workbench-resources-button')!.click());
  expect(container.textContent).toContain('Stored summary: target');
  expect(container.textContent).not.toContain('WRONG DISK SUMMARY');
  expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 Agent module target"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 index.ts"]')!.click());
  expect(container.querySelector('.module-tree')?.textContent).toContain('run');
  expect(sent.filter((message) => message.type === 'LOAD_MODULE_CHILDREN')).toHaveLength(2);
  await act(async () => (container.querySelector('.header-settings-button') as HTMLButtonElement).click());
  const clickText = async (text: string) => act(async () => {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    expect(button).toBeDefined(); button!.click();
  });
  const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(keyInput.placeholder).toBe('无');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(keyInput, 'test-inline-key');
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(sent.some(message => message.type === 'SAVE_SETTINGS')).toBe(false);
  await clickText('手动添加路径');
  const enter = async (index: number, value: string) => act(async () => {
    const input = container.querySelectorAll<HTMLInputElement>('.repository-path-fields input')[index]!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await enter(0, paths[0]!); await clickText('添加路径'); await enter(1, paths[1]!);
  await act(async () => {
    post({ type: 'REQUEST_SETTINGS_SAVE' });
    await Promise.all(pending);
  });
  expect(sent).toContainEqual({ type: 'SAVE_SETTINGS', modelKey: 'test-inline-key', settings: expect.objectContaining({ repositoryPaths: paths.slice(0, 2), topK: 4 }) });
  expect(keyInput.value).toBe('');
  const savedMessage = sent.find(message => message.type === 'SAVE_SETTINGS')!;
  expect(JSON.stringify('settings' in savedMessage && savedMessage.settings)).not.toContain('test-inline-key');
  expect(plan).toHaveBeenCalledTimes(3);
  const history = (await host.presentation()).repositories.find((r) => r.displayName === 'history-b')!;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.workspace-switch button:nth-child(2)')!.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="选择参考工程"]')!.click();
  });
  expect(container.querySelector('.project-selector')).toBeNull();
  expect(container.querySelector('.module-sidebar [role="menu"]')).not.toBeNull();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="group"][aria-label="history-b"] [role="menuitemradio"]')!.click();
    await Promise.all(pending);
  });
  expect(sent).toContainEqual({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT', repositoryId: history.repositoryId,
    analysisRevision: history.selectedRevision, projectId: history.projects[0]!.projectId });
  expect(container.textContent).toContain('Stored summary: history-b');
  expect(container.textContent).toContain('Agent module history-b');
  expect(container.textContent).not.toContain('WRONG DISK SUMMARY');
  await host.synchronize({ repositories: inputs() }); await host.waitForProjects();
  expect(plan).toHaveBeenCalledTimes(3);
}, 20_000);
