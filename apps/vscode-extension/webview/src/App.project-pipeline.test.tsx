import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import { isWebviewToHostMessage } from '../../src/protocol/messages';
import type { ProjectPipelineRun } from '../../src/project-pipeline-types';
import type { PipelineModuleVerification } from '../../src/project-module-verifier';
import type { CodeIntelligenceRepositoryPresentation } from '../../src/ui-types';
import App from './App';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; });
const run: ProjectPipelineRun = { id: '11111111-2222-3333-4444-555555555555', repositoryId: 'repo', projectId: 'project', analysisRevision: 'revision', projectName: 'Gateway',
  requirement: '实现完整项目的租户隔离', status: 'running', stage: 'modeling', createdAt: '', updatedAt: '', modules: [],
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

it('keeps the cached repository visible with an explicit read warning and clears the warning after recovery', async () => {
  const { container, post } = await setup();
  const repository: CodeIntelligenceRepositoryPresentation = { repositoryId: 'history', displayName: 'Camel', role: 'history',
    analysisStatus: 'ready', activeRevision: 'revision', selectedRevision: 'revision', revisions: [], languages: [], projects: [], selectedProjectId: null, summary: { status: 'missing' } };
  const message = '状态更新暂时失败，显示上次读取的结果';
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'error', runtimeStatus: 'error', storage: 'seekdb', repositories: [repository], message,
  } }));
  expect(container.querySelector('.error-banner[role="status"]')?.textContent).toBe(message);
  expect(container.querySelector('.history-import-progress li strong')?.textContent).toBe('Camel');
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: {
    status: 'ready', runtimeStatus: 'ready', storage: 'seekdb', repositories: [repository],
  } }));
  expect(container.querySelector('.error-banner[role="status"]')).toBeNull();
  expect(container.querySelector('.history-import-progress li strong')?.textContent).toBe('Camel');
});

it('keeps history progress visible after settings save and distinguishes indexing from model completion', async () => {
  const { container, post } = await setup();
  const repository: CodeIntelligenceRepositoryPresentation = { repositoryId: 'history', displayName: 'Camel', role: 'history',
    analysisStatus: 'registered', activeRevision: null, selectedRevision: null, revisions: [], languages: [], projects: [], selectedProjectId: null, summary: { status: 'missing' },
    indexing: { stage: 'queued', position: 1, count: 7 } };
  const status = (value: CodeIntelligenceRepositoryPresentation) => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb', repositories: [value] } });
  await act(async () => {
    status(repository);
    post({ type: 'SETTINGS_UPDATED', settings: { repositoryPaths: ['/history'], topK: 4 } });
  });
  expect(container.querySelector('.history-import-progress')?.textContent).toContain('等待解析');
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb', repositories: [
    repository, { ...repository, repositoryId: 'flowable', displayName: 'Flowable', analysisStatus: 'indexing',
      indexing: { stage: 'parse', completed: 15, total: 20, position: 2, count: 7 } },
  ] } }));
  expect(container.querySelector('.history-import-progress > summary')?.textContent).toContain('Flowable');
  expect(container.querySelector('.history-import-progress > summary')?.textContent).toContain('15/20');
  await act(async () => status(repository));
  await act(async () => post({ type: 'REPOSITORY_INDEXING_PROGRESS', progress: { repositoryId: 'history', displayName: 'Camel', stage: 'parse', completed: 15, total: 20, position: 1, count: 7 } }));
  expect(container.querySelector('.history-import-progress')?.textContent).toContain('15/20');
  const analysis = { repositoryId: 'history', analysisRevision: 'revision', projectId: 'core', analysisProfile: 'profile', updatedAt: '', state: 'analyzing' as const, projection: 'pending' as const };
  const indexed = { ...repository, indexing: undefined, analysisStatus: 'ready' as const, activeRevision: 'revision',
    projects: [{ projectId: 'core', displayName: 'Core', kind: 'package', relativePath: '.', languageIds: [], analysis }] };
  await act(async () => status(indexed));
  expect(container.querySelector('.history-import-progress')?.textContent).toContain('建模 0/1');
  expect(container.querySelector('.history-import-progress')?.textContent).not.toContain('1/1 个完成');
  await act(async () => status({ ...indexed, projects: [{ ...indexed.projects[0]!, analysis: { ...analysis, state: 'ready', projection: 'ready' } }] }));
  expect(container.querySelector('.history-import-progress')?.textContent).toContain('1/1 个完成');
  expect(container.querySelector('.history-import-progress .is-spinning')).toBeNull();
});

