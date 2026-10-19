import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModuleTarget, WorkspaceTranslationRun } from '@forexplore/contracts';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import { isWebviewToHostMessage } from '../../src/protocol/messages';
import App from './App';

let root: Root | undefined;
function changeText(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
function chooseFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function documentFile(name: string, text: string) {
  return Object.assign(new File([text], name), { text: async () => text });
}
function dragDocument(element: Element, type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
  element.dispatchEvent(event);
  return event;
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });
const target: ModuleTarget = { id: 'target-module', name: 'Upload', kind: 'module', language: 'Java', path: 'Upload.java', signature: '',
  module: { sourceFiles: ['Upload.java'], coreApis: ['upload'], dependsOn: [] } };
const scopeId = 'a'.repeat(64);
const run: WorkspaceTranslationRun = { id: '11111111-2222-3333-4444-555555555555', workspaceRoot: '/target', status: 'translating',
  request: { spec: 'Upload', sourceLanguage: 'TypeScript', targetLanguage: 'Java', context: [], workspaceFiles: ['Upload.java'], writeFiles: ['Upload.java'] },
  createdAt: new Date().toISOString(), updatedAt: '', completedSteps: [], changes: [], compilations: [], modelTurns: 1, acceptance: 'compilation-only',
  events: [{ at: new Date().toISOString(), phase: 'translating', message: '正在生成 Upload.java' }] };

async function mount(reply?: (message: WebviewToHostMessage, post: (message: HostToWebviewMessage) => void) => void) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const sent: WebviewToHostMessage[] = [];
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: raw => {
    const message = raw as WebviewToHostMessage;
    expect(isWebviewToHostMessage(message)).toBe(true);
    sent.push(message); reply?.(message, post);
  } });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<StrictMode><App /></StrictMode>));
  await act(async () => post({ type: 'INIT', payload: { target, workspaceRoot: '/target',
    settings: { repositoryPaths: ['/history-existing'], topK: 4 }, repositoryStatuses: [],
    codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { moduleSearch: 'connected', adaptation: 'connected', executionMode: 'real' }, searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
    moduleExplorer: { generatedAt: '', history: [], target: { id: 'target', name: 'Target', mode: 'target', rootLabel: '.', tree: [],
      stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
      summary: { exists: false, path: '.forexplore/module-summary.json' } } } } }));
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
  await act(async () => button('单模块调试').click());
  const enter = async (text = '实现文件上传大小限制和空文件校验') => act(async () => changeText(container.querySelector('#pipeline-requirement')!, text));
  return { container, sent, post, button, enter };
}

function translationReply(message: WebviewToHostMessage, post: (message: HostToWebviewMessage) => void) {
  if (message.type === 'START_SEARCH') post({ type: 'SEARCH_RESULT', candidates: [] });
  if (message.type === 'START_ADAPT') post({ type: 'MODULE_TRANSLATION_READY', targetId: target.id, candidateId: 'direct-fallback', moduleScopeId: scopeId });
  if (message.type === 'WORKSPACE_TRANSLATION') post({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: message.requestId,
    ...(message.action === 'describe' ? { profile: { profileId: 'profile', moduleScopeId: scopeId, workspaceRoot: '/target', sourceLanguage: 'TypeScript',
      targetLanguage: 'Java', workspaceFiles: ['Upload.java'], writeFiles: ['Upload.java'], behavioralVerification: false } }
      : { run: message.action === 'cancel' ? { ...run, status: 'cancelled' } : message.action === 'read' ? { ...run, modelTurns: 2,
        events: [...run.events!, { at: new Date().toISOString(), phase: 'translating', message: '大小边界条件已生成' }] } : run }) });
}

