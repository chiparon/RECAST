import { createHash } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { moduleFileHash } from './module-translation-handoff';
import { MAX_RETRIEVAL_SCOPES, type GlobalProtocol, type ModuleProtocol, type WorkspaceEvidenceScope, type WorkspaceHistoryView, type WorkspaceTranslationContext, type WorkspaceTranslationMode, type WorkspaceTranslationRequest, type WorkspaceTranslationRun, type WorkspaceVerificationFeedback, type WorkspaceTranslationTaskKind } from '@forexplore/contracts';
import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol/messages';

export interface TranslationProfile {
  workspaceRoot: string;
  sourceLanguage: string;
  targetLanguage: string;
  workspaceFiles: string[];
  writeFiles: string[];
}
export type TranslationIntent = Extract<WebviewToHostMessage, { type: 'WORKSPACE_TRANSLATION' }>;

/**
 * A host-owned translation scope derived from a selected target module and its
 * retrieved history candidates, or an explicit direct-translation fallback.
 * The page may only refer to it by opaque id, so
 * a Webview can neither widen the write set nor inject source or a path.
 */
export interface WorkspaceTranslationModuleScope {
  label: string;
  /** Analyzer specification owned by the host. */
  spec: string;
  profile: TranslationProfile;
  context: WorkspaceTranslationContext[];
  /** Read-only history revisions the agents may query on demand. */
  evidenceScopes?: WorkspaceEvidenceScope[];
  /** Host-created source snapshot; only its manifest and opaque metadata reach the run record. */
  historyView?: WorkspaceHistoryView;
  /** Host-selected Agent route; direct-translator is used without history. */
  translationMode?: WorkspaceTranslationMode;
  taskKind?: WorkspaceTranslationTaskKind;
  moduleProtocol?: ModuleProtocol;
  globalProtocol?: GlobalProtocol;
  /** Bounded, non-blocking observations about the derived scope. */
  warnings?: string[];
  /** Snapshot captured by the host when the user prepares a module translation. */
  fileHashes?: Record<string, string>;
}

/** Credentials, paths and retrieved source stay in the host. The page supplies opaque IDs only. */
export class WorkspaceTranslationHost {
  private readonly starts = new Map<string, Promise<WorkspaceTranslationRun>>();
  private readonly runKeys = new Map<string, string>();
  private readonly historyRoots = new Map<string, string>();
  private moduleScope?: { id: string; scope: WorkspaceTranslationModuleScope };
  constructor(private readonly configuration: () => { url: string; token?: string; profile?: string },
    private readonly transport: typeof fetch = (...args) => fetch(...args)) {}

  /**
   * Replaces the active module scope and returns the opaque id the page may
   * echo back. The scope's files and source never leave the host except as the
   * describe summary the panel already displays.
   */
  rememberModuleScope(scope: WorkspaceTranslationModuleScope): string {
    const id = createHash('sha256').update(canonicalScope(scope)).digest('hex');
    this.moduleScope = { id, scope: structuredClone(scope) };
    return id;
  }

  clearModuleScope(): void {
    this.moduleScope = undefined;
  }

  get activeModuleScopeId(): string | undefined {
    return this.moduleScope?.id;
  }

