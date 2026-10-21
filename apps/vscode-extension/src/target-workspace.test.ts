// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  showOpenDialog: vi.fn(), showInputBox: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn(),
  update: vi.fn(), selectedPaths: [] as string[], workspacePaths: undefined as string[] | undefined,
  updateWorkspaceFolders: vi.fn(), folders: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
  onDidChangeWorkspaceFolders: vi.fn(), folderListeners: new Set<(event: { added: Array<{ uri: { scheme: string; fsPath: string } }> }) => void>(),
}));
vi.mock('vscode', () => ({
  window: api,
  workspace: { get workspaceFolders() { return api.folders; }, updateWorkspaceFolders: api.updateWorkspaceFolders,
    onDidChangeWorkspaceFolders: api.onDidChangeWorkspaceFolders,
    getConfiguration: () => ({ get: () => api.workspacePaths ?? api.selectedPaths,
      inspect: () => ({ globalValue: api.selectedPaths, workspaceValue: api.workspacePaths }), update: api.update }) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}));
import { addTargetWorkspace, pendingTargetImportKey, readPendingTargetImport, sameTargetPath, selectedTargetWorkspaceFolders } from './target-workspace';

let root: string;
const emitWorkspaceChange = (added = api.folders) => { for (const listener of api.folderListeners) listener({ added }); };
beforeEach(async () => {
  vi.resetAllMocks(); api.folders = []; api.selectedPaths = []; api.workspacePaths = undefined; api.folderListeners.clear();
  api.update.mockImplementation(async (_key, value, target) => {
    if (target === 2) api.workspacePaths = value;
    else api.selectedPaths = value;
  });
  api.onDidChangeWorkspaceFolders.mockImplementation((listener) => {
    api.folderListeners.add(listener);
    return { dispose: () => api.folderListeners.delete(listener) };
  });
  api.updateWorkspaceFolders.mockImplementation((start, deleteCount, ...folders) => {
    api.folders.splice(start, deleteCount, ...folders);
    emitWorkspaceChange();
    return true;
  });
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'forexplore-target-dir-')));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
  expect(api.folderListeners.size).toBe(0);
});

it('adds the directory selected in the native picker', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  expect(await addTargetWorkspace('browse')).toEqual({ status: 'attached', directory: root });
  expect(api.updateWorkspaceFolders).toHaveBeenCalledWith(0, 0, { uri: { scheme: 'file', fsPath: root } });
  expect(api.onDidChangeWorkspaceFolders.mock.invocationCallOrder[0])
    .toBeLessThan(api.updateWorkspaceFolders.mock.invocationCallOrder[0]!);
});

it('waits for durable task feedback before a workspace mutation can restart the host', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const onProgress = vi.fn(async (update: { phase: string; directory?: string }) => {
    if (update.phase === 'attaching') { expect(update.directory).toBe(root); await gate; }
  });
  const importing = addTargetWorkspace('browse', { onProgress });
  await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'attaching' })));
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
  release();
  expect((await importing).status).toBe('attached');
});

it('updates an empty workspace override so a remembered target is actually selected for indexing', async () => {
  const unrelated = path.join(root, 'other-project');
  api.selectedPaths = [unrelated];
  api.workspacePaths = [];
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  api.showInputBox.mockResolvedValue(root);
  expect(await addTargetWorkspace('input')).toEqual({ status: 'remembered', directory: root });
  expect(api.update).toHaveBeenCalledExactlyOnceWith('targetRepositoryPaths', [root], 2);
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
  expect(api.selectedPaths).toEqual([unrelated]);
});

it('keeps workspace targets when attaching another directory and restores that scope if attachment fails', async () => {
  const existing = path.join(root, 'old-project');
  api.workspacePaths = [existing];
  api.selectedPaths = ['global-project'];
  api.folders = [{ uri: { scheme: 'file', fsPath: existing } }];
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  api.updateWorkspaceFolders.mockReturnValue(false);
  await expect(addTargetWorkspace('browse')).rejects.toThrow('VS Code 未接受该目录');
  expect(api.update.mock.calls).toEqual([
    ['targetRepositoryPaths', [existing, root], 2],
    ['targetRepositoryPaths', [existing], 2],
  ]);
  expect(api.workspacePaths).toEqual([existing]);
  expect(api.selectedPaths).toEqual(['global-project']);
});

