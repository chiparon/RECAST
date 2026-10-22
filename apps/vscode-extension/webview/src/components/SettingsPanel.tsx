import { DEFAULT_LLM_SETTINGS, LLM_PRESETS, OUTPUT_TOKEN_LIMITS, parseLlmSettings, type LlmProvider } from '@forexplore/contracts';
import { validateModelKey } from '../../../src/model-credential';
import { mergeReferencePaths } from '../reference-folder-picker';
import { FolderPlus, RefreshCw, Save, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelSettingsPresentation } from '../../../src/protocol/messages';
import type {
  CodeIntelligencePresentation,
  RepositoryStatus,
} from '../../../src/ui-types';

interface SettingsPanelProps extends PanelSettingsPresentation {
  modelKeyStatus?: { configured: boolean; message?: string };
  onBrowseReferenceFolders?(): Promise<string[]>;
  repositoryStatuses: RepositoryStatus[];
  codeIntelligence?: CodeIntelligencePresentation | null;
  saving: boolean;
  saveMessage?: string;
  onCheckRepositories(): void;
  /** Selects only a project inside the host-verified revision. */
  onSelectCodeIntelligenceProject(repositoryId: string, analysisRevision: string, projectId: string): void;
  onSave(settings: PanelSettingsPresentation, modelKey?: string | null): void;
  onCancel(): void;
}

