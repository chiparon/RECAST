import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TargetImportPanel } from './components/TargetImportPanel';
import type { TargetImportTask } from '../../src/target-import-task-types';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.useRealTimers(); });
const task: TargetImportTask = { id: '11111111-2222-3333-4444-555555555555', mode: 'browse', status: 'running', stage: 'parse',
  createdAt: '2026-10-21T12:00:00Z', updatedAt: '2026-10-21T12:00:05Z', directory: 'E:\\orders', displayName: 'Orders',
  indexReady: false, modelReady: false, message: '正在解析源文件', progress: { completed: 128, total: 460, unit: '个文件' },
  events: [{ at: '2026-10-21T12:00:00Z', stage: 'selecting', message: '开始选择目录' },
    { at: '2026-10-21T12:00:05Z', stage: 'parse', message: '正在解析源文件 128/460' }] };
async function mount(tasks = [task]) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const onAction = vi.fn();
  const render = (tasks: TargetImportTask[], kind: 'target' | 'history' = 'target') => act(async () => root!.render(<TargetImportPanel tasks={tasks} kind={kind} locked={false} onAction={onAction} />));
  await render(tasks);
  const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent?.includes(text))!;
  return { container, render, button, onAction };
}
it('shows honest numeric progress and elapsed time, and switches modeling to indeterminate progress', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T12:00:10Z'));
  const { container, render, button, onAction } = await mount();
  expect(container.textContent).toContain('128 / 460 个文件');
  expect(container.textContent).toContain('已用时 00:10');
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('28');
  await act(async () => vi.advanceTimersByTime(2000));
  expect(container.textContent).toContain('已用时 00:12');
  await render([{ ...task, stage: 'modeling', indexReady: true, progress: undefined, message: '正在生成模块模型' }]);
  expect(container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
  expect(container.textContent).toContain('索引：已完成');
  expect(container.textContent).toContain('模块建模：进行中');
  await act(async () => button('停止等待').click());
  expect(onAction).toHaveBeenCalledWith(task.id, 'cancel');
});

it.each(['target', 'history'] as const)('dismisses %s without stopping work, permits reopening and reappears for new tasks', async kind => {
  const { container, render, onAction } = await mount();
  await render([task], kind);
  const label = kind === 'target' ? '目标工程' : '参考工程';
  const click = (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  await click(`关闭${label}导入任务`);
  expect(container.querySelector(`[aria-label="${label}导入任务"]`)).toBeNull();
  expect(onAction).not.toHaveBeenCalled();
  await render([{ ...task, progress: { completed: 200, total: 460, unit: '个文件' } }], kind);
  expect(container.querySelector(`[aria-label="${label}导入任务"]`)).toBeNull();
  await click(`显示${label}导入任务`);
  expect(container.textContent).toContain('200 / 460');
  await click(`关闭${label}导入任务`);
  await render([{ ...task, id: 'new-import', displayName: 'New project' }, task], kind);
  expect(container.querySelector(`[aria-label="${label}导入任务"]`)?.textContent).toContain('New project');
});
it('keeps past events and failure detail, retries by task id, and freezes completed duration', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T12:10:00Z'));
  const failed: TargetImportTask = { ...task, status: 'failed', stage: 'modeling', indexReady: true, endedAt: '2026-10-21T12:01:00Z', message: '模型响应无效' };
  const { container, button, onAction } = await mount([failed]);
  expect(container.textContent).toContain('已用时 01:00');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('模型响应无效');
  await act(async () => button('查看历史').click());
  await act(async () => container.querySelector<HTMLButtonElement>('.target-import-history button')!.click());
  expect(container.querySelector('[role="log"]')?.textContent).toContain('开始选择目录');
  expect(container.querySelector('[role="log"]')?.textContent).toContain('128/460');
  await act(async () => button('重试导入').click());
  expect(onAction).toHaveBeenCalledWith(task.id, 'retry');
});
