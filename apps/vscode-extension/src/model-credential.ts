import { DEFAULT_LLM_SETTINGS, LLM_PRESETS, parseLlmSettings, type LlmSettings } from '@forexplore/contracts';

export interface ModelRequestContext { apiKey?: string; settings: LlmSettings }
export interface CredentialStorage {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export function modelCredentialId(endpoint: string, settings?: LlmSettings): string {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('API Key 设置仅支持本地 AI 后端，请检查 forexplore.adaptationApiUrl。');
  }
  const model = settings ? parseLlmSettings(settings) : undefined;
  const suffix = !model || (model.provider === 'deepseek' && model.apiBase === DEFAULT_LLM_SETTINGS.apiBase)
    ? '' : `:${model.provider}:${model.apiBase}`;
  return `recast.modelKey:${url.origin}${suffix}`;
}

/** Endpoint is supplied by the trusted host, never by a Webview message. */
export function createModelCredentialProvider(storage: CredentialStorage, endpoint: () => string, settings?: () => LlmSettings,
  runtimeEndpoint: () => string = endpoint,
  fallbackApiKey?: () => string | undefined) {
  return async (url: URL): Promise<string | ModelRequestContext | undefined> => {
    const configured = endpoint();
    const model = settings ? parseLlmSettings(settings()) : undefined;
    let id: string;
    try { id = modelCredentialId(configured, model); } catch { return undefined; }
    const base = new URL(runtimeEndpoint());
    const prefix = base.pathname.replace(/\/+$/, '');
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(`${prefix}/`)) return undefined;
    const route = url.pathname.slice(prefix.length);
    if (!/^\/(?:module-hierarchy\/decision|v1\/(?:retrieval-rerank|adapt|module-plan|semantic-module-plan|module-generation\/turn|workspace-translations(?:\/[a-f0-9-]{36}(?:\/(?:resume|cancel|rollback))?)?))$/.test(route)) return undefined;
    const apiKey = (await storage.get(id))?.trim() || fallbackApiKey?.()?.trim();
    return model ? { settings: model, ...(apiKey ? { apiKey } : {}) } : apiKey;
  };
}

export function validateModelKey(value: string): string | undefined {
  return /^[\x21-\x7e]{1,512}$/.test(value.trim()) ? undefined : '请输入有效 API Key（不能含空格或换行）。';
}

/**
 * Module analysis is the only code-intelligence step that calls a model, so it is
 * refused outright while the selected provider has no stored API key. Indexing,
 * symbols and source search never need this credential and stay available.
 *
 * Returns the refusal reason, or `undefined` when the model is configured.
 */
export async function modelKeyRefusalReason(
  storage: CredentialStorage, endpoint: string, settings: LlmSettings,
  fallbackApiKey?: () => string | undefined,
): Promise<string | undefined> {
  let id: string;
  try {
    id = modelCredentialId(endpoint, settings);
  } catch {
    return '模块解析需要先在设置中把 AI 后端地址配置为本机地址（forexplore.adaptationApiUrl）。';
  }
  let stored: string | undefined;
  try {
    stored = await storage.get(id);
  } catch {
    return '无法读取本机凭据存储中的 API Key，已停止模块解析；请在设置中重新配置 API Key。';
  }
  if (stored?.trim() || fallbackApiKey?.()?.trim()) return undefined;
  return `模块解析需要先在设置中配置 ${LLM_PRESETS[settings.provider].label} 的 API Key。`;
}

/** Store the draft credential before activating its provider; never return secret storage errors. */
export async function saveWithModelCredential<T>(
  storage: CredentialStorage, endpoint: string, settings: LlmSettings,
  update: string | null | undefined, save: () => Promise<T>,
): Promise<T> {
  parseLlmSettings(settings);
  if (typeof update === 'string' && validateModelKey(update)) throw new Error('API Key 格式无效。');
  if (update === undefined) return save();
  const id = modelCredentialId(endpoint, settings);
  let previous: string | undefined;
  try {
    previous = await storage.get(id);
    if (update === null) await storage.delete(id);
    else await storage.store(id, update.trim());
  } catch { throw new Error('密钥保存失败，未启用新的服务商，请重试。'); }
  try { return await save(); }
  catch {
    try {
      if (previous === undefined) await storage.delete(id);
      else await storage.store(id, previous);
    } catch { throw new Error('设置保存失败，密钥恢复失败，请重新填写并保存。'); }
    throw new Error('设置保存失败，已恢复原有密钥，请重试。');
  }
}
