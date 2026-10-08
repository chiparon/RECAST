import { validateModelKey } from '../model-credential';
import { parseLlmSettings, type LlmSettings } from '@forexplore/contracts';
import type {
  WorkspaceTranslationRun,
  AdaptationResult,
  ApplyResult,
  ModuleTarget,
  SearchCandidate,
} from '@forexplore/contracts';
import type {
  ModuleExplorerPresentation,
  RepositoryStatus,
  ServiceStatus,
  CodeIntelligencePresentation,
  ModuleChildrenPage,
  ModuleChildrenRequest,
} from '../ui-types';

/** Snapshot sent by the trusted extension host when the panel is created. */
export interface PanelInitPayload {
  target: ModuleTarget | null;
  workspaceRoot: string;
  settings: PanelSettingsPresentation;
  repositoryStatuses: RepositoryStatus[];
  /** Path-free status for the shared versioned structural/semantic index. */
  codeIntelligence: CodeIntelligencePresentation;
  serviceStatus: ServiceStatus;
  moduleExplorer: ModuleExplorerPresentation;
  searchProvider: 'SeekDB';
  adaptationProvider: string;
}

export interface PanelSettingsPresentation {
  llm?: LlmSettings;
  repositoryPaths: string[];
  topK: number;
}

/** How a user asked for a target project directory. */
export type TargetWorkspaceAddMode = 'browse' | 'input' | 'workspace';

/**
 * Every phase of one explicit target selection. A native dialog returns
 * nothing until it closes and a first-time index can run for minutes, so each
 * phase is reported instead of only the final outcome.
 */
export type TargetWorkspacePhase = 'selecting' | 'resolving' | 'attaching' | 'indexing';

export type TargetWorkspaceOutcome = 'cancelled' | 'added' | 'completed' | 'failed';

/** Messages the extension host posts into the Webview. */
export type HostToWebviewMessage =
  | { type: 'REQUEST_SETTINGS_SAVE' }
  | { type: 'REFERENCE_FOLDERS_SELECTED'; requestId: string; paths: string[]; error?: string }
  | { type: 'MODEL_KEY_STATUS'; configured: boolean; message?: string }
  | { type: 'WORKSPACE_TRANSLATION_RESULT'; requestId: string; run?: WorkspaceTranslationRun; profile?: { profileId: string; workspaceRoot: string; sourceLanguage: string; targetLanguage: string; workspaceFiles: string[]; writeFiles: string[]; behavioralVerification: boolean; moduleScopeId?: string; label?: string; warnings?: string[] } }
  | { type: 'WORKSPACE_TRANSLATION_ERROR'; requestId: string; message: string }
  | { type: 'INIT'; payload: PanelInitPayload }
  | { type: 'SEARCH_RESULT'; candidates: SearchCandidate[] }
  | { type: 'ADAPT_RESULT'; result: AdaptationResult }
  | { type: 'MODULE_TRANSLATION_READY'; targetId: string; candidateId: string; candidateIds?: string[]; moduleScopeId: string }
  | { type: 'APPLY_RESULT'; result: ApplyResult }
  | { type: 'REPOSITORY_STATUS'; statuses: RepositoryStatus[] }
  | { type: 'CODE_INTELLIGENCE_STATUS'; presentation: CodeIntelligencePresentation }
  | { type: 'SERVICE_STATUS'; status: ServiceStatus }
  | { type: 'MODULE_EXPLORER'; explorer: ModuleExplorerPresentation }
  | { type: 'MODULE_CHILDREN'; requestId: string; page: ModuleChildrenPage }
  | { type: 'MODULE_CHILDREN_ERROR'; requestId: string; message: string }
  | { type: 'TARGET_SELECTED'; target: ModuleTarget }
  | { type: 'TARGET_CLEARED' }
  | { type: 'TARGET_WORKSPACE_PROGRESS'; phase: TargetWorkspacePhase; message: string }
  | { type: 'TARGET_WORKSPACE_RESULT'; outcome: TargetWorkspaceOutcome; mode: TargetWorkspaceAddMode; message?: string }
  | { type: 'SETTINGS_UPDATED'; settings: PanelSettingsPresentation }
  | { type: 'ERROR'; message: string };

/**
 * The Webview can express intent only. It never controls target paths,
 * candidate objects, validation evidence, or patches to be written.
 */
