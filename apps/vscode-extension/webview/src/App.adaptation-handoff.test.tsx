/// <reference types="node" />
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { ModuleTarget, SearchCandidate } from '@forexplore/contracts';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import type { ModuleExplorerPresentation } from '../../src/ui-types';
import App from './App';

let reactRoot: Root | undefined;
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot!.unmount());
  document.body.innerHTML = '';
});

// A real module target id is a module:// URI rather than a plain identifier
// (project-explorer.ts), and the handoff has to survive the Webview boundary
// with exactly that shape: the explorer produces it, the Webview echoes it back,
// the host returns it.
const moduleTarget = 'module://' + encodeURIComponent(JSON.stringify(
  ['repo-1', 'analysis-1', 'project-1', 'module-container-integration']));
const target: ModuleTarget = { id: moduleTarget, name: 'Limit module', kind: 'module', language: 'TypeScript',
  path: 'target.ts', signature: '', module: { sourceFiles: ['target.ts'], coreApis: ['limit'], dependsOn: [] } };
const candidate: SearchCandidate = { id: 'history-module', title: 'Java limit module', kind: 'module', language: 'Java',
  repository: 'History', path: 'Limit.java', signature: 'limit(int)', summary: 'Boundary policy', preview: 'class Limit {}',
  license: 'MIT', dependencies: [], compatibility: [], risks: [], score: { overall: 0.9, semantic: 0.9, symbol: 1, contract: 1 } };
const explorer: ModuleExplorerPresentation = { generatedAt: '', history: [], target: {
  id: 'target', repositoryId: 'target', projectId: 'project', revision: 'revision', mode: 'target', name: 'Target',
  rootLabel: '.', tree: [], stats: { modules: 1, files: 1, types: 0, methods: 0, implemented: 0, unimplemented: 1, unknown: 0, dependencies: 0 },
  summary: { exists: false, path: '.forexplore/module-summary.json' } } };

/** Walks to the translation handoff, then replies the way the host actually would. */
async function translationHandoff(reply: (target: ModuleTarget, candidate: SearchCandidate) => HostToWebviewMessage) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const sent: WebviewToHostMessage[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: (raw) => {
    const message = raw as WebviewToHostMessage; sent.push(message);
    if (message.type === 'START_SEARCH') post({ type: 'SEARCH_RESULT', candidates: [candidate] });
    if (message.type === 'START_ADAPT') post(reply(target, candidate));
  } });
  const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  await act(async () => post({ type: 'INIT', payload: { target, workspaceRoot: '/target',
    settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [], moduleExplorer: explorer,
    codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { moduleSearch: 'connected', adaptation: 'connected', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' } }));
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
  await act(async () => button('单模块调试').click());
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('#pipeline-requirement')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '实现限额模块');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button('半自动流水线').click();
  });
  await act(async () => button('开始执行').click());
  await act(async () => button('Java limit module').click());
  await act(async () => button('准备模块翻译与回填').click());
  return { container, sent, button, post };
}

it('reports a translation handoff that belongs to another selection instead of waiting forever', async () => {
  // The host answered, but for a different candidate: this used to be dropped
  // in silence, so the panel kept animating "正在翻译" with nothing running.
  const { container, sent, button } = await translationHandoff(() =>
    ({ type: 'MODULE_TRANSLATION_READY', targetId: target.id, candidateId: 'some-other-candidate', moduleScopeId: 'a'.repeat(64) }));

  expect(sent.some((message) => message.type === 'START_ADAPT')).toBe(true);
  expect(container.querySelector('.error-banner')?.textContent).toContain('不属于当前选择的模块候选');
  expect(container.querySelector('.processing-ring')).toBeNull();
  // The panel is back on the candidate step, where the user can pick again.
  expect(container.querySelector('.processing')).toBeNull();
  expect(button('Java limit module')).toBeDefined();
});

it('keeps the panel on the translation step while the host is answering', async () => {
  const { container } = await translationHandoff(() =>
    ({ type: 'MODULE_TRANSLATION_READY', targetId: target.id, candidateId: candidate.id, moduleScopeId: 'b'.repeat(64) }));

  expect(container.querySelector('.workspace-translation')).not.toBeNull();
  expect(container.textContent).not.toContain('当前没有进行中的翻译');
});
