import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import type { ModuleExplorerPresentation } from '../../src/ui-types';
import App from './App';
import type { TargetImportTask } from '../../src/target-import-task-types';

let reactRoot: Root | undefined;
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot!.unmount());
  document.body.innerHTML = '';
});

const unselectedTarget: ModuleExplorerPresentation = {
  generatedAt: '', history: [],
  target: {
    id: 'target:unselected', mode: 'target', name: '选择目标工程', rootLabel: '',
    stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' }, tree: [],
  },
};

it('restores historical import logs in the same independent task area and retries only incomplete models', async () => {
  const { container, post, posted } = await mountPanel();
  const at = new Date().toISOString();
  await act(async () => {
    post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb', repositories: [{
      repositoryId: 'orders', displayName: 'Orders', role: 'history', analysisStatus: 'ready', activeRevision: 'r1', selectedRevision: 'r1',
      revisions: [], languages: [], summary: { status: 'missing' }, selectedProjectId: 'core', projects: [{
        projectId: 'core', displayName: 'Core', relativePath: '.', languageIds: [], kind: 'node', analysis: {
          repositoryId: 'orders', projectId: 'core', analysisRevision: 'r1', analysisProfile: 'profile', state: 'failed', projection: 'pending', updatedAt: at,
        },
      }],
    }] } });
    post({ type: 'HISTORY_IMPORT_TASKS', tasks: [{ id: '11111111-2222-3333-4444-555555555555', mode: 'workspace', status: 'failed', stage: 'modeling',
      createdAt: at, updatedAt: at, repositoryId: 'orders', displayName: 'Orders', indexReady: true, modelReady: false,
      message: '模型响应校验失败', events: [{ at, stage: 'parse', message: '解析完成：460 个文件' }] }] });
  });
  const panel = container.querySelector<HTMLElement>('[aria-label="参考工程导入任务"]')!;
  expect(panel.closest('.module-main-scroll')).toBeNull();
  const button = (text: string) => [...panel.querySelectorAll('button')].find(button => button.textContent === text)!;
  await act(async () => button('过程记录').click());
  expect(panel.querySelector('[role="log"]')?.textContent).toContain('460 个文件');
  await act(async () => button('重试导入').click());
  expect(posted).toContainEqual({ type: 'RETRY_PROJECT_ANALYSIS', repositoryId: 'orders', analysisRevision: 'r1', projectId: 'core', force: false });
  expect(posted.some(message => message.type === 'REFRESH_REPOSITORY')).toBe(false);
});