it('waits for the target in a multi-root workspace before scanning, ignoring unrelated events', async () => {
  const folder = (fsPath: string) => ({ uri: { scheme: 'file', fsPath } });
  const oldFolders = [folder(path.join(root, 'old-a')), folder(path.join(root, 'old-c'))];
  api.folders = [...oldFolders];
  api.selectedPaths = oldFolders.map(entry => entry.uri.fsPath);
  api.showInputBox.mockResolvedValue(root);
  api.updateWorkspaceFolders.mockImplementation((start, deleteCount, ...folders) => {
    api.folders.splice(start, deleteCount, ...folders);
    return true;
  });
  const scan = vi.fn();
  const importing = addTargetWorkspace('input').then(result => {
    scan(selectedTargetWorkspaceFolders());
    return result;
  });
  await vi.waitFor(() => expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce());
  expect(scan).not.toHaveBeenCalled();
  const unrelated = folder(path.join(root, 'unrelated'));
  api.folders.push(unrelated);
  emitWorkspaceChange([unrelated]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(scan).not.toHaveBeenCalled();
  expect(api.folderListeners.size).toBe(1);

  const target = folder(root);
  emitWorkspaceChange([target]);
  expect(await importing).toEqual({ status: 'attached', directory: root });
  expect(scan).toHaveBeenCalledExactlyOnceWith([...oldFolders, target]);
});

it('times out an unconfirmed optimistic update in an empty window', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  api.showInputBox.mockResolvedValue(root);
  api.updateWorkspaceFolders.mockImplementation((start, deleteCount, ...folders) => {
    api.folders = [...api.folders.slice(0, start), ...folders, ...api.folders.slice(start + deleteCount)];
    return true;
  });
  const importing = addTargetWorkspace('input');
  const failed = expect(importing).rejects.toThrow('没有打开任何文件夹');
  await vi.waitFor(() => expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(api.selectedPaths).toEqual([]);
});

it('cancels the wait without scanning or undoing an accepted workspace request', async () => {
  api.showInputBox.mockResolvedValue(root);
  api.updateWorkspaceFolders.mockReturnValue(true);
  const controller = new AbortController();
  const scan = vi.fn();
  const importing = addTargetWorkspace('input', { signal: controller.signal }).then(scan);
  const cancelled = expect(importing).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce());
  controller.abort();
  await cancelled;
  expect(api.folderListeners.size).toBe(0);
  expect(api.selectedPaths).toEqual([root]);
  api.folders.push({ uri: { scheme: 'file', fsPath: root } });
  emitWorkspaceChange();
  expect(scan).not.toHaveBeenCalled();
});