export type WebviewToHostMessage =
  | { type: 'SETTINGS_VISIBILITY_CHANGED'; open: boolean }
  | { type: 'BROWSE_REFERENCE_FOLDERS'; requestId: string }
  | { type: 'CONFIGURE_MODEL_KEY' }
  | { type: 'CLEAR_MODEL_KEY' }
  | { type: 'WORKSPACE_TRANSLATION'; requestId: string; action: 'describe' | 'start' | 'read' | 'cancel' | 'resume' | 'rollback'; profileId?: string; runId?: string; moduleScopeId?: string }
  | { type: 'READY' }
  | { type: 'LOAD_MODULE_CHILDREN'; requestId: string; request: ModuleChildrenRequest }
  | { type: 'ADD_TARGET_WORKSPACE'; mode: 'browse' | 'input' | 'workspace' }
  | {
      type: 'START_SEARCH';
      requirement: string;
      topK: number;
    }
  | { type: 'SELECT_CANDIDATE'; candidateId: string }
  | { type: 'SELECT_CANDIDATES'; candidateIds: string[] }
  | { type: 'START_ADAPT'; decisionNotes: string }
  | { type: 'APPLY_CURRENT_RUN' }
  | { type: 'CHECK_REPOSITORIES' }
  | { type: 'REFRESH_MODULE_EXPLORER' }
  | { type: 'REFRESH_REPOSITORY'; repositoryId: string }
  | { type: 'SAVE_SETTINGS'; settings: PanelSettingsPresentation; modelKey?: string | null }
  /**
   * Opaque IDs only. The extension host verifies that the exact revision
   * already belongs to the registered repository before using it read-only.
   */
  | { type: 'SELECT_CODE_INTELLIGENCE_REVISION'; repositoryId: string; analysisRevision: string }
  | { type: 'SELECT_CODE_INTELLIGENCE_PROJECT'; repositoryId: string; analysisRevision: string; projectId: string }
  | { type: 'RETRY_PROJECT_ANALYSIS'; repositoryId: string; analysisRevision: string; projectId: string; force: boolean }
  | { type: 'SELECT_WORKSPACE_TARGET'; targetId: string }
  | { type: 'COPY_TARGET_PATH' }
  | { type: 'REVEAL_TARGET_IN_EXPLORER' }
  | { type: 'OPEN_TARGET' };

const hostMessageTypes = new Set<string>([
  'REQUEST_SETTINGS_SAVE',
  'REFERENCE_FOLDERS_SELECTED',
  'MODEL_KEY_STATUS',
  'WORKSPACE_TRANSLATION_RESULT',
  'WORKSPACE_TRANSLATION_ERROR',
  'INIT',
  'SEARCH_RESULT',
  'ADAPT_RESULT',
  'MODULE_TRANSLATION_READY',
  'APPLY_RESULT',
  'REPOSITORY_STATUS',
  'CODE_INTELLIGENCE_STATUS',
  'SERVICE_STATUS',
  'MODULE_EXPLORER',
  'MODULE_CHILDREN',
  'MODULE_CHILDREN_ERROR',
  'TARGET_SELECTED',
  'TARGET_CLEARED',
  'TARGET_WORKSPACE_PROGRESS',
  'TARGET_WORKSPACE_RESULT',
  'SETTINGS_UPDATED',
  'ERROR',
]);

/** The Webview trusts only these phase/outcome literals from the host. */
function isTargetWorkspaceProgress(value: { phase?: unknown; message?: unknown }): boolean {
  return typeof value.message === 'string' && value.message.length <= 400 &&
    ['selecting', 'resolving', 'attaching', 'indexing'].includes(String(value.phase));
}

function isTargetWorkspaceResult(value: { outcome?: unknown; mode?: unknown; message?: unknown }): boolean {
  return ['browse', 'input', 'workspace'].includes(String(value.mode)) &&
    ['cancelled', 'added', 'completed', 'failed'].includes(String(value.outcome)) &&
    (value.message === undefined || (typeof value.message === 'string' && value.message.length <= 400));
}

/**
 * Names the field that made `isWebviewToHostMessage` refuse a payload.  The
 * host used to drop refused messages in silence, which left a panel waiting
 * forever next to an empty log: a refused action a user is waiting on must
 * come back with a reason instead.
 */
export function webviewMessageRejectionReason(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '消息不是对象。';
  const message = value as Record<string, unknown>;
  const type = typeof message.type === 'string' && message.type ? message.type : '<缺少 type>';
  if (type === 'START_ADAPT') {
    const unknown = Object.keys(message).filter((key) => key !== 'type' && key !== 'decisionNotes');
    if (unknown.length > 0) return `START_ADAPT 含未知字段：${unknown.join('、')}。`;
    if (typeof message.decisionNotes !== 'string') return 'START_ADAPT 的决策说明必须是字符串。';
    return `START_ADAPT 的决策说明 ${message.decisionNotes.length} 字，超过 8000 字上限。`;
  }
  if (type === 'START_SEARCH') return 'START_SEARCH 的需求或 topK 无效。';
  if (type === 'SELECT_CANDIDATE') return 'SELECT_CANDIDATE 的候选标识无效。';
  if (type === 'WORKSPACE_TRANSLATION') return 'WORKSPACE_TRANSLATION 的请求字段无效。';
  return `宿主不接受该 ${type} 消息。`;
}