async function mountPanel(initialMode: 'search' | 'migration' = 'search') {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const posted: WebviewToHostMessage[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {},
    postMessage: (message: unknown) => { posted.push(message as WebviewToHostMessage); } });
  const container = document.createElement('div'); document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const postRaw = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
  await act(async () => post({ type: 'INIT', payload: { target: null, workspaceRoot: '',
    settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [], moduleExplorer: unselectedTarget,
    codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { moduleSearch: 'connected', adaptation: 'unconfigured', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' } }));
  return { container, post, postRaw, posted };
}

it('keeps the independent import task visible with collapsed inputs, both modes and settings, then restores host history', async () => {
  const tasks: TargetImportTask[] = [{ id: '11111111-2222-3333-4444-555555555555', mode: 'browse', status: 'running', stage: 'modeling',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), displayName: 'Orders', directory: 'E:\\orders',
    indexReady: true, modelReady: false, message: '索引已完成，正在生成模块模型…', events: [
      { at: new Date().toISOString(), stage: 'parse', message: '解析完成：460 个文件' },
    ] }];
  const { container, post, posted } = await mountPanel();
  await act(async () => post({ type: 'TARGET_IMPORT_TASKS', tasks }));
  const panel = () => container.querySelector<HTMLElement>('[aria-label="目标工程导入任务"]')!;
  expect(panel().closest('.module-main-scroll')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.project-section-toggle')!.click());
  expect(container.querySelector('#project-task-inputs')?.hasAttribute('hidden')).toBe(true);
  expect(panel().closest('[hidden]')).toBeNull();
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '单模块调试')!.click());
  expect(panel().textContent).toContain('正在生成模块模型');
  await act(async () => container.querySelector<HTMLButtonElement>('.header-settings-button')!.click());
  expect(panel().closest('[hidden]')).toBeNull();
  await act(async () => [...panel().querySelectorAll('button')].find(button => button.textContent === '停止等待')!.click());
  expect(posted).toContainEqual({ type: 'TARGET_IMPORT_ACTION', taskId: tasks[0]!.id, action: 'cancel' });
  await act(async () => reactRoot!.unmount()); reactRoot = undefined;
  const reopened = await mountPanel();
  await act(async () => reopened.post({ type: 'TARGET_IMPORT_TASKS', tasks: [{ ...tasks[0]!, status: 'interrupted', endedAt: new Date().toISOString() }] }));
  await act(async () => [...reopened.container.querySelectorAll('button')].find(button => button.textContent === '过程记录')!.click());
  expect(reopened.container.querySelector('[aria-label="导入过程记录"]')?.textContent).toContain('460 个文件');
  expect(reopened.container.querySelector('[aria-label="目标工程导入任务"]')?.textContent).toContain('已中断');
});

/**
 * A native dialog returns nothing until it closes and the first index can run
 * for minutes. Without a rendered phase the user cannot tell a slow selection
 * from a button that never ran.
 */
it('renders every target-selection phase and keeps a retry beside the failure', async () => {
  const { container, post, posted } = await mountPanel();
  expect(container.querySelector('.target-add-status')).toBeNull();

  await act(async () => post({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'selecting',
    message: '请在弹出的对话框中选择目标工程目录…' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('请在弹出的对话框中选择目标工程目录');
  expect(container.querySelector('.target-add-status .is-spinning')).not.toBeNull();

  await act(async () => post({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing',
    message: '正在解析目录并建立结构索引…' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('正在解析目录并建立结构索引');

  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'input',
    message: '目标目录不存在或不可访问，请检查路径。' }));
  const error = container.querySelector('.target-add-status.is-error')!;
  expect(error.textContent).toContain('目标目录不存在或不可访问');

  await act(async () => error.querySelector('button')!.click());
  expect(posted.filter((message) => message.type === 'ADD_TARGET_WORKSPACE'))
    .toEqual([{ type: 'ADD_TARGET_WORKSPACE', mode: 'input' }]);
  expect(container.querySelector('.target-add-status.is-error')).toBeNull();
  expect(container.querySelector('.target-add-status .is-spinning')).not.toBeNull();

  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'cancelled', mode: 'input' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('已取消选择目标工程');
  expect(container.querySelector('.target-add-status .is-spinning')).toBeNull();
});

/**
 * The index state is derived from the host presentation, not from the message
 * that started it, so it survives a Webview rebuild after the workspace change.
 */
it('shows a live index state for a target the host is still indexing', async () => {
  const { container, post } = await mountPanel('migration');
  expect(container.querySelector('.project-launch-bar')?.textContent).toContain('请先导入目标代码');
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb',
    repositories: [{ repositoryId: 'repo-1', displayName: 'engine', role: 'target', analysisStatus: 'indexing',
      activeRevision: null, selectedRevision: null, revisions: [], languages: [], projects: [],
      selectedProjectId: null, summary: { status: 'missing' } }] } }));
  const empty = container.querySelector('.pipeline-import-feedback')!;
  expect(empty.textContent).toContain('正在建立项目索引');
  expect(empty.textContent).toContain('engine');
  expect(container.querySelector('[role="log"]')).toBeNull();
});

it('settles an import from the durable ready state when the final result message was lost', async () => {
  const { container, post } = await mountPanel();
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'added', mode: 'browse',
    message: '目标目录已加入工作区，正在建立索引…' }));
  expect(container.querySelector('.target-add-status .is-spinning')).not.toBeNull();

  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb',
    repositories: [{ repositoryId: 'new-target', displayName: 'target', role: 'target', analysisStatus: 'ready',
      activeRevision: 'analysis-1', selectedRevision: 'analysis-1', revisions: [], languages: [], projects: [],
      selectedProjectId: null, summary: { status: 'missing' } }] } }));
  expect(container.querySelector('.target-add-status .is-spinning')).toBeNull();
  expect(container.querySelector('.target-add-status')?.textContent).toContain('目标工程已导入并完成索引');
});

it('shows an index failure when the durable repository state reports failed', async () => {
  const { container, post } = await mountPanel();
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'added', mode: 'browse' }));
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'error', storage: 'seekdb',
    repositories: [{ repositoryId: 'new-target', displayName: 'target', role: 'target', analysisStatus: 'failed',
      activeRevision: null, selectedRevision: null, revisions: [], languages: [], projects: [],
      selectedProjectId: null, summary: { status: 'missing' } }], message: '部分仓库索引失败' } }));
  const failure = container.querySelector('.target-add-status.is-error')!;
  expect(failure.textContent).toContain('目标工程索引失败');
  expect(failure.querySelector('.is-spinning')).toBeNull();
});

it('does not settle a new import from another ready target repository', async () => {
  const { container, post } = await mountPanel();
  const repository = (repositoryId: string, analysisStatus: 'indexing' | 'ready') => ({
    repositoryId, displayName: repositoryId, role: 'target' as const, analysisStatus,
    activeRevision: analysisStatus === 'ready' ? `${repositoryId}-revision` : null,
    selectedRevision: analysisStatus === 'ready' ? `${repositoryId}-revision` : null,
    revisions: [], languages: [], projects: [], selectedProjectId: null, summary: { status: 'missing' as const },
  });
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb',
    repositories: [repository('existing-target', 'ready')] } }));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="选择目标工程"]')!.click());
  const addPath = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes('输入项目路径'))!;
  await act(async () => addPath.click());
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'added', mode: 'input' }));
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb',
    repositories: [repository('existing-target', 'ready'), repository('new-target', 'indexing')] } }));
  expect(container.querySelector('.target-add-status .is-spinning')).not.toBeNull();
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb',
    repositories: [repository('existing-target', 'ready'), repository('new-target', 'ready')] } }));
  expect(container.querySelector('.target-add-status .is-spinning')).toBeNull();
});

