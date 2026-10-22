import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModuleWorkspace } from './ModuleWorkspace';
import type { ModuleWorkspacePresentation } from '../../../src/ui-types';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ''; });

async function mount(state: 'missing' | 'analyzing' | 'failed' | 'ready') {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const workspace: ModuleWorkspacePresentation = {
    id: 'target', mode: 'target', repositoryId: 'target', revision: 'revision', projectId: 'project',
    name: 'Target', rootLabel: '.', tree: [],
    stats: { modules: 0, files: 1, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' },
    analysis: { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', state,
      projection: state === 'ready' ? 'ready' : 'pending', analysisProfile: 'test', updatedAt: '',
      ...(state === 'failed' ? { error: '模型服务暂时不可用' } : {}) },
  };
  const onRetry = vi.fn();
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModuleWorkspace explorer={{ target: workspace, history: [], generatedAt: '' }}
    mode="target" historyId={null} currentTargetId="" selectedNodeId={null} refreshing={false} onRetry={onRetry}
    onModeChange={vi.fn()} onHistoryChange={vi.fn()} onNodeSelect={vi.fn()} onTargetSelect={vi.fn()}
    onRefresh={vi.fn()} onOpenSettings={vi.fn()} settingsOpen={false}>{null}</ModuleWorkspace>));
  return onRetry;
}

it('explains file view and starts modelling without requesting a source rescan', async () => {
  const retry = await mount('missing');
  const status = document.querySelector('.project-model-status')!;
  expect(status.textContent).toContain('模块建模尚未开始');
  await act(async () => status.querySelector('button')!.click());
  expect(retry).toHaveBeenCalledExactlyOnceWith({ repositoryId: 'target', analysisRevision: 'revision', projectId: 'project' }, false);
});

it('shows active modelling without allowing duplicate retries', async () => {
  await mount('analyzing');
  const status = document.querySelector('.project-model-status')!;
  expect(status.textContent).toContain('正在分析功能模块');
  expect(status.querySelector('button')).toBeNull();
});

it('shows a failed model attempt and offers a retry', async () => {
  await mount('failed');
  const status = document.querySelector('.project-model-status')!;
  expect(status.textContent).toContain('模型服务暂时不可用');
  expect(status.querySelector('button')?.textContent).toContain('重试');
});

it('hides the temporary modelling notice once both modelling and retrieval are ready', async () => {
  await mount('ready');
  expect(document.querySelector('.project-model-status')).toBeNull();
});
