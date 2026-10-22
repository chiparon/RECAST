import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS, LLM_PRESETS } from '@forexplore/contracts';
import { isWebviewToHostMessage } from '../../../src/protocol/messages';
import { SettingsPanel } from './SettingsPanel';

let unmount: (() => void) | undefined;
afterEach(() => { if (unmount) act(unmount); document.body.innerHTML = ''; });

it('keeps failed key drafts for retry, clears them on provider changes/success, and stages deletion', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); unmount = () => root.unmount();
  const save = vi.fn();
  const props = { llm: DEFAULT_LLM_SETTINGS, topK: 4, repositoryPaths: [], repositoryStatuses: [],
    modelKeyStatus: { configured: true }, onCheckRepositories: vi.fn(), onSelectCodeIntelligenceProject: vi.fn(),
    onSave: save, onCancel: vi.fn() };
  await act(async () => root.render(<SettingsPanel {...props} saving={false} />));
  const input = container.querySelector<HTMLInputElement>('[aria-label="API Key"]')!;
  expect(input.type).toBe('password');
  expect(input.value).toMatch(/^•+$/);
  expect(container.querySelector('#model-key-state')?.textContent).toContain('已配置');
  await act(async () => window.dispatchEvent(new Event('recast-save-settings')));
  expect(save).toHaveBeenLastCalledWith(expect.any(Object));
  expect(save.mock.calls[0]).toHaveLength(1); // The display mask must never replace the saved secret.
  save.mockClear();
  const enter = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await enter('invalid key');
  await act(async () => window.dispatchEvent(new Event('recast-save-settings')));
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await enter('test-key');
  await act(async () => window.dispatchEvent(new Event('recast-save-settings')));
  expect(save).toHaveBeenLastCalledWith(expect.any(Object), 'test-key');
  await act(async () => root.render(<SettingsPanel {...props} saving={true} />));
  await act(async () => root.render(<SettingsPanel {...props} saving={false} />));
  expect(input.value).toBe('test-key');
  await act(async () => root.render(<SettingsPanel {...props} llm={{ ...DEFAULT_LLM_SETTINGS }} saving={false} />));
  expect(input.value).toMatch(/^•+$/);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="清除保存的 Key"]')!.click());
  expect(input.placeholder).toBe('无');
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event('recast-save-settings')));
  expect(save).toHaveBeenLastCalledWith(expect.any(Object), null);
  await enter('must-not-follow-provider');
  await act(async () => {
    const provider = container.querySelector<HTMLSelectElement>('[aria-label="AI 服务商"]')!;
    provider.value = 'openai'; provider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('无');
  expect(input.disabled).toBe(false);
});

it('browses into an unsaved draft, preserves cancellation, and saves provider/model/token together', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); unmount = () => root.unmount();
  const save = vi.fn();
  const browse = vi.fn().mockResolvedValueOnce(['D:/Legacy', 'D:/Added']).mockResolvedValueOnce([]);
  await act(async () => root.render(<SettingsPanel llm={DEFAULT_LLM_SETTINGS} topK={4} repositoryPaths={['D:/Legacy']} repositoryStatuses={[]} saving={false}
    onCheckRepositories={vi.fn()} onSelectCodeIntelligenceProject={vi.fn()}
    onBrowseReferenceFolders={browse} onSave={save} onCancel={vi.fn()} />));
  const clickBrowse = () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('浏览文件夹'))!.click();
  await act(async () => clickBrowse());
  expect([...container.querySelectorAll<HTMLInputElement>('.repository-path-fields input')].map(i => i.value)).toEqual(['D:/Legacy', 'D:/Added']);
  await act(async () => clickBrowse());
  expect(container.querySelectorAll('.repository-path-fields input')).toHaveLength(2);
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="API Base URL"]')).toBeNull();
  expect(container.querySelector('[aria-label="AI 服务"] .model-key-section')).not.toBeNull();
  for (const [label, value] of [['AI 服务商', 'anthropic'], ['每次最大输出 Token', '4096']]) {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      select.value = value!; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  expect(container.querySelector<HTMLInputElement>('[aria-label="模型名称"]')!.value).toBe(LLM_PRESETS.anthropic.model);
  expect(container.querySelector('[aria-label="API Base URL"]')).toBeNull();
  expect(container.querySelector('.model-key-section')!.getAttribute('aria-label')).toBe('Anthropic / Claude API Key');
  expect(container.querySelector('.model-key-section')!.textContent).not.toContain('DeepSeek');
  const keyInput = container.querySelector<HTMLInputElement>('[aria-label="API Key"]')!;
  expect(keyInput.disabled).toBe(false);
  expect(keyInput.placeholder).toBe('无');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(keyInput, 'test-claude-key');
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(save).not.toHaveBeenCalled();
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith({ topK: 4, repositoryPaths: ['D:/Legacy', 'D:/Added'], llm: {
    provider: 'anthropic', model: LLM_PRESETS.anthropic.model, apiBase: LLM_PRESETS.anthropic.apiBase, maxOutputTokens: 4096,
  } }, 'test-claude-key');
  expect(isWebviewToHostMessage({ type: 'SAVE_SETTINGS', settings: save.mock.calls[0]![0] })).toBe(true);
  expect(isWebviewToHostMessage({ type: 'SAVE_SETTINGS', settings: { ...save.mock.calls[0]![0], llm: { ...DEFAULT_LLM_SETTINGS, apiKey: 'secret' } } })).toBe(false);
  expect(isWebviewToHostMessage({ type: 'BROWSE_REFERENCE_FOLDERS', requestId: 'picker-1', paths: ['untrusted'] })).toBe(false);
});