it('rejects an unknown target phase instead of trusting the message name', async () => {
  const { container, postRaw } = await mountPanel();
  await act(async () => postRaw({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'queued', message: 'x' }));
  expect(container.querySelector('.target-add-status')).toBeNull();
});

it('restores a failed import after reopening and retries the registered repository', async () => {
  const { container, post, posted } = await mountPanel();
  const repository = { repositoryId: 'failed-target', displayName: 'Camel', role: 'target' as const,
    analysisStatus: 'failed' as const, activeRevision: null, selectedRevision: null, revisions: [], languages: [],
    projects: [], selectedProjectId: null, summary: { status: 'missing' as const } };
  // No transient ADD/RESULT message survives reopening; durable state must suffice.
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'error', storage: 'seekdb', repositories: [repository] } }));
  const failure = container.querySelector('.target-add-status.is-error')!;
  expect(failure.textContent).toContain('目标工程索引失败');
  await act(async () => failure.querySelector<HTMLButtonElement>('button')!.click());
  expect(posted).toContainEqual({ type: 'REFRESH_REPOSITORY', repositoryId: 'failed-target' });
  expect(posted.some(message => message.type === 'ADD_TARGET_WORKSPACE')).toBe(false);
  // Registration and queued pushes may still contain the previous failure.
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'error', storage: 'seekdb', repositories: [repository] } }));
  expect(container.querySelector('.target-add-status.is-error')).toBeNull();
  expect(container.querySelector('.target-add-status button')).toBeNull();
  await act(async () => post({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing', message: '正在生成检索向量 · 已完成 256 条' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('256');
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'ready', storage: 'seekdb', repositories: [{ ...repository, analysisStatus: 'indexing' }] } }));
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'ready', storage: 'seekdb', repositories: [{ ...repository, analysisStatus: 'ready',
      activeRevision: 'recovered', selectedRevision: 'recovered' }] } }));
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'completed', mode: 'workspace' }));
  expect(container.querySelector('.target-add-status .is-spinning')).toBeNull();
  expect(container.querySelector('.target-add-status')?.textContent).toContain('目标工程已添加');
});

it('shows indexing cancellation separately from cancelling the folder picker', async () => {
  const { container, post } = await mountPanel();
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'cancelled', mode: 'browse',
    message: '已取消索引，可稍后重试。' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('已取消索引');
  expect(container.querySelector('.target-add-status .is-spinning')).toBeNull();
});

it('releases the retry latch when the new indexing attempt fails', async () => {
  const { container, post, posted } = await mountPanel();
  const repository = { repositoryId: 'failed-target', displayName: 'Camel', role: 'target' as const,
    analysisStatus: 'failed' as const, activeRevision: null, selectedRevision: null, revisions: [], languages: [],
    projects: [], selectedProjectId: null, summary: { status: 'missing' as const } };
  const status = (analysisStatus: 'failed' | 'indexing') => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'ready', storage: 'seekdb', repositories: [{ ...repository, analysisStatus }] } });
  await act(async () => status('failed'));
  await act(async () => container.querySelector<HTMLButtonElement>('.target-add-status button')!.click());
  await act(async () => status('indexing'));
  await act(async () => status('failed'));
  expect(container.querySelector('.target-add-status.is-error')).toBeNull();
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'workspace', message: '索引失败' }));
  expect(container.querySelector('.target-add-status.is-error button')).not.toBeNull();
  expect(posted.filter(message => message.type === 'REFRESH_REPOSITORY')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('.target-add-status button')!.click());
  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'workspace', message: '注册失败' }));
  expect(container.querySelector('.target-add-status.is-error')?.textContent).toContain('注册失败');
});

it('forgets a stale repository when the host starts a different import', async () => {
  const { container, post, posted } = await mountPanel();
  const repository = (repositoryId: string, analysisStatus: 'failed' | 'indexing') => ({
    repositoryId, displayName: repositoryId, role: 'target' as const, analysisStatus,
    activeRevision: null, selectedRevision: null, revisions: [], languages: [], projects: [],
    selectedProjectId: null, summary: { status: 'missing' as const },
  });
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'error', storage: 'seekdb', repositories: [repository('old-target', 'failed')] } }));
  await act(async () => post({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing', message: '正在恢复目标工程导入…' }));
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'error', storage: 'seekdb', repositories: [repository('new-target', 'failed')] } }));
  await act(async () => container.querySelector<HTMLButtonElement>('.target-add-status button')!.click());
  expect(posted.filter(message => message.type === 'REFRESH_REPOSITORY'))
    .toEqual([{ type: 'REFRESH_REPOSITORY', repositoryId: 'new-target' }]);
});
