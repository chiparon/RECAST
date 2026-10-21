import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectPicker, type ProjectPickerProps, type TargetAddUiState } from './ProjectPicker';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ''; });

const repository = {
  repositoryId: 'repo-history', displayName: 'account-stream-rs', role: 'history', selectedRevision: 'revision-one',
  projects: [{ projectId: 'cargo-project', displayName: 'Cargo', relativePath: '' }],
} as ProjectPickerProps['repositories'][number];
const indexingRepository = {
  repositoryId: 'repo-target', displayName: 'engine', role: 'target', analysisStatus: 'indexing',
  selectedRevision: null, projects: [],
  indexing: { stage: 'snapshot', position: 1, count: 1 },
} as unknown as ProjectPickerProps['repositories'][number];
const workspace = { id: 'repo-history', repositoryId: 'repo-history', projectId: 'cargo-project',
  name: 'account-stream-rs / Cargo', rootLabel: '.',
} as ProjectPickerProps['workspace'];

async function mount(
  mode: ProjectPickerProps['mode'] = 'history',
  options: { targetAdd?: TargetAddUiState; repositories?: ProjectPickerProps['repositories'] } = {},
) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = { onSelect: vi.fn(), onRefresh: vi.fn(), onAdd: vi.fn(), onOpenSettings: vi.fn() };
  const repositories = options.repositories ?? [repository];
  const targetAdd = options.targetAdd;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ProjectPicker mode={mode} workspace={workspace} repositories={repositories} open={open}
      onOpenChange={setOpen} refreshing={false} targetAdd={targetAdd} {...callbacks} />;
  }
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  return callbacks;
}

it('selects a revision-bound project and closes the menu', async () => {
  const callbacks = await mount();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('account-stream-rs');
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
  expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith('repo-history', 'revision-one', 'cargo-project');
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('supports keyboard opening, navigation and escape with restored focus', async () => {
  await mount();
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.activeElement?.tagName).toBe('SUMMARY');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(document.activeElement?.textContent).toContain('管理参考工程');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps target commands in the target menu and dismisses an outside click', async () => {
  const callbacks = await mount('target');
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('account-stream-rs');
  const browse = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('浏览本地项目'))!;
  await act(async () => browse.click());
  expect(callbacks.onAdd).toHaveBeenCalledExactlyOnceWith('browse');
  await act(async () => trigger.click());
  await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

/**
 * The menu closes before the native dialog opens, so progress must survive on
 * its own; otherwise a slow selection looks like a button that did nothing.
 */
it('shows the pending phase after the menu closed and blocks duplicate requests', async () => {
  await mount('target', { targetAdd: { status: 'pending', mode: 'browse', phase: 'attaching' } });
  const status = document.querySelector('.target-add-status');
  expect(status?.textContent).toContain('正在将目标目录加入工作区');
  expect(status?.querySelector('.is-spinning')).not.toBeNull();

  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const commands = [...document.querySelectorAll<HTMLButtonElement>('.workspace-picker-commands button')];
  expect(commands.length).toBe(3);
  expect(commands.every((command) => command.disabled)).toBe(true);
});

it('offers a retry that replays the entry point that failed', async () => {
  const callbacks = await mount('target', { targetAdd: {
    status: 'failed', mode: 'input', message: '目标目录不存在或不可访问，请检查路径。' } });
  const retry = document.querySelector<HTMLButtonElement>('.target-add-status button')!;
  expect(document.querySelector('.target-add-status')?.textContent).toContain('目标目录不存在');
  await act(async () => retry.click());
  expect(callbacks.onAdd).toHaveBeenCalledExactlyOnceWith('input');
});

it('renders a live index state for a target directory that has no projects yet', async () => {
  await mount('target', { repositories: [indexingRepository] });
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const row = [...document.querySelectorAll<HTMLButtonElement>('.workspace-picker-option')]
    .find((option) => option.textContent?.includes('正在建立索引'))!;
  expect(row).toBeDefined();
  expect(row.disabled).toBe(true);
  expect(row.querySelector('.is-spinning')).not.toBeNull();
});

it('groups multi-project repositories once and identifies projects by name and path', async () => {
  const multi = { ...repository, projects: [
    { ...repository.projects[0]!, projectId: 'core', displayName: 'Core', relativePath: 'packages/core' },
    { ...repository.projects[0]!, projectId: 'web', displayName: 'Web', relativePath: 'packages/web' },
  ] };
  await mount('history', { repositories: [multi, multi] });
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect(document.querySelectorAll('.workspace-picker-repository')).toHaveLength(1);
  const options = [...document.querySelectorAll('.workspace-picker-option')];
  expect(options.map(option => option.textContent)).toEqual(['Corepackages/core', 'Webpackages/web']);
  expect(document.querySelector('.workspace-picker-group')?.textContent).toContain('2 个子项目');
});

it('distinguishes collocated build types and identifies an empty build boundary', async () => {
  const multi = { ...repository, projects: [
    { ...repository.projects[0]!, projectId: 'maven', displayName: 'admin-ui', relativePath: 'apps/admin-ui', kind: 'maven',
      analysis: { repositoryId: repository.repositoryId, analysisRevision: 'revision-one', projectId: 'maven', analysisProfile: 'profile',
        state: 'ready' as const, projection: 'ready' as const, updatedAt: '', modelingSkippedReason: '工程没有独立文件，无需建模' } },
    { ...repository.projects[0]!, projectId: 'node', displayName: 'admin-ui', relativePath: 'apps/admin-ui', kind: 'node' },
  ] };
  const callbacks = await mount('history', { repositories: [multi] });
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(options.map(option => option.querySelector('strong')?.textContent)).toEqual(['admin-ui（Maven）', 'admin-ui（Node）']);
  expect(options[0]?.textContent).toContain('无独立文件');
  await act(async () => options[1]!.click());
  expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith(repository.repositoryId, 'revision-one', 'node');
});