it('saves the latest draft with Ctrl+S or the IDE command and keeps validation and pending guards', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); unmount = () => root.unmount();
  const save = vi.fn();
  const props = { llm: DEFAULT_LLM_SETTINGS, topK: 4, repositoryPaths: [], repositoryStatuses: [],
    onCheckRepositories: vi.fn(), onSelectCodeIntelligenceProject: vi.fn(), onSelectCodeIntelligenceRevision: vi.fn(),
    onSave: save, onCancel: vi.fn() };
  await act(async () => root.render(<SettingsPanel {...props} saving={false} />));
  const model = container.querySelector<HTMLInputElement>('[aria-label="模型名称"]')!;
  const setModel = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(model, value);
    model.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const key = (extra: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true, ...extra });
  await setModel('custom-model');
  const shortcut = key();
  await act(async () => model.dispatchEvent(shortcut));
  expect(shortcut.defaultPrevented).toBe(true);
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ llm: expect.objectContaining({ model: 'custom-model' }) }));
  await act(async () => window.dispatchEvent(key({ repeat: true })));
  expect(save).toHaveBeenCalledTimes(1);
  await setModel('');
  await act(async () => window.dispatchEvent(key()));
  expect(save).toHaveBeenCalledTimes(1);
  await setModel('another-model');
  await act(async () => window.dispatchEvent(new Event('recast-save-settings')));
  expect(save).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<SettingsPanel {...props} saving={true} />));
  await act(async () => window.dispatchEvent(key()));
  await act(async () => window.dispatchEvent(new Event('recast-save-settings')));
  expect(save).toHaveBeenCalledTimes(2);
  act(() => root.unmount()); unmount = undefined;
  const afterClose = key(); window.dispatchEvent(afterClose);
  expect(afterClose.defaultPrevented).toBe(false);
});

it('shows URL only for custom interfaces or an existing nonstandard endpoint', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); unmount = () => root.unmount();
  const props = { topK: 4, repositoryPaths: [], repositoryStatuses: [], saving: false,
    onCheckRepositories: vi.fn(), onSelectCodeIntelligenceProject: vi.fn(), onSave: vi.fn(), onCancel: vi.fn() };
  await act(async () => root.render(<SettingsPanel {...props} llm={{ ...DEFAULT_LLM_SETTINGS, apiBase: 'https://proxy.example/v1' }} />));
  expect(container.querySelector<HTMLInputElement>('[aria-label="API Base URL"]')!.value).toBe('https://proxy.example/v1');
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="AI 服务商"]')!;
    select.value = 'openai'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('[aria-label="API Base URL"]')).toBeNull();
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="AI 服务商"]')!;
    select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector<HTMLInputElement>('[aria-label="API Base URL"]')!.value).toBe(LLM_PRESETS.custom.apiBase);
});