it('shows an empty build boundary as completed without counting it as a modeled project', async () => {
  const { container, post } = await setup();
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', runtimeStatus: 'ready', storage: 'seekdb', repositories: [{
    repositoryId: 'history', displayName: 'Keycloak', role: 'history', analysisStatus: 'ready', activeRevision: 'revision', selectedRevision: 'revision',
    revisions: [], languages: [], selectedProjectId: 'wrapper', summary: { status: 'missing' }, projects: [{
      projectId: 'wrapper', displayName: 'admin-ui', kind: 'maven', relativePath: 'js/apps/admin-ui', languageIds: [], analysis: {
        repositoryId: 'history', analysisRevision: 'revision', projectId: 'wrapper', analysisProfile: 'profile', state: 'ready', projection: 'ready', updatedAt: '',
        modelingSkippedReason: '工程没有独立文件，仅保留构建定义，无需功能模块建模。',
      },
    }],
  }] } }));
  const progress = container.querySelector('.history-import-progress')!;
  expect(progress.textContent).toContain('1/1 个完成');
  expect(progress.textContent).toContain('0 个子项目已建模');
  expect(progress.textContent).toContain('1 个工程无独立文件，无需建模');
  expect(progress.querySelector('button')).toBeNull();
  expect(progress.querySelector('.is-spinning')).toBeNull();
});

function dragDocument(element: Element, type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
  element.dispatchEvent(event);
  return event;
}