/** Strictly validates every Webview payload before it enters the host. */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'SETTINGS_VISIBILITY_CHANGED':
      return hasOnlyKeys(message, ['type', 'open']) && typeof message.open === 'boolean';
    case 'WORKSPACE_TRANSLATION': {
      if (!Object.keys(message).every(key => ['type', 'requestId', 'action', 'profileId', 'runId', 'moduleScopeId'].includes(key)) || !isOpaqueIdentifier(message.requestId)) return false;
      if (message.action === 'describe') return message.moduleScopeId === undefined
        ? hasOnlyKeys(message, ['type', 'requestId', 'action'])
        : hasOnlyKeys(message, ['type', 'requestId', 'action', 'moduleScopeId']) && typeof message.moduleScopeId === 'string' && /^[a-f0-9]{64}$/.test(message.moduleScopeId);
      if (message.action === 'start') {
        return isOpaqueIdentifier(message.profileId) && message.runId === undefined &&
          (message.moduleScopeId === undefined || typeof message.moduleScopeId === 'string' && /^[a-f0-9]{64}$/.test(message.moduleScopeId));
      }
      return ['read', 'cancel', 'resume', 'rollback'].includes(String(message.action)) && message.profileId === undefined &&
        message.moduleScopeId === undefined &&
        typeof message.runId === 'string' && /^[a-f0-9-]{36}$/.test(message.runId);
    }
    case 'LOAD_MODULE_CHILDREN': {
      if (!hasOnlyKeys(message, ['type', 'requestId', 'request']) || !isOpaqueIdentifier(message.requestId) ||
        typeof message.request !== 'object' || message.request === null) return false;
      const request = message.request as Record<string, unknown>;
      return Object.keys(request).every((key) => ['repositoryId', 'analysisRevision', 'projectId', 'nodeId', 'offset', 'query', 'status'].includes(key)) &&
        [request.repositoryId, request.analysisRevision, request.projectId].every(isOpaqueIdentifier) &&
        typeof request.nodeId === 'string' && request.nodeId.length > 0 && request.nodeId.length <= 4096 &&
        Number.isSafeInteger(request.offset) && typeof request.offset === 'number' && request.offset >= 0 &&
        (request.query === undefined || (typeof request.query === 'string' && request.query.length <= 200)) &&
        (request.status === undefined || ['all', 'implemented', 'unimplemented', 'unknown'].includes(request.status as string));
    }
    case 'BROWSE_REFERENCE_FOLDERS':
      return hasOnlyKeys(message, ['type', 'requestId']) && isOpaqueIdentifier(message.requestId);
    case 'ADD_TARGET_WORKSPACE':
      return hasOnlyKeys(message, ['type', 'mode']) && typeof message.mode === 'string' && ['browse', 'input', 'workspace'].includes(message.mode);
    case 'READY':
    case 'CONFIGURE_MODEL_KEY':
    case 'CLEAR_MODEL_KEY':
    case 'APPLY_CURRENT_RUN':
    case 'CHECK_REPOSITORIES':
    case 'REFRESH_MODULE_EXPLORER':
    case 'COPY_TARGET_PATH':
    case 'REVEAL_TARGET_IN_EXPLORER':
    case 'OPEN_TARGET':
      return hasOnlyKeys(message, ['type']);
    case 'SAVE_SETTINGS':
      return (
        Object.keys(message).every(key => ['type', 'settings', 'modelKey'].includes(key)) &&
        isPanelSettings(message.settings) &&
        (message.modelKey === undefined || message.modelKey === null ||
          (typeof message.modelKey === 'string' && !validateModelKey(message.modelKey)))
      );
    case 'START_SEARCH':
      return (
        hasOnlyKeys(message, ['type', 'requirement', 'topK']) &&
        typeof message.requirement === 'string' &&
        message.requirement.length <= 8_000 &&
        Number.isInteger(message.topK) &&
        typeof message.topK === 'number' &&
        message.topK >= 1 &&
        message.topK <= 10
      );
    case 'SELECT_CANDIDATES':
      return hasOnlyKeys(message, ['type', 'candidateIds']) && Array.isArray(message.candidateIds) &&
        message.candidateIds.length <= 3 && new Set(message.candidateIds).size === message.candidateIds.length &&
        message.candidateIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256);
    case 'SELECT_CANDIDATE':
      return (
        hasOnlyKeys(message, ['type', 'candidateId']) &&
        typeof message.candidateId === 'string' &&
        message.candidateId.length > 0 &&
        message.candidateId.length <= 256
      );
    case 'RETRY_PROJECT_ANALYSIS':
      return hasOnlyKeys(message, ['type', 'repositoryId', 'analysisRevision', 'projectId', 'force']) &&
        [message.repositoryId, message.analysisRevision, message.projectId].every((id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(id)) && typeof message.force === 'boolean';
    case 'REFRESH_REPOSITORY':
      return hasOnlyKeys(message, ['type', 'repositoryId']) && typeof message.repositoryId === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(message.repositoryId);
    case 'SELECT_WORKSPACE_TARGET':
      return (
        hasOnlyKeys(message, ['type', 'targetId']) &&
        typeof message.targetId === 'string' &&
        message.targetId.length > 0 &&
        message.targetId.length <= 512
      );
    case 'SELECT_CODE_INTELLIGENCE_REVISION':
      return (
        hasOnlyKeys(message, ['type', 'repositoryId', 'analysisRevision']) &&
        isOpaqueIdentifier(message.repositoryId) &&
        isOpaqueIdentifier(message.analysisRevision)
      );
    case 'SELECT_CODE_INTELLIGENCE_PROJECT':
      return (
        hasOnlyKeys(message, ['type', 'repositoryId', 'analysisRevision', 'projectId']) &&
        isOpaqueIdentifier(message.repositoryId) &&
        isOpaqueIdentifier(message.analysisRevision) &&
        isOpaqueIdentifier(message.projectId)
      );
    case 'START_ADAPT':
      return (
        hasOnlyKeys(message, ['type', 'decisionNotes']) &&
        typeof message.decisionNotes === 'string' &&
        message.decisionNotes.length <= 8_000
      );
    default:
      return false;
  }
}