export function SettingsPanel({
  llm = DEFAULT_LLM_SETTINGS,
  onBrowseReferenceFolders,
  modelKeyStatus,
  topK,
  repositoryPaths,
  repositoryStatuses,
  codeIntelligence,
  saving,
  saveMessage,
  onCheckRepositories,
  onSelectCodeIntelligenceProject,
  onSave,
  onCancel,
}: SettingsPanelProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [draftLlm, setDraftLlm] = useState(llm);
  const [draftKey, setDraftKey] = useState<string | null | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const showApiBase = draftLlm.provider === 'custom' || draftLlm.apiBase !== LLM_PRESETS[draftLlm.provider].apiBase;
  const credentialChanged = draftLlm.provider !== llm.provider || draftLlm.apiBase !== llm.apiBase;
  const savedKey = !credentialChanged && modelKeyStatus?.configured && draftKey === undefined;
  useEffect(() => { setDraftLlm(llm); setDraftKey(undefined); }, [llm]);
  useEffect(() => { setDraftKey(undefined); }, [draftLlm.provider, draftLlm.apiBase]);

  const [draftTopK, setDraftTopK] = useState(topK);
  const [draftPaths, setDraftPaths] = useState<string[]>(repositoryPaths);

  useEffect(() => {
    setDraftTopK(topK);
    setDraftPaths(repositoryPaths);
  }, [topK, repositoryPaths]);

  const normalizedPaths = useMemo(
    () => mergeReferencePaths(draftPaths, []),
    [draftPaths],
  );
  const dirty = draftKey !== undefined || draftTopK !== topK || JSON.stringify(draftLlm) !== JSON.stringify(llm) ||
    JSON.stringify(normalizedPaths) !== JSON.stringify(repositoryPaths);

  useEffect(() => {
    const requestSave = () => { if (!saving && !browsing) formRef.current?.requestSubmit(); };
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) requestSave();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('recast-save-settings', requestSave);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('recast-save-settings', requestSave);
    };
  }, [saving, browsing]);

  function updatePath(index: number, value: string): void {
    setDraftPaths((current) => current.map((path, itemIndex) => itemIndex === index ? value : path));
  }

  function removePath(index: number): void {
    setDraftPaths((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (saving || browsing) return;
    try {
      const model = parseLlmSettings(draftLlm);
      const keyError = typeof draftKey === 'string' ? validateModelKey(draftKey) : undefined;
      if (keyError) throw new Error(keyError);
      setFormError(null);
      const settings = { topK: draftTopK, repositoryPaths: normalizedPaths, llm: model };
      if (draftKey === undefined) onSave(settings);
      else onSave(settings, draftKey === null ? null : draftKey.trim());
    } catch (error) { setFormError(error instanceof Error ? error.message : 'AI 配置无效。'); }
  }

  async function browse(): Promise<void> {
    if (!onBrowseReferenceFolders || browsing) return;
    setBrowsing(true); setFormError(null);
    try {
      const selected = await onBrowseReferenceFolders();
      if (selected.length) setDraftPaths(current => {
        const merged = mergeReferencePaths(current, selected);
        if (merged.length > 20 || merged.some(p => p.length > 1000)) {
          setFormError('最多添加 20 个参考工程，每个路径不超过 1000 字符。请减少选择后重试。');
          return current;
        }
        return merged;
      });
    } catch (error) { setFormError(error instanceof Error ? error.message : '目录选择失败。'); }
    finally { setBrowsing(false); }
  }

  return (
    <form ref={formRef} className="settings-panel" onSubmit={submit}>
      <div className="settings-heading">
        <span className="settings-glyph"><Settings2 size={18} /></span>
        <div>
          <h1>设置</h1>
          <p>配置 AI 服务、候选方案数量和用于模块检索的参考工程。</p>
        </div>
      </div>

      <section className="card settings-section" aria-label="AI 服务">
        <div className="card-heading"><span>AI 服务</span></div>
        <div className="model-settings-grid">
          <label>服务商<select aria-label="AI 服务商" value={draftLlm.provider} disabled={saving}
            onChange={event => { const provider = event.target.value as LlmProvider; setDraftLlm(current => ({ ...current, provider, apiBase: LLM_PRESETS[provider].apiBase, model: LLM_PRESETS[provider].model })); }}>
            {Object.entries(LLM_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
          </select></label>
          <label>模型<input aria-label="模型名称" value={draftLlm.model} maxLength={200} required disabled={saving}
            onChange={event => setDraftLlm(current => ({ ...current, model: event.target.value }))} /></label>
          {showApiBase ? <label className="model-endpoint">自定义 API 地址<input aria-label="API Base URL" type="url" value={draftLlm.apiBase} maxLength={1000} required disabled={saving}
            onChange={event => setDraftLlm(current => ({ ...current, apiBase: event.target.value }))} /></label> : null}
          <div className="model-key-section" role="group" aria-label={`${LLM_PRESETS[draftLlm.provider].label} API Key`}>
            <label htmlFor="model-api-key">API Key</label>
            <div className="model-key-controls">
              <input id="model-api-key" aria-label="API Key" type="password" autoComplete="off" spellCheck={false}
                value={savedKey ? '••••••••••••••••' : draftKey ?? ''} maxLength={512} disabled={saving}
                placeholder="无" aria-describedby="model-key-state"
                onFocus={event => { if (savedKey) event.currentTarget.select(); }}
                onChange={event => setDraftKey(event.target.value || undefined)} />
              {!credentialChanged && modelKeyStatus?.configured ? <button type="button" className="icon-button" aria-label={draftKey === null ? '撤销清除 Key' : '清除保存的 Key'} title={draftKey === null ? '撤销清除 Key' : '清除保存的 Key（保存后生效）'} onClick={() => setDraftKey(draftKey === null ? undefined : null)} disabled={saving}>
                {draftKey === null ? <RefreshCw size={14} /> : <Trash2 size={14} />}
              </button> : null}
            </div>
            <span id="model-key-state" className="muted-copy" role="status">{draftKey === null ? '待清除，保存后生效' : savedKey ? '已配置 · 输入新 Key 可替换，保存其他设置会保留' : draftKey ? '新 Key 待保存' : '未配置'}</span>
          </div>
          <label>输出 Token 上限<select aria-label="每次最大输出 Token" value={draftLlm.maxOutputTokens} disabled={saving}
            onChange={event => setDraftLlm(current => ({ ...current, maxOutputTokens: Number(event.target.value) }))}>
            {OUTPUT_TOKEN_LIMITS.map(limit => <option key={limit} value={limit}>{limit.toLocaleString('en-US')} tokens</option>)}
          </select></label>
        </div>
        <p className="settings-intro">填写 Key 后保存即启用服务商；Token 仅限制单次输出。</p>
        {!credentialChanged && modelKeyStatus?.message ? <p role="status" className="muted-copy">{modelKeyStatus.message}</p> : null}
      </section>

      <section className="card settings-section">
        <div className="card-heading"><span>返回方案数</span><strong>Top {draftTopK}</strong></div>
        <input
          aria-label="返回方案数"
          type="range"
          min="1"
          max="10"
          value={draftTopK}
          onChange={(event) => setDraftTopK(Number(event.target.value))}
        />
        <div className="settings-range-scale"><span>1</span><span>10</span></div>
        <p className="muted-copy">每次检索展示 {draftTopK} 个候选方案。</p>
      </section>

      <section className="card settings-section" aria-label="代码智能索引状态">
        <div className="card-heading">
          <span>代码智能索引</span>
          <strong>{codeIntelligenceStatusLabel(codeIntelligence)}</strong>
        </div>
        <p className="settings-intro">
          查看工程索引状态、语言能力和模块建模结果。
        </p>
        {codeIntelligence?.repositories.length ? (
          <div className="code-intelligence-list">
            {codeIntelligence.repositories.map((repository) => (
              <div className="code-intelligence-row" key={repository.repositoryId}>
                <div>
                  <strong>{repository.displayName}</strong>
                  <span>{repository.role === 'target' ? '目标工程' : '参考工程'} · {repository.analysisStatus}</span>
                </div>
                <div className="code-intelligence-facts">
                  {!repository.activeRevision ? <span>尚未索引</span> : null}
                  <span>{repository.languages.length
                    ? repository.languages.map((language) => `${language.languageId} · ${language.capabilityLevel}`).join('，')
                    : '尚无语言能力数据'}</span>
                  {repository.projects.length ? (
                    <label className="code-intelligence-project-picker">
                      <span>{repository.role === 'target' ? '目标工程' : '参考工程'}</span>
                      <select
                        aria-label={`${repository.displayName} 的${repository.role === 'target' ? '目标工程' : '参考工程'}`}
                        value={repository.selectedProjectId ?? ''}
                        onChange={(event) => {
                          if (event.target.value && repository.selectedRevision) {
                            onSelectCodeIntelligenceProject(
                              repository.repositoryId,
                              repository.selectedRevision,
                              event.target.value,
                            );
                          }
                        }}
                      >
                        <option value="">请选择项目</option>
                        {repository.projects.map((project) => (
                          <option key={project.projectId} value={project.projectId}>
                            {project.displayName} · {project.kind}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <span className={`summary-status is-${repository.summary.status}`}>
                    {summaryLabel(repository.summary.status)}
                  </span>
                  {repository.summary.status === 'stale' ? (
                    <span className="code-intelligence-stale-warning">模块建模结果已过期，请重新建模后使用。</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-empty">
            <span>{codeIntelligence?.message ?? '尚未注册可索引仓库。'}</span>
          </div>
        )}
      </section>

      <section className="card settings-section">
        <div className="card-heading">
          <span>参考工程路径</span>
          <button
            type="button"
            className="text-button"
            onClick={() => setDraftPaths((current) => current.length < 20 ? [...current, ''] : current)}
            disabled={draftPaths.length >= 20 || saving}
          >
            <FolderPlus size={13} /> 手动添加路径
          </button>
        </div>
        <button type="button" className="secondary-action" onClick={() => void browse()} disabled={saving || browsing || !onBrowseReferenceFolders || draftPaths.length >= 20}>
          <FolderPlus size={14} /> {browsing ? '正在选择…' : '浏览文件夹（可多选）'}
        </button>
        <p className="settings-intro">可添加多个本地参考工程。保存后，它们会分别出现在左侧“参考工程”列表中。</p>
        {draftPaths.length === 0 ? (
          <div className="settings-empty">
            <span>尚未添加参考工程路径</span>
            <button type="button" className="secondary-action" onClick={() => onBrowseReferenceFolders ? void browse() : setDraftPaths([''])} disabled={saving || browsing}>
              <FolderPlus size={13} /> 添加第一个路径
            </button>
          </div>
        ) : (
          <div className="repository-path-fields">
            {draftPaths.map((path, index) => {
              const status = repositoryStatuses.find((item) => item.path === path.trim());
              return (
                <div className="repository-path-row" key={`${index}-${repositoryPaths[index] ?? 'new'}`}>
                  <label>
                    <span>路径 {index + 1}</span>
                    <input
                      type="text"
                      value={path}
                      maxLength={1000}
                      placeholder="例如 D:\\CodeProjects\\legacy-system"
                      onChange={(event) => updatePath(index, event.target.value)}
                      disabled={saving}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button danger-button"
                    aria-label={`删除路径 ${index + 1}`}
                    title="删除路径"
                    onClick={() => removePath(index)}
                    disabled={saving}
                  >
                    <Trash2 size={14} />
                  </button>
                  {status ? (
                    <span className={`path-status is-${statusClass(status)}`} title={status.message}>
                      <i className="repository-dot" />{status.message}
                    </span>
                  ) : path.trim() ? <span className="path-status">保存后检查</span> : null}
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className="text-button settings-check-button"
          onClick={onCheckRepositories}
          disabled={saving || repositoryPaths.length === 0}
          title={repositoryPaths.length === 0 ? '请先保存至少一个仓库路径' : '检查已保存的仓库路径'}
        >
          <RefreshCw size={13} /> 重新检查已保存路径
        </button>
      </section>

      <div className="settings-save-dock" role="group" aria-label="保存设置操作">
        {formError ? <p role="alert" className="settings-save-error">{formError}</p> : null}
        {!formError && !saving && saveMessage && !dirty ? <p role="status" className="settings-save-notice">{saveMessage}</p> : null}
        <div className="settings-actions">
          <button type="button" className="secondary-action" onClick={onCancel} disabled={saving}>
            <X size={14} /> 取消
          </button>
          <button type="submit" className="primary-action settings-save" aria-keyshortcuts="Control+S Meta+S" title="保存设置 (Ctrl+S / ⌘S)" disabled={saving || browsing}>
            {saving ? <span className="spinner" /> : <Save size={14} />}
            {saving ? '正在保存…' : '保存设置'}<kbd>Ctrl+S</kbd>
          </button>
        </div>
      </div>
    </form>
  );
}

function codeIntelligenceStatusLabel(value: CodeIntelligencePresentation | null | undefined): string {
  if (!value || value.status === 'initializing') return '初始化中';
  if (value.status === 'error') return '需要处理';
  return value.storage === 'seekdb' ? 'SeekDB 已连接' : '内存开发存储';
}

function summaryLabel(status: 'missing' | 'current' | 'stale'): string {
  if (status === 'current') return 'Summary 当前';
  if (status === 'stale') return 'Summary 已过期';
  return '尚无 Summary';
}

function statusClass(status: RepositoryStatus): string {
  if (!status.exists || !status.readable) return 'error';
  if (status.stale) return 'stale';
  if (!status.indexed) return 'pending';
  return 'ok';
}
