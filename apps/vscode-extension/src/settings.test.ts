// @vitest-environment node
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS, normaliseConfiguredPaths } from '@forexplore/contracts';
const config = vi.hoisted(() => ({ get: vi.fn((_key: string, fallback: unknown) => fallback), inspect: vi.fn(), update: vi.fn() }));
const workspaceFolders = vi.hoisted(() => [] as Array<{ name: string; uri: { scheme: string; fsPath: string } }>);
vi.mock('vscode', () => ({ workspace: {
  getConfiguration: () => config,
  get workspaceFolders() { return workspaceFolders; },
}, ConfigurationTarget: { Global: 1, Workspace: 2 } }));
import { loadSettings, resolvePlatformConfiguredPath, resolveWorkspaceConfiguredPath, savePanelSettings } from './settings';

it('resolves shared Windows drive paths only when running under WSL', () => {
  const windows = 'E:\\Code Projects\\history';
  expect(resolvePlatformConfiguredPath(windows, 'linux', true)).toBe('/mnt/e/Code Projects/history');
  expect(resolvePlatformConfiguredPath(windows, 'win32', true)).toBe(windows);
  expect(resolvePlatformConfiguredPath(windows, 'linux', false)).toBe(windows);
  expect(resolvePlatformConfiguredPath('/home/team/history', 'linux', true)).toBe('/home/team/history');
  expect(resolvePlatformConfiguredPath('/mnt/e/Code Projects/history', 'win32', false)).toBe('E:/Code Projects/history');
});

afterEach(() => {
  vi.unstubAllEnvs();
  config.get.mockImplementation((_key: string, fallback: unknown) => fallback);
  config.inspect.mockReset();
  config.update.mockClear();
});

describe('AI user settings', () => {
  it('uses the environment port only when no explicit endpoint is configured', () => {
    vi.stubEnv('ADAPTATION_PORT', '9134');
    expect(loadSettings().adaptationApiUrl).toBe('http://127.0.0.1:9134');
    config.inspect.mockImplementation(key => key === 'adaptationApiUrl'
      ? { globalValue: 'http://127.0.0.1:8788' } : undefined);
    expect(loadSettings().adaptationApiUrl).toBe('http://127.0.0.1:8788');
    config.inspect.mockReset();
    config.get.mockImplementation((key, fallback) => key === 'adaptationApiUrl' ? 'http://127.0.0.1:9234' : fallback);
    expect(loadSettings().adaptationApiUrl).toBe('http://127.0.0.1:9234');
  });

  it('updates existing repository workspace overrides while keeping model configuration user-scoped', async () => {
    config.inspect.mockImplementation((key: string) => key === 'repositoryPaths' ? { workspaceValue: [] } : undefined);
    await savePanelSettings({ repositoryPaths: ['D:/Picked'], topK: 4, llm: DEFAULT_LLM_SETTINGS });
    expect(config.update).toHaveBeenCalledWith('repositoryPaths', ['D:/Picked'], 2);
    expect(config.update).toHaveBeenCalledWith('llm', DEFAULT_LLM_SETTINGS, 1);
  });
  it('ignores repository-controlled API endpoints and round-trips trusted user settings', async () => {
    const llm = { ...DEFAULT_LLM_SETTINGS, maxOutputTokens: 2048 };
    config.inspect.mockReturnValue({ workspaceValue: { ...llm, apiBase: 'https://untrusted.example' } });
    expect(loadSettings().llm).toEqual(DEFAULT_LLM_SETTINGS);
    config.inspect.mockReturnValue({ globalValue: llm });
    expect(loadSettings().llm).toEqual(llm);
    expect(await savePanelSettings({ repositoryPaths: [' D:/reference ', 'D:/reference'], topK: 6, llm }))
      .toEqual({ repositoryPaths: ['D:/reference'], topK: 6, llm });
    expect(config.update).toHaveBeenCalledWith('llm', llm, 1);
    config.update.mockClear();
    await expect(savePanelSettings({ repositoryPaths: [], topK: 4, llm: { ...llm, maxOutputTokens: 0 } })).rejects.toThrow();
    expect(config.update).not.toHaveBeenCalled();
  });

  it('stores pasted paths without their quotes and drops empty entries', async () => {
    // Windows' "Copy as path" wraps the value in double quotes, and a cleared row
    // arrives as an empty string; neither denotes a directory the user chose.
    expect(normaliseConfiguredPaths(['  "D:/reference"  ', '""', '   ', "'D:/other'", 'D:/reference']))
      .toEqual(['D:/reference', 'D:/other']);
    const saved = await savePanelSettings({ repositoryPaths: ['"D:/reference"', ''], topK: 4 });
    expect(saved.repositoryPaths).toEqual(['D:/reference']);
    expect(config.update).toHaveBeenCalledWith('repositoryPaths', ['D:/reference'], expect.anything());
  });

  it('reads quoted and empty settings entries as the directories they denote', () => {
    vi.stubEnv('WSL_DISTRO_NAME', ''); // Path mounting is covered separately above.
    config.get.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'repositoryPaths') return ['"D:/reference"', '', '   '];
      if (key === 'adaptationApiUrl') return ' "http://127.0.0.1:9999" ';
      return fallback;
    });
    const settings = loadSettings();
    // An empty entry must never resolve to the extension host's own directory.
    expect(settings.repositoryPaths).toEqual(['D:/reference']);
    expect(settings.adaptationApiUrl).toBe('http://127.0.0.1:9999');
    config.get.mockImplementation((_key: string, fallback: unknown) => fallback);
  });

  it('expands named workspace folders in array settings', () => {
    workspaceFolders.push({ name: 'asset-upgrade-target', uri: { scheme: 'file', fsPath: '/datasets/asset-upgrade/target-project' } });
    // The helper resolves against the real filesystem, so the expectation has to be
    // resolved the same way: on Windows a rooted POSIX value becomes E:\datasets\...
    const expected = path.resolve('/datasets/asset-upgrade/target-project', 'src');
    expect(resolveWorkspaceConfiguredPath('${workspaceFolder:asset-upgrade-target}/src')).toBe(expected);
    config.get.mockImplementation((key: string, fallback: unknown) => key === 'repositoryPaths'
      ? ['${workspaceFolder:asset-upgrade-target}/src'] : fallback);
    expect(loadSettings().repositoryPaths).toEqual([expected]);
    workspaceFolders.length = 0;
    config.get.mockImplementation((_key: string, fallback: unknown) => fallback);
  });
});