it('does not start selecting when the import is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(addTargetWorkspace('browse', { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(api.showOpenDialog).not.toHaveBeenCalled();
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

it('does not request a workspace change if cancelled while saving the selection', async () => {
  const controller = new AbortController();
  api.showInputBox.mockResolvedValue(root);
  api.update.mockImplementation(async (_key, value) => {
    api.selectedPaths = value;
    controller.abort();
  });
  await expect(addTargetWorkspace('input', { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

it('cleans up the listener when requesting the workspace update throws', async () => {
  api.showInputBox.mockResolvedValue(root);
  api.updateWorkspaceFolders.mockImplementation(() => { throw new Error('workspace unavailable'); });
  await expect(addTargetWorkspace('input')).rejects.toThrow('workspace unavailable');
});

it('accepts an entered path and prevents duplicate folders', async () => {
  api.showInputBox.mockResolvedValue(` ${root} `);
  await addTargetWorkspace('input');
  expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce();
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  expect(await addTargetWorkspace('input')).toEqual({ status: 'remembered', directory: root });
  expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce();
});

it('rejects files and nonexistent directories without changing the workspace', async () => {
  const file = path.join(root, 'file.txt');
  await writeFile(file, 'test');
  for (const value of [file, path.join(root, 'missing')]) {
    api.showInputBox.mockResolvedValue(value);
    await expect(addTargetWorkspace('input')).rejects.toThrow('目标目录');
  }
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

it('reports a cancelled picker as an outcome instead of a silent no-op', async () => {
  api.showOpenDialog.mockResolvedValue(undefined);
  expect(await addTargetWorkspace('browse')).toEqual({ status: 'cancelled' });
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
});

it('reports the phases a slow selection passes through', async () => {
  const phases: string[] = [];
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  await addTargetWorkspace('browse', { onProgress: (update) => { phases.push(update.phase); } });
  expect(phases).toEqual(['resolving', 'attaching']);
});

it('does not treat an open parent workspace as a selected target', async () => {
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  expect(selectedTargetWorkspaceFolders()).toEqual([]);
  api.showQuickPick.mockResolvedValue({ directory: root });
  expect(await addTargetWorkspace('workspace')).toEqual({ status: 'remembered', directory: root });
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
  expect(api.onDidChangeWorkspaceFolders).not.toHaveBeenCalled();
});

/**
 * A remembered selection is stored as a real path while VS Code keeps the
 * spelling it opened. Comparing a single form silently dropped the target, so
 * the folder stayed open but was never indexed.
 */
it('matches a remembered target through a directory link', async () => {
  const real = path.join(root, 'real-project');
  const link = path.join(root, 'linked-project');
  await mkdir(real);
  await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  api.selectedPaths = [await realpath(real)];
  api.folders = [{ uri: { scheme: 'file', fsPath: link } }];
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
  expect(sameTargetPath(await realpath(real), link)).toBe(true);
});

it('compares Windows targets case- and separator-insensitively', () => {
  const target = process.platform === 'win32' ? 'C:\\Projects\\Engine' : '/projects/engine';
  const equivalent = process.platform === 'win32' ? 'c:/projects/engine' : '/projects/engine/';
  expect(sameTargetPath(target, equivalent)).toBe(true);
  expect(sameTargetPath(target, `${equivalent}-other`)).toBe(false);
});

it('matches Windows and WSL spellings of the same repository', () => {
  expect(sameTargetPath('E:\\CS\\devsys\\weichai\\experiments\\enterprise-asset-upgrade\\target-project',
    '/mnt/e/cs/devsys/weichai/experiments/enterprise-asset-upgrade/target-project')).toBe(true);
});

/**
 * An empty or quoted-to-empty entry used to resolve to this process's working
 * directory, which is a real folder: the window then reported a target the user
 * never chose. Quoted entries are a paste, not a different directory.
 */
it('never matches an empty entry and accepts a quoted one', async () => {
  expect(sameTargetPath('', root)).toBe(false);
  expect(sameTargetPath('   ', root)).toBe(false);
  expect(sameTargetPath('""', root)).toBe(false);
  expect(sameTargetPath(`"${root}"`, root)).toBe(true);
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  api.selectedPaths = ['""', '   '];
  expect(selectedTargetWorkspaceFolders()).toEqual([]);
  api.selectedPaths = [`"${root}"`];
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
});

it('accepts a pasted quoted path in the input box and stores it unquoted', async () => {
  api.showInputBox.mockResolvedValue(`"${root}"`);
  expect(await addTargetWorkspace('input')).toEqual({ status: 'attached', directory: root });
  expect(api.selectedPaths).toEqual([root]);
});

it('rejects an emptied input box instead of resolving it to a directory', async () => {
  api.showInputBox.mockResolvedValue('""');
  await expect(addTargetWorkspace('input')).rejects.toThrow('绝对目录路径');
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
});

it('explains that an empty window cannot accept the folder', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  api.updateWorkspaceFolders.mockReturnValue(false);
  await expect(addTargetWorkspace('browse')).rejects.toThrow('没有打开任何文件夹');
  expect(api.selectedPaths).toEqual([]);
});

it('restores target selections when VS Code declines the workspace update', async () => {
  const other = await realpath(await mkdtemp(path.join(tmpdir(), 'forexplore-other-dir-')));
  try {
    api.folders = [{ uri: { scheme: 'file', fsPath: other } }];
    api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
    api.updateWorkspaceFolders.mockReturnValue(false);
    await expect(addTargetWorkspace('browse')).rejects.toThrow('VS Code 未接受该目录');
    expect(api.selectedPaths).toEqual([]);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

/**
 * A workspace change can restart the extension host in the middle of an
 * import, so the recorded intent decides whether the surviving host finishes
 * the job instead of leaving the panel on a progress state forever.
 */
it('resumes a recent interrupted target import', () => {
  const now = Date.parse('2026-09-14T17:13:18.000Z');
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'browse' }, now))
    .toEqual({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'browse' });
});

it('keeps pending imports in the originating window across host restarts', () => {
  const state = new Map([[pendingTargetImportKey('window-a'), { requestedAt: new Date().toISOString(), mode: 'browse' }]]);
  expect(readPendingTargetImport(state.get(pendingTargetImportKey('window-a')))).toBeDefined();
  expect(readPendingTargetImport(state.get(pendingTargetImportKey('window-b')))).toBeUndefined();
});

it('ignores a stale, malformed or future-dated import intent', () => {
  const now = Date.parse('2026-09-14T17:13:18.000Z');
  expect(readPendingTargetImport(undefined, now)).toBeUndefined();
  expect(readPendingTargetImport('browse', now)).toBeUndefined();
  expect(readPendingTargetImport({ mode: 'browse' }, now)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: 'not-a-date', mode: 'browse' }, now)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'elsewhere' }, now)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'browse' }, now, 1000)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:20:00.000Z', mode: 'browse' }, now)).toBeUndefined();
});
