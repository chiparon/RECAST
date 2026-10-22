import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { normaliseConfiguredPath, normaliseConfiguredPaths } from '@forexplore/contracts';
import { platformLocalPath } from '../../../services/code-intelligence-service/src/platform-path';
import type { TargetWorkspaceAddMode, TargetWorkspacePhase } from './protocol/messages';
import { resolveWorkspaceConfiguredPaths } from './settings';

/** Phases this module can observe while applying an explicit directory choice. */
export type TargetWorkspaceProgressPhase = Extract<TargetWorkspacePhase, 'resolving' | 'attaching'>;

export interface TargetWorkspaceProgress {
  phase: TargetWorkspaceProgressPhase;
  message: string;
  directory?: string;
}

/**
 * A cancelled picker and an applied choice are different outcomes: only the
 * caller can tell the user which one happened, so both are reported here
 * instead of collapsing into `undefined`.
 */
export type TargetWorkspaceAddResult =
  | { status: 'cancelled' }
  /** The directory was already an open workspace folder and is now remembered. */
  | { status: 'remembered'; directory: string }
  /** The directory is now an open workspace folder. */
  | { status: 'attached'; directory: string };

/** Recorded before a workspace mutation that can restart this extension host. */
export interface PendingTargetImport {
  requestedAt: string;
  mode: TargetWorkspaceAddMode;
  taskId?: string;
  taskJournalKey?: string;
}

// sessionId survives an extension-host restart and is distinct for each window.
export const pendingTargetImportKey = (sessionId: string) => `forexplore.pendingTargetImport.${sessionId}`;
const pendingTargetImportMaxAgeMs = 30 * 60_000;

/**
 * Adding a workspace folder can terminate this extension host, which kills the
 * import half-way and leaves the panel with a progress state nobody will ever
 * finish. The intent is persisted before the mutation, and this decides whether
 * a later activation should resume it. A stale marker is ignored so an
 * abandoned import never re-runs hours later.
 */
export function readPendingTargetImport(
  value: unknown,
  now: number = Date.now(),
  maxAgeMs: number = pendingTargetImportMaxAgeMs,
): PendingTargetImport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.requestedAt !== 'string' || typeof record.mode !== 'string') return undefined;
  if (!['browse', 'input', 'workspace'].includes(record.mode)) return undefined;
  const requestedAt = Date.parse(record.requestedAt);
  if (!Number.isFinite(requestedAt) || requestedAt > now || now - requestedAt > maxAgeMs) return undefined;
  return { requestedAt: record.requestedAt, mode: record.mode as TargetWorkspaceAddMode,
    ...(typeof record.taskId === 'string' && /^[a-f0-9-]{36}$/.test(record.taskId) ? { taskId: record.taskId } : {}),
    ...(typeof record.taskJournalKey === 'string' && /^forexplore\.targetImportTasks\.[a-f0-9]{64}$/.test(record.taskJournalKey)
      ? { taskJournalKey: record.taskJournalKey } : {}) };
}

/**
 * Every path form that may legitimately denote the same directory. A remembered
 * selection is persisted as a real path while `WorkspaceFolder.uri.fsPath`
 * keeps whatever spelling VS Code opened (a junction, a short name or a
 * differently cased drive), so comparing one single form silently drops an
 * explicitly selected target.
 */
function targetPathKeys(value: string): string[] {
  const keys = new Set<string>();
  // An empty or quoted-to-empty entry denotes nothing; resolving it would name
  // this process's working directory and silently match a real workspace folder.
  const configured = normaliseConfiguredPath(value);
  if (configured === undefined) return [];
  const add = (candidate: string) => {
    const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
    // `/mnt/<drive>/...` is a Windows filesystem path when seen from WSL,
    // whose mount remains case-insensitive even though the host process is
    // Linux. Treat it like a drive-letter path for comparison purposes.
    const windowsFilesystemPath = /^[A-Za-z]:\//.test(normalizedCandidate) ||
      /^\/mnt\/[A-Za-z](?:\/|$)/.test(normalizedCandidate);
    const normalized = process.platform === 'win32' || windowsFilesystemPath
      ? normalizedCandidate.toLowerCase()
      : normalizedCandidate;
    keys.add(normalized);
  };

  // A persisted repository row can have been written by the other platform:
  // Windows stores `E:\\...`, while WSL stores `/mnt/e/...`. Translate the
  // spelling before resolving it locally so both forms produce the same key.
  // Keep the raw spelling too because a path may not exist on this machine
  // when it is only being compared with another persisted value.
  add(configured);
  const candidates = new Set([configured, platformLocalPath(configured)]);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    add(resolved);
    try {
      add(realpathSync(resolved));
    } catch {
      // An unreachable entry keeps its resolved form; an unusable directory is
      // reported separately when it is the newly chosen one.
    }
  }
  return [...keys];
}

export function sameTargetPath(left: string, right: string): boolean {
  const leftKeys = targetPathKeys(left);
  return targetPathKeys(right).some((key) => leftKeys.includes(key));
}

