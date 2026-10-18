import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import { isWebviewToHostMessage } from '../../src/protocol/messages';
import type { ProjectPipelineRun, ProjectReviewKind } from '../../src/project-pipeline-types';
import App from './App';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; });
const run: ProjectPipelineRun = { id: '11111111-2222-3333-4444-555555555555', repositoryId: 'repo', projectId: 'project', analysisRevision: 'revision', projectName: 'Gateway',
  requirement: '实现完整项目的租户隔离', mode: 'assisted', status: 'running', stage: 'modeling', createdAt: '', updatedAt: '', modules: [], decisions: [],
  events: [{ id: 'event1', at: new Date().toISOString(), stage: 'modeling', message: '正在固定项目版本' }], acceptance: 'unverified', reportAvailable: false };

async function setup() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const sent: WebviewToHostMessage[] = [];
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: raw => { expect(isWebviewToHostMessage(raw)).toBe(true); sent.push(raw as WebviewToHostMessage); } });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<App />));
  await act(async () => post({ type: 'INIT', payload: { target: null, workspaceRoot: '/target', settings: { repositoryPaths: ['/history'], topK: 4 },
    repositoryStatuses: [], codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { moduleSearch: 'connected', adaptation: 'connected', executionMode: 'real' }, searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
    moduleExplorer: { generatedAt: '', history: [], target: { id: 'repo', repositoryId: 'repo', projectId: 'project', revision: 'revision', mode: 'target', name: 'Gateway', rootLabel: '.', tree: [],
      stats: { modules: 2, files: 2, types: 0, methods: 0, implemented: 0, unimplemented: 2, unknown: 0, dependencies: 1 }, summary: { exists: false, path: '.forexplore/module-summary.json' } } } } }));
  const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent?.includes(text))!;
  return { container, post, sent, button };
}

function documentFile(name: string, text: string) {
  const file = new File([text], name, { type: 'text/plain' });
  Object.defineProperty(file, 'text', { value: async () => text });
  return file;
}

function dragDocument(element: Element, type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
  element.dispatchEvent(event);
  return event;
}

it('imports a dropped document, keeps the drop hint across nested elements, and starts with its contents', async () => {
  const { container, sent, button } = await setup();
  const documentArea = container.querySelector('.pipeline-document')!;
  const textarea = container.querySelector<HTMLTextAreaElement>('#project-requirement')!;
  await act(async () => {
    dragDocument(documentArea, 'dragenter');
    dragDocument(textarea, 'dragenter');
    dragDocument(textarea, 'dragleave');
  });
  expect(container.textContent).toContain('松开导入需求文档');
  await act(async () => { expect(dragDocument(textarea, 'drop', [documentFile('需求.md', '\uFEFF完整项目需求')]).defaultPrevented).toBe(true); });
  expect(textarea.value).toBe('完整项目需求');
  expect(documentArea.textContent).toContain('需求.md');
  expect(container.querySelector('.project-document-drop-overlay')).toBeNull();
  expect(container.querySelector('[role="log"]')).toBeNull();
  await act(async () => button('开始执行').click());
  expect(sent).toContainEqual({ type: 'START_PROJECT_PIPELINE', input: { repositoryId: 'repo', projectId: 'project', requirement: '完整项目需求', topK: 4, mode: 'automatic' } });
});

it.each([
  ['unsupported', [documentFile('需求.pdf', 'new requirement')]],
  ['empty', [documentFile('empty.txt', '  ')]],
  ['too long', [documentFile('long.md', '新'.repeat(8001))]],
  ['multiple', [documentFile('a.txt', 'first'), documentFile('b.txt', 'second')]],
] as const)('preserves the requirement when a dropped document is %s', async (_reason, files) => {
  const { container } = await setup();
  const textarea = container.querySelector<HTMLTextAreaElement>('#project-requirement')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '保留原文');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { dragDocument(container.querySelector('.pipeline-document')!, 'drop', [...files]); });
  expect(textarea.value).toBe('保留原文');
  expect(container.querySelector('[role="alert"]')!.textContent).toBeTruthy();
});