/** IDs are looked up by the host; this rejects control data, not local paths. */
function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Correlation ids the host echoes back to the Webview.  A target module id is a
 * `module://` URI (`project-explorer.ts`), so the opaque-id charset cannot apply
 * here: requiring it made the Webview drop every module translation handoff,
 * which looked exactly like a service that never started.  Control characters
 * are still refused.
 */
function isCorrelationIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPanelSettings(value: unknown): value is PanelSettingsPresentation {
  if (typeof value !== 'object' || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    (hasOnlyKeys(settings, ['repositoryPaths', 'topK']) || hasOnlyKeys(settings, ['repositoryPaths', 'topK', 'llm'])) &&
    (settings.llm === undefined || isLlmSettings(settings.llm)) &&
    Array.isArray(settings.repositoryPaths) &&
    settings.repositoryPaths.length <= 20 &&
    settings.repositoryPaths.every(
      // An emptied draft row and a pasted "Copy as path" value are both ordinary
      // input, not malformed messages: the host unquotes them and drops what is
      // left empty, so refusing the whole save here would silently lose the edit.
      (path) => typeof path === 'string' && path.length <= 1_000 && !/[\u0000-\u001f\u007f]/.test(path),
    ) &&
    typeof settings.topK === 'number' &&
    Number.isInteger(settings.topK) &&
    settings.topK >= 1 &&
    settings.topK <= 10
  );
}

function isLlmSettings(value: unknown): value is LlmSettings {
  try { parseLlmSettings(value); return true; } catch { return false; }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const received = Object.keys(value);
  return received.length === keys.length && received.every((key) => keys.includes(key));
}

export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown; phase?: unknown; outcome?: unknown; mode?: unknown; message?: unknown };
  if (typeof message.type !== 'string' || !hostMessageTypes.has(message.type)) return false;
  if (message.type === 'MODULE_TRANSLATION_READY') {
    const ready = value as Record<string, unknown>;
    return isCorrelationIdentifier(ready.targetId) && isCorrelationIdentifier(ready.candidateId) &&
      (ready.candidateIds === undefined || Array.isArray(ready.candidateIds) && ready.candidateIds.length <= 3 &&
        new Set(ready.candidateIds).size === ready.candidateIds.length && ready.candidateIds.every(isCorrelationIdentifier)) &&
      typeof ready.moduleScopeId === 'string' && /^[a-f0-9]{64}$/.test(ready.moduleScopeId);
  }
  // The phase and outcome literals select the progress UI, so they are
  // verified instead of being trusted by the message name alone.
  if (message.type === 'TARGET_WORKSPACE_PROGRESS') return isTargetWorkspaceProgress(message);
  if (message.type === 'TARGET_WORKSPACE_RESULT') return isTargetWorkspaceResult(message);
  return true;
}