export function selectedTargetWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  // Quoted and empty entries are decoration or noise: they must never widen the
  // match against real workspace folders.
  const selected = resolveWorkspaceConfiguredPaths(
    vscode.workspace.getConfiguration('forexplore').get<unknown[]>('targetRepositoryPaths', []),
  );
  if (selected.length === 0) return [];
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
  const targets: vscode.WorkspaceFolder[] = [];
  for (const entry of selected) {
    const exact = folders.find((folder) => sameTargetPath(entry, folder.uri.fsPath));
    if (exact) { targets.push(exact); continue; }
    // An explicitly configured project inside an open workspace is a valid
    // target. Keep its own root, so the surrounding repository is never indexed
    // or used as the write-back scope.
    let targetRoot: string;
    try { targetRoot = realpathSync(entry); } catch { continue; }
    const parent = folders.find((folder) => {
      let workspaceRoot: string;
      try { workspaceRoot = realpathSync(folder.uri.fsPath); } catch { return false; }
      const relative = path.relative(workspaceRoot, targetRoot);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (parent && !targets.some((folder) => sameTargetPath(folder.uri.fsPath, targetRoot))) {
      targets.push({ uri: vscode.Uri.file(targetRoot), name: path.basename(targetRoot), index: parent.index });
    }
  }
  return targets;
}

/** `updateWorkspaceFolders` only starts the update; wait for the actual folder. */
function attachWorkspaceFolder(directory: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      subscription?.dispose();
      signal?.removeEventListener('abort', cancel);
    };
    const finish = (attached: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(attached);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(signal?.reason);
    const isAttached = () => (vscode.workspace.workspaceFolders ?? []).some((folder) =>
      folder.uri.scheme === 'file' && sameTargetPath(folder.uri.fsPath, directory));
    const changed = (event: vscode.WorkspaceFoldersChangeEvent) => {
      if (event.added.some(folder => folder.uri.scheme === 'file' && sameTargetPath(folder.uri.fsPath, directory))) finish(true);
    };
    // Subscribe before requesting the mutation so even an immediate event is
    // observed. A host restart instead resumes the persisted import intent.
    subscription = vscode.workspace.onDidChangeWorkspaceFolders(changed);
    signal?.addEventListener('abort', cancel, { once: true });
    // A declined asynchronous update may never emit a folder event. Bound the
    // wait even in an empty window, where an accepted update restarts the host.
    timer = setTimeout(() => finish(false), 30_000);
    try {
      signal?.throwIfAborted();
      if (isAttached()) {
        finish(true);
      } else if (!vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(directory) },
      )) {
        finish(false);
      }
    } catch (error) {
      fail(error);
    }
  });
}

export async function addTargetWorkspace(
  mode: TargetWorkspaceAddMode,
  options: { signal?: AbortSignal; onProgress?(progress: TargetWorkspaceProgress): void | Promise<void> } = {},
): Promise<TargetWorkspaceAddResult> {
  options.signal?.throwIfAborted();
  let picked: string | undefined;
  if (mode === 'workspace') {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
    const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name, description: folder.uri.fsPath, directory: folder.uri.fsPath,
    })), { title: '选择目标工程', placeHolder: '选择已打开的工程目录' });
    picked = selected?.directory;
  } else if (mode === 'browse') {
    const selected = await vscode.window.showOpenDialog({
      title: '添加目标工程', openLabel: '添加目标目录',
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    });
    picked = selected?.[0]?.fsPath;
  } else {
    picked = await vscode.window.showInputBox({
      title: '添加目标工程', prompt: '目标工程的绝对目录路径',
      ignoreFocusOut: true,
      // A pasted "Copy as path" value is quoted; accept it here as well as after.
      validateInput: (value) => {
        const entered = normaliseConfiguredPath(value);
        return entered !== undefined && path.isAbsolute(entered) ? undefined : '请输入绝对目录路径';
      },
    });
  }
  options.signal?.throwIfAborted();
  if (picked === undefined) return { status: 'cancelled' };
  const directory = normaliseConfiguredPath(picked);
  if (directory === undefined || !path.isAbsolute(directory)) throw new Error('请输入目标工程的绝对目录路径。');
  await options.onProgress?.({ phase: 'resolving', message: '正在校验目标目录…', directory });
  let resolved: string;
  try {
    resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
  } catch {
    options.signal?.throwIfAborted();
    throw new Error('目标目录不存在或不可访问，请检查路径。');
  }
  options.signal?.throwIfAborted();
  const config = vscode.workspace.getConfiguration('forexplore');
  // An explicit workspace value (including []) overrides user settings. Save
  // the choice at that level so the next synchronization actually sees it.
  const configurationTarget = config.inspect('targetRepositoryPaths')?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  // Read the existing selection through the same normalisation that decides the
  // match, so a quoted duplicate is recognised instead of being appended twice.
  const previous = normaliseConfiguredPaths(config.get<unknown[]>('targetRepositoryPaths', []));
  const previousResolved = resolveWorkspaceConfiguredPaths(previous);
  const remember = async (workspacePath = resolved) => {
    if (!previousResolved.some((entry) => sameTargetPath(entry, workspacePath))) {
      await config.update('targetRepositoryPaths', [...previous, workspacePath], configurationTarget);
    }
  };
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') continue;
    if (sameTargetPath(folder.uri.fsPath, resolved)) {
      await remember(folder.uri.fsPath);
      options.signal?.throwIfAborted();
      return { status: 'remembered', directory: resolved };
    }
  }
  await options.onProgress?.({ phase: 'attaching', message: '正在将目标目录加入工作区…', directory: resolved });
  // Selecting the first folder can restart the extension host. Persist the
  // explicit choice before asking VS Code to change the workspace.
  await remember();
  options.signal?.throwIfAborted();
  if (!await attachWorkspaceFolder(resolved, options.signal)) {
    await config.update('targetRepositoryPaths', previous, configurationTarget);
    // An empty window has no workspace to splice a folder into, which is a
    // permanent condition rather than a transient one.
    throw new Error(folders.length === 0
      ? '当前窗口没有打开任何文件夹，VS Code 无法把该目录加入工作区；请先打开或保存一个工作区后再重试。'
      : 'VS Code 未接受该目录（工作区更新被取消或尚未就绪）；请稍后重试，或先手动把该目录添加到工作区。');
  }
  options.signal?.throwIfAborted();
  return { status: 'attached', directory: resolved };
}