it('ignores dropped documents while a task is running', async () => {
  const { container, post } = await setup();
  await act(async () => post({ type: 'PROJECT_PIPELINE_STATE', run }));
  await act(async () => container.querySelector<HTMLButtonElement>('.project-section-toggle')!.click());
  await act(async () => { dragDocument(container.querySelector('.pipeline-document')!, 'drop', [documentFile('new.md', '不得替换运行中的需求')]); });
  expect(container.querySelector<HTMLTextAreaElement>('#project-requirement')!.value).toBe(run.requirement);
  expect(container.querySelector('.project-document-drop-overlay')).toBeNull();
});

it('starts an entire project with a requirement and no selected module, then shows real host events and cancellation', async () => {
  const { container, post, sent, button } = await setup();
  expect(container.textContent).toContain('准备任务');
  expect(container.querySelector<HTMLElement>('.module-sidebar')!.hidden).toBe(true);
  expect(container.querySelector('.project-execution-panel')).toBeNull();
  expect(container.querySelector('[role="log"]')).toBeNull();
  expect(container.querySelector('[aria-label="项目流水线进度"]')).toBeNull();
  expect(container.querySelector('main')!.children).toHaveLength(1);
  expect(button('开始执行').disabled).toBe(true);
  await act(async () => {
    const textarea = container.querySelector<HTMLTextAreaElement>('#project-requirement')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, run.requirement);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('开始执行').click());
  expect(container.querySelector('.project-execution-panel')?.textContent).toContain('正在启动');
  expect(container.querySelector('.project-execution-panel [role="log"]')).not.toBeNull();
  expect(sent).toContainEqual({ type: 'START_PROJECT_PIPELINE', input: { repositoryId: 'repo', projectId: 'project', requirement: run.requirement, topK: 4, mode: 'automatic' } });
  expect(sent.some(message => message.type === 'START_SEARCH')).toBe(false);
  await act(async () => post({ type: 'PROJECT_PIPELINE_STATE', run }));
  expect(container.querySelector<HTMLElement>('#project-task-inputs')!.hidden).toBe(true);
  expect(container.querySelector('[role="log"]')!.textContent).toContain('正在固定项目版本');
  expect(container.querySelector('.module-sidebar')!.hasAttribute('inert')).toBe(true);
  await act(async () => button('取消项目运行').click());
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', action: 'cancel', runId: run.id });
});

it.each(['model', 'candidate', 'plan', 'acceptance'] as ProjectReviewKind[])('renders and submits the %s checkpoint with its exact evidence token', async kind => {
  const { container, post, sent, button } = await setup();
  const review = { id: 'aaaaaaaa-2222-3333-4444-555555555555', kind, evidenceHash: 'a'.repeat(64), summary: '审阅真实证据' };
  await act(async () => post({ type: 'PROJECT_PIPELINE_STATE', run: { ...run, status: 'waiting-review', review } }));
  expect(container.textContent).toContain('审阅真实证据');
  expect(container.querySelector('.project-execution-content')!.firstElementChild).toBe(container.querySelector('.project-review-panel'));
  expect(container.querySelector<HTMLElement>('#project-task-inputs')!.hidden).toBe(true);
  if (kind === 'acceptance') {
    await act(async () => button('查看代码差异').click());
    expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', runId: run.id, action: 'open-diff' });
  }
  await act(async () => button(kind === 'acceptance' ? '批准输出项目' : '确认并继续').click());
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', runId: run.id, action: 'review', review: {
    reviewId: review.id, evidenceHash: review.evidenceHash, decision: 'approve', notes: '', ...(kind === 'candidate' ? { candidateId: null } : {}),
  } });
});

it('offers the output project and Markdown/JSON report exports without claiming unmeasured coverage', async () => {
  const { container, post, sent, button } = await setup();
  await act(async () => post({ type: 'PROJECT_PIPELINE_STATE', run: { ...run, status: 'completed', stage: 'complete', reportAvailable: true, outputRoot: '/managed/output', acceptance: 'compilation-only', commit: 'a'.repeat(40) } }));
  expect(container.textContent).toContain('尚无行为验收通过记录'); expect(container.textContent).toContain('覆盖率：未采集');
  expect(container.querySelector('.project-execution-content')!.firstElementChild).toBe(container.querySelector('.project-pipeline-output'));
  await act(async () => button('打开输出项目').click()); await act(async () => button('导出报告').click());
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', action: 'open-output', runId: run.id });
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', action: 'export-report', runId: run.id });
});