it('starts direct generation once, polls actual log events and cancels the running task', async () => {
  vi.useFakeTimers();
  const { container, sent, button, enter } = await mount(translationReply);
  expect(container.querySelector('.module-workbench')!.children).toHaveLength(1);
  expect(container.querySelector('[role="log"]')).toBeNull();
  expect(container.querySelector('[aria-label="流水线进度"]')).toBeNull();
  expect(container.querySelector<HTMLElement>('.module-sidebar')!.hidden).toBe(true);
  await enter(); await act(async () => button('开始执行').click());
  expect(container.querySelector<HTMLElement>('#module-task-inputs')!.hidden).toBe(true);
  expect(container.querySelector('.project-execution-panel .workspace-translation')).not.toBeNull();
  expect(container.querySelector('.project-execution-panel [role="log"]')).not.toBeNull();
  expect(container.querySelector('.processing-ring')).toBeNull();
  expect(sent.filter(message => message.type === 'START_ADAPT')).toHaveLength(1);
  expect(sent.filter(message => message.type === 'WORKSPACE_TRANSLATION' && message.action === 'start')).toHaveLength(1);
  expect(container.querySelector('[role="log"]')!.textContent).toContain('正在生成 Upload.java');
  expect(container.querySelector('.module-sidebar')!.hasAttribute('inert')).toBe(true);
  expect((container.querySelector('#pipeline-requirement') as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => { dragDocument(container.querySelector('.pipeline-document')!, 'drop', [documentFile('new.md', '运行期间不得替换')]); });
  expect(container.querySelector<HTMLTextAreaElement>('#pipeline-requirement')!.value).toBe('实现文件上传大小限制和空文件校验');
  const log = container.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 200 } });
  await act(async () => { log.scrollTop = 100; log.dispatchEvent(new Event('scroll', { bubbles: true })); });
  expect(button('跟随最新').getAttribute('aria-pressed')).toBe('false');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.querySelector('[role="log"]')!.textContent).toContain('大小边界条件已生成');
  expect(log.scrollTop).toBe(100);
  await act(async () => button('跟随最新').click());
  expect(log.scrollTop).toBe(900);
  await act(async () => button('取消运行').click());
  expect(sent).toContainEqual(expect.objectContaining({ type: 'WORKSPACE_TRANSLATION', action: 'cancel', runId: run.id }));
  expect(container.querySelector('[role="log"]')!.textContent).toContain('运行已取消');
  expect((container.querySelector('#pipeline-requirement') as HTMLTextAreaElement).disabled).toBe(false);
});

it('imports a dragged module requirement and starts only after the user clicks Start', async () => {
  const { container, sent, button } = await mount();
  const documentArea = container.querySelector('.pipeline-document')!;
  const textarea = container.querySelector<HTMLTextAreaElement>('#pipeline-requirement')!;
  await act(async () => {
    dragDocument(documentArea, 'dragenter');
    dragDocument(textarea, 'dragenter');
    dragDocument(textarea, 'dragleave');
  });
  expect(container.querySelector('.project-document-drop-overlay')!.textContent).toContain('松开导入需求文档');
  await act(async () => { expect(dragDocument(textarea, 'drop', [documentFile('模块需求.md', '\uFEFF限制空文件上传')]).defaultPrevented).toBe(true); });
  expect(textarea.value).toBe('限制空文件上传');
  expect(documentArea.textContent).toContain('模块需求.md');
  expect(container.querySelector('.project-document-drop-overlay')).toBeNull();
  expect(container.querySelector('.project-execution-panel')).toBeNull();
  expect(sent.some(message => message.type === 'START_SEARCH')).toBe(false);
  await act(async () => button('开始执行').click());
  expect(sent).toContainEqual({ type: 'START_SEARCH', requirement: '限制空文件上传', topK: 4 });
  expect(container.querySelector('.project-execution-panel [role="log"]')).not.toBeNull();
});

it('returns to preparation without restarting an old module scope after switching views', async () => {
  const { container, sent, button, enter } = await mount((message, post) => {
    if (message.type === 'WORKSPACE_TRANSLATION' && message.action === 'start') {
      post({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: message.requestId, run: { ...run, status: 'completed' } });
    } else translationReply(message, post);
  });
  await enter(); await act(async () => button('开始执行').click());
  expect(sent.filter(message => message.type === 'WORKSPACE_TRANSLATION' && message.action === 'start')).toHaveLength(1);
  await act(async () => button('整个项目').click());
  await act(async () => button('单模块调试').click());
  expect(container.querySelector('.module-workbench')!.children).toHaveLength(1);
  expect(container.querySelector('.project-execution-panel')).toBeNull();
  expect(sent.filter(message => message.type === 'WORKSPACE_TRANSLATION' && message.action === 'start')).toHaveLength(1);
});

it.each([
  ['unsupported', [documentFile('需求.pdf', '替换内容')]],
  ['empty', [documentFile('empty.txt', '  ')]],
  ['too long', [documentFile('long.md', '字'.repeat(8001))]],
  ['multiple', [documentFile('a.md', 'first'), documentFile('b.md', 'second')]],
] as const)('preserves the module requirement when a dropped document is %s', async (_reason, files) => {
  const { container, enter } = await mount();
  await enter('保留模块需求');
  await act(async () => { dragDocument(container.querySelector('.pipeline-document')!, 'drop', [...files]); });
  expect(container.querySelector<HTMLTextAreaElement>('#pipeline-requirement')!.value).toBe('保留模块需求');
  expect(container.querySelector('[role="alert"]')!.textContent).toBeTruthy();
});