it.each(['typed', 'imported'] as const)('keeps independent %s drafts across scope and settings round trips', async (source) => {
  const { container, button, sent } = await setup();
  const edit = async (text: string, fileName: string) => {
    await act(async () => {
      if (source === 'imported') {
        dragDocument(container.querySelector('.pipeline-document')!, 'drop', [documentFile(fileName, text)]);
      } else {
        const textarea = container.querySelector('textarea')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  };
  await edit('项目需求草稿', '项目.md');
  await act(async () => button('单模块调试').click());
  expect(container.querySelector('textarea')!.value).toBe('');
  await edit('模块需求草稿', '模块.md');
  for (const [scope, text, fileName] of [
    ['整个项目', '项目需求草稿', '项目.md'],
    ['单模块调试', '模块需求草稿', '模块.md'],
    ['整个项目', '项目需求草稿', '项目.md'],
  ] as const) {
    await act(async () => button(scope).click());
    await act(async () => button('设置').click());
    await act(async () => button('设置').click());
    expect(container.querySelector('textarea')!.value).toBe(text);
    if (source === 'imported') expect(container.querySelector('.pipeline-document')!.textContent).toContain(fileName);
  }
  expect(sent.some(message => message.type === 'START_PROJECT_PIPELINE' || message.type === 'START_SEARCH')).toBe(false);
  await act(async () => button('开始执行').click());
  expect(sent).toContainEqual({ type: 'START_PROJECT_PIPELINE', input: { repositoryId: 'repo', projectId: 'project', requirement: '项目需求草稿', topK: 4 } });
});

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
  expect(sent).toContainEqual({ type: 'START_PROJECT_PIPELINE', input: { repositoryId: 'repo', projectId: 'project', requirement: '完整项目需求', topK: 4 } });
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
  expect(sent).toContainEqual({ type: 'START_PROJECT_PIPELINE', input: { repositoryId: 'repo', projectId: 'project', requirement: run.requirement, topK: 4 } });
  expect(sent.some(message => message.type === 'START_SEARCH')).toBe(false);
  await act(async () => post({ type: 'PROJECT_PIPELINE_STATE', run }));
  expect(container.querySelector<HTMLElement>('#project-task-inputs')!.hidden).toBe(true);
  expect(container.querySelector('[role="log"]')!.textContent).toContain('正在固定项目版本');
  expect(container.querySelector('.module-sidebar')!.hasAttribute('inert')).toBe(true);
  await act(async () => button('取消项目运行').click());
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', action: 'cancel', runId: run.id });
});

it('offers the output project and Markdown/JSON report exports without claiming unmeasured coverage', async () => {
  const { container, post, sent, button } = await setup();
  await act(async () => post({ type: 'PROJECT_PIPELINE_STATE', run: { ...run, status: 'completed', stage: 'complete', reportAvailable: true, outputRoot: '/managed/output', acceptance: 'compilation-only', commit: 'a'.repeat(40) } }));
  expect(container.textContent).toContain('行为验证尚未全部通过'); expect(container.textContent).toContain('覆盖率：未采集');
  expect(container.querySelector('.project-execution-content')!.firstElementChild).toBe(container.querySelector('.project-pipeline-output'));
  await act(async () => button('打开输出项目').click()); await act(async () => button('导出报告').click());
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', action: 'open-output', runId: run.id });
  expect(sent).toContainEqual({ type: 'PROJECT_PIPELINE_ACTION', action: 'export-report', runId: run.id });
});

it('distinguishes coverage attribution failures from unavailable runners and shows the concrete reason', async () => {
  const { container, post } = await setup();
  const verification: PipelineModuleVerification = { disposition: 'test-environment', mode: 'requirement', attempts: [], result: {
    status: 'failure', reason: 'coverage-unavailable', functions: [{ target: { path: 'Domain.cs', name: 'Matches', signature: 'ContentSignature.Matches(ReadOnlySpan<byte> content)' },
      status: 'unverified', executed: false, lineCoverage: null, branchCoverage: null, reason: 'coverage-unavailable', coverageIssue: 'Cannot uniquely locate target function Matches in Cobertura report (0 matches).' }],
  } };
  const module: ProjectPipelineRun['modules'][number] = { id: 'domain', name: 'Domain', status: 'completed', dependsOn: [], candidates: [], moduleVerification: verification,
    target: { id: 'domain', name: 'Domain', path: 'Domain.cs', language: 'C#', kind: 'module', signature: 'ContentSignature.Matches' } };
  const update = (extra: Partial<ProjectPipelineRun> = {}) => post({ type: 'PROJECT_PIPELINE_STATE', run: { ...run, modules: [module], ...extra } });
  await act(async () => update());
  const cell = () => container.querySelector('.project-modules-table td:last-child')!;
  expect(cell().querySelector('summary')?.textContent).toBe('覆盖率无法确认（生成阶段）');
  expect(cell().textContent).toContain('ContentSignature.Matches(ReadOnlySpan<byte> content)');
  expect(cell().textContent).toContain('0 matches');
  expect(cell().textContent).not.toContain('验证环境不可用');
  await act(async () => (cell().querySelector('summary') as HTMLElement).click());
  expect(cell().querySelector('details')?.open).toBe(true);
  // Final verification replaces generation evidence, including its failure reason.
  const environment: PipelineModuleVerification = { disposition: 'test-environment', mode: 'requirement', attempts: [], result: {
    status: 'failure', reason: 'test-environment-failure', functions: [], issue: { kind: 'environment', description: 'dotnet executable not found' },
  } };
  const compilation = { success: true, command: { executable: 'dotnet', args: ['build'] }, startedAt: '', durationMs: 1, exitCode: 0, output: '', diagnostics: [] };
  await act(async () => update({ validation: { compilation, protectedFilesUnchanged: true, sourceHash: 'hash', coverage: null, modules: [{ id: 'domain', verification: environment }] } }));
  expect(cell().querySelector('summary')?.textContent).toBe('验证环境不可用');
  expect(cell().textContent).toContain('dotnet executable not found');
  expect(cell().textContent).not.toContain('生成阶段');
  expect(cell().textContent).not.toContain('0 matches');
});