  /** Host-only verifier feedback path; this is deliberately outside Webview actions. */
  async repairAfterVerification(runId: string, feedback: WorkspaceVerificationFeedback): Promise<WorkspaceTranslationRun> {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('无效的运行编号。');
    const { url, token } = this.configuration();
    if (!token) throw new Error('翻译服务认证未配置。');
    const endpoint = new URL(url);
    const base = endpoint.pathname.replace(/\/+$/, '');
    endpoint.search = ''; endpoint.hash = '';
    endpoint.pathname = `${base}/v1/workspace-translations/${runId}/verification-repair`;
    const response = await this.transport(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(feedback), signal: AbortSignal.timeout(30000) });
    const value = await response.json() as WorkspaceTranslationRun & { error?: string };
    if (!response.ok) throw new Error(value.error ?? `翻译服务返回 ${response.status}`);
    return value;
  }

  async handle(intent: TranslationIntent): Promise<HostToWebviewMessage> {
    try {
      const { url, token, profile: raw } = this.configuration();
      if (!token) throw new Error('请在宿主配置 ADAPTATION_WORKSPACE_TRANSLATION_TOKEN，并在翻译服务启用工作区翻译。');
      if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) {
        throw new Error('模块翻译范围已变化，请重新选择目标模块或候选模块。');
      }
      const scope = intent.moduleScopeId === undefined ? undefined : this.moduleScope?.scope;
      // A module scope replaces the static profile for this operation; the
      // static profile remains the fallback for the single-workspace flow.
      const profile = scope?.profile ?? (raw && (intent.action === 'describe' || intent.action === 'start') ? parseProfile(raw) : undefined);
      const endpoint = new URL(url);
      const base = endpoint.pathname.replace(/\/+$/, '');
      endpoint.search = ''; endpoint.hash = '';
      const request = async <T>(suffix: string, body?: unknown): Promise<T> => {
        const target = new URL(endpoint); target.pathname = `${base}/v1/workspace-translations${suffix}`;
        const response = await this.transport(target, { method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
        const value = await response.json() as T & { error?: string };
        if (!response.ok) throw new Error(value.error ?? `翻译服务返回 ${response.status}`);
        return value;
      };
      const configured = await request<{ workspaceRoot: string; behavioralVerification: boolean }>('/configuration');
      if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) throw new Error('模块翻译范围已变化，请重新选择候选。');
      if (profile && await realpath(configured.workspaceRoot) !== await realpath(profile.workspaceRoot)) throw new Error('翻译服务的工作区与宿主配置不一致。');
      if ((intent.action === 'describe' || intent.action === 'start') && !profile) throw new Error('请先选择模块候选，或在宿主配置 FOREXPLORE_TRANSLATION_PROFILE。');
      const profileId = createHash('sha256').update(JSON.stringify([url, profile, intent.moduleScopeId ?? ''])).digest('hex');
      if (intent.action === 'describe') return { type: 'WORKSPACE_TRANSLATION_RESULT', requestId: intent.requestId,
        profile: { ...profile!, profileId, behavioralVerification: configured.behavioralVerification,
          ...(scope ? { moduleScopeId: intent.moduleScopeId, label: scope.label, warnings: scope.warnings ?? [] } : {}) } };

      let run: WorkspaceTranslationRun;
      if (intent.action === 'start') {
        if (intent.profileId !== profileId) throw new Error('翻译配置已变化，请重新打开生成与验收面板。');
        if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) throw new Error('模块翻译范围已变化，请重新选择候选。');
        const context: WorkspaceTranslationRequest['context'] = scope ? structuredClone(scope.context) : [];
        let evidenceScopes = [...(scope?.evidenceScopes ?? [])];
        if (context.length === 0 && scope?.taskKind !== 'project-integration') throw new Error('模块翻译缺少可用上下文：请选择历史候选模块。');
        const mergedScopes = new Map<string, WorkspaceEvidenceScope>();
        for (const next of evidenceScopes) {
          const key = JSON.stringify([next.repositoryId, next.analysisRevision]);
          const previous = mergedScopes.get(key);
          if (previous?.projectId && next.projectId && previous.projectId !== next.projectId) throw new Error('同一历史版本选择了不同项目，请先按整个参考仓库重新检索。');
          if (!previous || !next.projectId) mergedScopes.set(key, next);
        }
        evidenceScopes = [...mergedScopes.values()];
        if (evidenceScopes.length > MAX_RETRIEVAL_SCOPES) throw new Error(`取证范围超过 ${MAX_RETRIEVAL_SCOPES} 个版本，请缩小参考工程范围。`);
        const input = { spec: scope ? moduleSpec(scope, undefined) : '',
          sourceLanguage: profile!.sourceLanguage, targetLanguage: profile!.targetLanguage,
          workspaceFiles: profile!.workspaceFiles, writeFiles: profile!.writeFiles, context,
          ...(scope?.translationMode ? { translationMode: scope.translationMode } : {}),
          ...(scope?.taskKind ? { taskKind: scope.taskKind } : {}),
          ...(scope?.moduleProtocol ? { moduleProtocol: structuredClone(scope.moduleProtocol) } : {}),
          ...(scope?.globalProtocol ? { globalProtocol: structuredClone(scope.globalProtocol) } : {}),
          ...(evidenceScopes.length ? { evidenceScopes } : {}),
          ...(scope?.historyView ? { historyView: structuredClone(scope.historyView) } : {}) };
        // Do not repeat a write request if the UI delivers the same operation twice.
        const startKey = JSON.stringify([url, profile, intent.moduleScopeId ?? '']);
        let pending = this.starts.get(startKey);
        if (!pending) {
          if (this.starts.size >= 100) throw new Error('本次会话的翻译任务已达上限，请重启宿主。');
          let submitted = false;
          pending = (async () => {
            for (const [file, hash] of Object.entries(scope?.fileHashes ?? {})) {
              if (await moduleFileHash(profile!.workspaceRoot, file) !== hash) throw new Error(`模块文件 ${file} 已变化，请重新准备翻译。`);
            }
            if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) throw new Error('模块翻译范围已变化，请重新选择候选。');
            submitted = true;
            return request<WorkspaceTranslationRun>('', input);
          })();
          this.starts.set(startKey, pending);
          // A lost response may follow a successful write submission. Only a
          // failure before submission is safe to retry as a new start request.
          void pending.catch(() => { if (!submitted && this.starts.get(startKey) === pending) this.starts.delete(startKey); });
        }
        run = await pending;
        this.runKeys.set(run.id, startKey);
        if (scope?.historyView) this.historyRoots.set(run.id, scope.historyView.root);
      } else {
        if (!intent.runId || !/^[a-f0-9-]{36}$/.test(intent.runId)) throw new Error('无效的运行编号。');
        // Check the durable run before any action, including after host restart.
        run = await request<WorkspaceTranslationRun>(`/${intent.runId}`);
        if (await realpath(run.workspaceRoot) !== await realpath(configured.workspaceRoot)) throw new Error('运行不属于配置的工作区。');
        if (intent.action !== 'read') run = await request<WorkspaceTranslationRun>(`/${intent.runId}/${intent.action}`, {});
        if (run.status === 'rolled-back') {
          const key = this.runKeys.get(run.id);
          if (key) this.starts.delete(key);
          this.runKeys.delete(run.id);
        }
      }
      // The adaptation service needs the internal history-view root to resume
      // a run, but that absolute path is host-only and must never cross into
      // the webview response.
      const visibleRun = structuredClone(run);
      if (visibleRun.request?.historyView) {
        delete visibleRun.request.historyView;
      }
      // Keep a completed module's immutable history-view alive: the host may
      // submit verifier feedback and re-enter the same Translator run. It is
      // removed on rollback or when the host session is disposed.
      if (run.status === 'rolled-back') {
        const historyRoot = this.historyRoots.get(run.id) ?? scope?.historyView?.root;
        if (historyRoot) {
          this.historyRoots.delete(run.id);
          void rm(historyRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      return { type: 'WORKSPACE_TRANSLATION_RESULT', requestId: intent.requestId, run: visibleRun };
    } catch (error) {
      return { type: 'WORKSPACE_TRANSLATION_ERROR', requestId: intent.requestId,
        message: error instanceof Error ? error.message : '翻译操作失败。' };
    }
  }
}

