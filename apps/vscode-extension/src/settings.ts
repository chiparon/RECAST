import {
  DEFAULT_LLM_SETTINGS,
  normaliseConfiguredPath,
  normaliseConfiguredPaths,
  parseLlmSettings,
  type LlmSettings,
} from '@forexplore/contracts';
import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';
import {
  parseModuleWaveValidationCommands,
  type ModuleWaveValidationCommand,
} from './module-wave-validation';
import path from 'node:path';

export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';

function adaptationEndpoint(config: vscode.WorkspaceConfiguration): string {
  const configured = normaliseConfiguredPath(config.get<string>('adaptationApiUrl', DEFAULT_ADAPTATION_API_URL));
  const inspected = config.inspect<string>('adaptationApiUrl');
  const explicit = inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined ||
    inspected?.globalValue !== undefined;
  if (explicit || configured !== DEFAULT_ADAPTATION_API_URL) return configured ?? DEFAULT_ADAPTATION_API_URL;
  const value = process.env.ADAPTATION_PORT?.trim();
  if (!value) return DEFAULT_ADAPTATION_API_URL;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADAPTATION_PORT must be a valid TCP port (1–65535).');
  return `http://127.0.0.1:${port}`;
}

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  topK: number;
  adaptationApiUrl: string;
  llm: LlmSettings;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  return {
    executionMode: 'real',
    llm: parseLlmSettings(config.inspect<LlmSettings>('llm')?.globalValue ?? DEFAULT_LLM_SETTINGS),
    // A hand-written array can hold quoted or empty entries; an empty one would
    // otherwise resolve to this extension host's working directory. The dataset's
    // portable workspace file also uses ${workspaceFolder}, which VS Code does not
    // expand for every configuration shape, so the host expands it here.
    repositoryPaths: resolveWorkspaceConfiguredPaths(config.get<unknown[]>('repositoryPaths', [])),
    topK: boundedTopK(config.get<number>('topK', 4)),
    adaptationApiUrl: adaptationEndpoint(config),
  };
}

export async function savePanelSettings(input: {
  repositoryPaths: string[];
  topK: number;
  llm?: LlmSettings;
}): Promise<Pick<ExtensionSettings, 'repositoryPaths' | 'topK' | 'llm'>> {
  const llm = parseLlmSettings(input.llm ?? loadSettings().llm);
  // Saved values are stored unquoted so the settings file stays the same shape a
  // hand-written one takes, and so the next read cannot see a literal path.
  const repositoryPaths = normaliseConfiguredPaths(input.repositoryPaths);
  const topK = boundedTopK(input.topK);
  const config = vscode.workspace.getConfiguration('forexplore');
  // Update an existing workspace override so the newly saved value actually takes effect.
  const target = (key: string) => config.inspect(key)?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update('repositoryPaths', repositoryPaths, target('repositoryPaths'));
  await config.update('topK', topK, target('topK'));
  await config.update('llm', llm, vscode.ConfigurationTarget.Global);
  return { repositoryPaths, topK, llm };
}

function boundedTopK(value: number): number {
  if (!Number.isInteger(value)) return 4;
  return Math.min(10, Math.max(1, value));
}

/**
 * Resolve the VS Code workspace-folder variable used by the dataset's
 * portable `.code-workspace` file. VS Code does not expand this variable for
 * every extension configuration shape, especially arrays, so the host keeps
 * the expansion deterministic and local to path settings.
 */
export function resolveWorkspaceConfiguredPath(value: string): string | undefined {
  const configured = normaliseConfiguredPath(value);
  if (configured === undefined) return undefined;
  const match = /^\$\{workspaceFolder(?::([^}]+))?\}(.*)$/.exec(configured);
  if (!match) return resolvePlatformConfiguredPath(configured);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = match[1]
    ? folders.find((candidate) => candidate.name === match[1])
    : folders[0];
  if (!folder || folder.uri.scheme !== 'file') return undefined;
  const suffix = match[2] ?? '';
  return path.resolve(folder.uri.fsPath, suffix.replace(/^[/\\]+/, ''));
}

/** VS Code user settings are shared with Remote WSL; drive paths need mounting. */
export function resolvePlatformConfiguredPath(value: string, platform: NodeJS.Platform = process.platform,
  wsl = Boolean(process.env.WSL_DISTRO_NAME)): string {
  if (platform === 'win32') {
    const mounted = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(value);
    if (mounted) return `${mounted[1]!.toUpperCase()}:/${mounted[2]}`;
  }
  if (platform !== 'win32' && wsl && /^[A-Za-z]:[/\\]/.test(value)) {
    return `/mnt/${value[0]!.toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}`;
  }
  return value;
}

export function resolveWorkspaceConfiguredPaths(values: readonly unknown[]): string[] {
  const resolved = values
    .map((value) => typeof value === 'string' ? resolveWorkspaceConfiguredPath(value) : undefined)
    .filter((value): value is string => value !== undefined);
  return normaliseConfiguredPaths(resolved);
}

/**
 * Read validation commands only from user settings. Workspace settings are
 * repository-controlled and must never become executable host configuration.
 */
export function loadModuleWaveValidationCommands(): ModuleWaveValidationCommand[] {
  const config = vscode.workspace.getConfiguration('forexplore');
  const setting = config.inspect<unknown>('moduleWaveValidationCommands');
  if (
    setting?.workspaceValue !== undefined ||
    setting?.workspaceFolderValue !== undefined ||
    setting?.workspaceLanguageValue !== undefined ||
    setting?.workspaceFolderLanguageValue !== undefined
  ) {
    throw new Error('forexplore.moduleWaveValidationCommands 只能在用户设置中配置，不能由工作区设置提供。');
  }
  return parseModuleWaveValidationCommands(setting?.globalValue ?? []);
}