it('keeps a running task locked after a polling error and recovers through refresh without starting it again', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const { container, sent, button, enter } = await mount((message, post) => {
    if (message.type === 'WORKSPACE_TRANSLATION' && message.action === 'read') {
      if (++reads === 1) post({ type: 'WORKSPACE_TRANSLATION_ERROR', requestId: message.requestId, message: '状态读取暂时失败' });
      else post({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: message.requestId, run: { ...run, status: 'completed' } });
    } else translationReply(message, post);
  });
  await enter(); await act(async () => button('开始执行').click());
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.querySelector('[role="log"]')!.textContent).toContain('状态读取暂时失败');
  expect((container.querySelector('#pipeline-requirement') as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => button('重试刷新').click());
  expect((container.querySelector('#pipeline-requirement') as HTMLTextAreaElement).disabled).toBe(false);
  expect(sent.filter(message => message.type === 'WORKSPACE_TRANSLATION' && message.action === 'start')).toHaveLength(1);
  expect(container.textContent).toContain('尚无行为验收通过记录');
});

it('releases a search that never receives a host reply with an actionable timeout', async () => {
  vi.useFakeTimers();
  const { container, button, enter } = await mount();
  await enter(); await act(async () => button('开始执行').click());
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  expect(container.querySelector('[role="log"]')!.textContent).toContain('没有回复检索请求');
  expect(button('重新开始').disabled).toBe(false);
});

it('stops on a host error and logs the same failure again after an explicit retry', async () => {
  const { container, sent, button, enter } = await mount((message, post) => {
    if (message.type === 'START_SEARCH') post({ type: 'ERROR', message: '历史检索服务暂时不可用' });
  });
  await enter(); await act(async () => button('开始执行').click());
  expect(container.querySelector('[role="log"]')!.textContent).toContain('历史检索服务暂时不可用');
  expect(sent.some(message => message.type === 'START_ADAPT')).toBe(false);
  await act(async () => button('重新开始').click());
  expect(sent.filter(message => message.type === 'START_SEARCH')).toHaveLength(2);
  expect(container.querySelector('[role="log"]')!.textContent).toContain('历史检索服务暂时不可用');
  expect(button('重新开始').disabled).toBe(false);
});

it('imports document content without truncating an oversized replacement and preserves it while editing settings', async () => {
  const { container, button } = await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = (name: string, text: string) => Object.assign(new File([], name), { text: async () => text });
  await act(async () => chooseFile(input, file('requirements.md', '# 文件上传\n限制大小并处理空文件')));
  const textarea = container.querySelector<HTMLTextAreaElement>('#pipeline-requirement')!;
  expect(textarea.value).toContain('限制大小并处理空文件');
  await act(async () => chooseFile(input, file('oversized.txt', '字'.repeat(8001))));
  expect(textarea.value).toContain('限制大小并处理空文件');
  expect(container.textContent).toContain('超过 8000 字上限');
  await act(async () => (container.querySelector('.header-settings-button') as HTMLButtonElement).click());
  await act(async () => (container.querySelector('.header-settings-button') as HTMLButtonElement).click());
  expect(textarea.value).toContain('限制大小并处理空文件');
  expect(button('开始执行').disabled).toBe(false);
});

it('retains existing history repositories when importing another repository from the task panel', async () => {
  const { sent, button } = await mount((message, post) => {
    if (message.type === 'BROWSE_REFERENCE_FOLDERS') post({ type: 'REFERENCE_FOLDERS_SELECTED', requestId: message.requestId, paths: ['/history-existing', '/history-new'] });
    if (message.type === 'SAVE_SETTINGS') post({ type: 'SETTINGS_UPDATED', settings: message.settings });
  });
  await act(async () => button('导入历史仓').click());
  expect(sent).toContainEqual({ type: 'SAVE_SETTINGS', settings: { repositoryPaths: ['/history-existing', '/history-new'], topK: 4 } });
  await act(async () => button('导入目标代码').click());
  expect(sent).toContainEqual({ type: 'ADD_TARGET_WORKSPACE', mode: 'browse' });
});