function parseProfile(raw: string): TranslationProfile {
  const profile = JSON.parse(raw) as TranslationProfile;
  if (!profile || typeof profile.workspaceRoot !== 'string' || !path.isAbsolute(profile.workspaceRoot) ||
      ![profile.sourceLanguage, profile.targetLanguage].every(value => typeof value === 'string' && value.trim()) ||
      ![profile.workspaceFiles, profile.writeFiles].every(files => Array.isArray(files) && files.length > 0 && files.length <= 100 && files.every(file => typeof file === 'string' && file.length > 0))) {
    throw new Error('宿主翻译配置无效。');
  }
  return profile;
}

/** Identity covers the reviewed file scope and the module package inventory. */
function canonicalScope(scope: WorkspaceTranslationModuleScope): string {
  return JSON.stringify([scope.label, scope.profile, scope.spec, scope.context, scope.evidenceScopes, scope.historyView, scope.fileHashes, scope.translationMode, scope.taskKind, scope.moduleProtocol, scope.globalProtocol]);
}

/** A module run's specification is host-owned; a task requirement only adds detail. */
function moduleSpec(scope: WorkspaceTranslationModuleScope, requirement: string | undefined): string {
  const detail = requirement?.trim();
  return [scope.spec, detail && !scope.spec.includes(detail) ? `补充需求：${detail}` : ''].filter(Boolean).join('\n');
}
