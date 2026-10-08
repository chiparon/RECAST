import { LLM_PRESETS } from '@forexplore/contracts';
import { browseReferenceFolders } from './reference-folder-picker';
import { RecastLogo } from './components/RecastLogo';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { GitBranch, Settings2 } from 'lucide-react';
import { createTranslationProvider } from './workspace-translation-provider';
import { AgentRunLog, WorkspaceTranslation } from './components/WorkspaceTranslation';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import type { CodeIntelligencePresentation, RepositoryStatus, ServiceStatus } from '../../src/ui-types';
import type { ModuleExplorerMode, ModuleExplorerNode } from '../../src/ui-types';
import {
  initialWorkflowState,
  getStepStatus,
  selectedCandidate,
  workflowReducer,
  type WorkflowStage,
  type WorkflowState,
} from '@forexplore/workflow-core';
import type { PanelInitPayload, PanelSettingsPresentation } from '../../src/protocol/messages';
import { AdaptationStage } from './components/AdaptationStage';
import { CandidatesStage } from './components/CandidatesStage';
import { FooterStatus } from './components/FooterStatus';
import { PatchStage } from './components/PatchStage';
import { RequirementStage } from './components/RequirementStage';
import { StepRail } from './components/StepRail';
import { ModuleWorkspace } from './components/ModuleWorkspace';
import { idleTargetAdd, type TargetAddUiState } from './components/ProjectPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { errorEvent } from './errors';
import { createMessageBus, type MessageBus } from './vscode-api';
import { createModuleChildrenProvider } from './module-children-provider';

/**
 * A workspace-folder update can recreate the extension host between the
 * `added` notification and the final `completed` notification. In that case
 * the Webview still receives the durable index presentation, but never sees
 * the transient result message. Reconcile the local progress state from the
 * host-owned repository lifecycle so an old spinner cannot mask a ready tree.
 */
function reconcileTargetAddFromIndex(
  current: TargetAddUiState,
  presentation: CodeIntelligencePresentation,
  knownTargetIds: ReadonlySet<string> = new Set(),
): TargetAddUiState {
  if (current.status === 'notice') return current;
  if (current.status === 'pending' && current.retryPending) return current;
  // A window can remember more than one target directory. During an import,
  // an already-ready target must not settle the spinner for a different target
  // that is still being registered or indexed.
  const candidates = presentation.repositories
    .filter((repository) => repository.role === 'target' && (current.repositoryId
      ? repository.repositoryId === current.repositoryId : !knownTargetIds.has(repository.repositoryId)));
  if (current.status === 'idle' && !candidates.some(repository => repository.analysisStatus === 'failed')) return current;
  if (current.status === 'failed' && !current.repositoryId && !candidates.some(repository => repository.analysisStatus === 'failed')) return current;
  const allCandidatesReady = candidates.length > 1 && candidates.every((repository) =>
    (repository.analysisStatus === 'ready' || repository.analysisStatus === 'degraded') && Boolean(repository.activeRevision));
  const target = candidates.find((repository) => repository.analysisStatus === 'failed')
    ?? candidates.find((repository) => repository.analysisStatus === 'indexing' || repository.analysisStatus === 'registered')
    ?? (candidates.length === 1 ? candidates[0]
      : allCandidatesReady ? candidates[0] : undefined);
  if (!target) return current;
  if (target.analysisStatus === 'failed') {
    return {
      status: 'failed',
      repositoryId: target.repositoryId,
      ...(current.mode ? { mode: current.mode } : {}),
      message: '目标工程索引失败，请查看 RECAST 输出日志后重试。',
    };
  }
  if ((target.analysisStatus === 'ready' || target.analysisStatus === 'degraded') && target.activeRevision) {
    return {
      status: 'notice',
      ...(current.mode ? { mode: current.mode } : {}),
      message: '目标工程已导入并完成索引。',
    };
  }
  if (current.repositoryId && target.analysisStatus === 'indexing') {
    return { ...current, status: 'pending', phase: 'indexing', message: '正在恢复目标工程索引…' };
  }
  return current;
}

function reconcileTargetAddFromExplorer(
  current: TargetAddUiState,
  explorer: PanelInitPayload['moduleExplorer'],
  knownTargetIds: ReadonlySet<string> = new Set(),
): TargetAddUiState {
  // A retry can still display the previous active tree while indexing. Only
  // the repository lifecycle can settle that explicitly identified attempt.
  if (current.repositoryId) return current;
  if (current.status !== 'pending' || explorer.target.id === 'target:unselected' || !explorer.target.revision) return current;
  if (explorer.target.repositoryId
    ? knownTargetIds.has(explorer.target.repositoryId)
    : knownTargetIds.size > 0) return current;
  return {
    status: 'notice',
    ...(current.mode ? { mode: current.mode } : {}),
    message: '目标工程已导入并完成索引。',
  };
}

export default function App() {
  const bus: MessageBus = useMemo(() => createMessageBus(), []);
  const translation = useMemo(() => createTranslationProvider(bus), [bus]);
  const loadModuleChildren = useMemo(() => createModuleChildrenProvider(bus), [bus]);
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [payload, setPayload] = useState<PanelInitPayload | null>(null);
  const [repositoryStatuses, setRepositoryStatuses] = useState<RepositoryStatus[]>([]);
  const [codeIntelligence, setCodeIntelligence] = useState<CodeIntelligencePresentation | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [moduleExplorer, setModuleExplorer] = useState<PanelInitPayload['moduleExplorer'] | null>(null);
  const [explorerMode, setExplorerMode] = useState<ModuleExplorerMode>('target');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [refreshingExplorer, setRefreshingExplorer] = useState(false);
  const [targetAdd, setTargetAdd] = useState<TargetAddUiState>(idleTargetAdd);
  const [visibleStep, setVisibleStep] = useState<WorkflowStage>('target');
  const [moduleTranslation, setModuleTranslation] = useState<{ moduleScopeId: string } | null>(null);
  const [translationRun, setTranslationRun] = useState<WorkspaceTranslationRun>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState('');
  useEffect(() => {
    bus.post({ type: 'SETTINGS_VISIBILITY_CHANGED', open: settingsOpen });
    setSettingsSaveMessage('');
  }, [bus, settingsOpen]);
  const [modelKeyStatus, setModelKeyStatus] = useState<{ configured: boolean; message?: string }>({ configured: false });
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<WorkflowState['pending']>(null);
  const targetIdRef = useRef<string | null>(null);
  const candidateIdRef = useRef<string | null>(null);
  const candidateIdsRef = useRef<string[]>([]);
  const settingsRef = useRef<PanelSettingsPresentation>({ repositoryPaths: [], topK: 4 });
  // The host reports phases, not the entry point that was used, so the mode is
  // remembered here to make the retry button replay the same action.
  const targetAddModeRef = useRef<TargetAddUiState['mode']>(undefined);
  const targetAddStartTargetIdsRef = useRef<ReadonlySet<string>>(new Set());
  pendingRef.current = state.pending;
  targetIdRef.current = state.target?.id ?? null;
  candidateIdRef.current = state.selectedCandidateId;
  candidateIdsRef.current = state.selectedCandidateIds?.length ? state.selectedCandidateIds : (state.selectedCandidateId ? [state.selectedCandidateId] : []);

  useEffect(() => {
    bus.post({ type: 'READY' });
    return bus.subscribe((message) => {
      switch (message.type) {
        case 'REQUEST_SETTINGS_SAVE':
          window.dispatchEvent(new Event('recast-save-settings'));
          break;
        case 'INIT':
          settingsRef.current = message.payload.settings;
          setPayload(message.payload);
          setRepositoryStatuses(message.payload.repositoryStatuses);
          setCodeIntelligence(message.payload.codeIntelligence);
          setServiceStatus(message.payload.serviceStatus);
          setModuleExplorer(message.payload.moduleExplorer);
          setTargetAdd((current) => reconcileTargetAddFromIndex(
            reconcileTargetAddFromExplorer(current, message.payload.moduleExplorer, targetAddStartTargetIdsRef.current),
            message.payload.codeIntelligence,
            targetAddStartTargetIdsRef.current,
          ));
          setHistoryId((current) => current ?? message.payload.moduleExplorer.history[0]?.id ?? null);
          setError(null);
          if (message.payload.target && targetIdRef.current !== message.payload.target.id) {
            dispatch({ type: 'SELECT_TARGET', target: message.payload.target });
            setVisibleStep('requirement');
          }
          dispatch({ type: 'SET_TOP_K', value: message.payload.settings.topK });
          break;
        case 'SEARCH_RESULT':
          setModuleTranslation(null);
          dispatch({ type: 'SEARCH_SUCCESS', candidates: message.candidates });
          break;
        case 'MODULE_TRANSLATION_READY':
          // Dropping a reply for another selection used to leave this panel
          // waiting forever with no error, which reads as "translation is
          // running" while nothing is. Report it and release the pending state.
          const directFallback = message.candidateId === 'direct-fallback';
          const selectionMismatch = message.candidateIds
            ? JSON.stringify(message.candidateIds) !== JSON.stringify(candidateIdsRef.current)
            : candidateIdsRef.current.length > 1;
          if (message.targetId !== targetIdRef.current || selectionMismatch || (directFallback ? candidateIdRef.current !== null : message.candidateId !== candidateIdRef.current)) {
            const reason = '宿主返回的模块翻译作用域不属于当前选择的模块候选；请重新选择候选后再发起翻译。';
            setError(reason);
            dispatch({ type: 'ADAPT_FAILURE', message: reason });
            break;
          }
          setModuleTranslation({ moduleScopeId: message.moduleScopeId });
          dispatch({ type: 'MODULE_TRANSLATION_READY' });
          break;
        case 'ADAPT_RESULT':
          dispatch({ type: 'ADAPT_SUCCESS', result: message.result });
          break;
        case 'APPLY_RESULT':
          dispatch({ type: 'APPLY_SUCCESS', result: message.result });
          break;
        case 'REPOSITORY_STATUS':
          setRepositoryStatuses(message.statuses);
          break;
        case 'CODE_INTELLIGENCE_STATUS':
          setCodeIntelligence(message.presentation);
          setTargetAdd((current) => reconcileTargetAddFromIndex(current, message.presentation, targetAddStartTargetIdsRef.current));
          break;
        case 'SERVICE_STATUS':
          setServiceStatus(message.status);
          break;
        case 'MODULE_EXPLORER':
          setModuleExplorer(message.explorer);
          setTargetAdd((current) => reconcileTargetAddFromExplorer(current, message.explorer, targetAddStartTargetIdsRef.current));
          setHistoryId((current) =>
            message.explorer.history.some((repository) => repository.id === current)
              ? current
              : message.explorer.history[0]?.id ?? null,
          );
          setRefreshingExplorer(false);
          break;
        case 'TARGET_WORKSPACE_PROGRESS':
          // Phases arrive before, during and after the host mutations, so the
          // pending state is never inferred from a single message.
          setTargetAdd(current => ({ ...(current.status === 'pending' && message.phase !== 'selecting' ? current : {}),
            status: 'pending', phase: message.phase, message: message.message,
            ...(targetAddModeRef.current ? { mode: targetAddModeRef.current } : {}) }));
          break;
        case 'TARGET_WORKSPACE_RESULT':
          targetAddModeRef.current = message.mode;
          if (message.outcome === 'failed') {
            setTargetAdd(current => ({ ...current, status: 'failed', mode: message.mode,
              message: message.message ?? '添加目标工程失败，请重试。' }));
          } else if (message.outcome === 'cancelled') {
            setTargetAdd({ status: 'notice', mode: message.mode, message: message.message ?? '已取消选择目标工程。' });
          } else if (message.outcome === 'added') {
            setTargetAdd({ status: 'pending', mode: message.mode, phase: 'indexing',
              message: message.message ?? '正在解析目录并建立结构索引…' });
          } else {
            setTargetAdd({ status: 'notice', mode: message.mode, message: message.message ?? '目标工程已添加。' });
          }
          break;
        case 'TARGET_SELECTED':
          setModuleTranslation(null);
          setPayload((current) => current ? { ...current, target: message.target } : current);
          dispatch({ type: 'SELECT_TARGET', target: message.target });
          dispatch({ type: 'SET_TOP_K', value: settingsRef.current.topK });
          setVisibleStep('requirement');
          setExplorerMode('target');
          setSelectedNodeId(null);
          setSettingsOpen(false);
          break;
        case 'TARGET_CLEARED':
          setModuleTranslation(null);
          dispatch({ type: 'RESET' });
          setPayload((current) => current ? { ...current, target: null } : current);
          setSelectedNodeId(null);
          setVisibleStep('target');
          break;
        case 'SETTINGS_UPDATED':
          setSettingsSaveMessage('设置已保存');
          settingsRef.current = message.settings;
          setPayload((current) => current ? { ...current, settings: message.settings } : current);
          dispatch({ type: 'SET_TOP_K', value: message.settings.topK });
          setSettingsSaving(false);
          break;
        case 'MODEL_KEY_STATUS':
          setModelKeyStatus({ configured: message.configured, message: message.message });
          break;
        case 'ERROR': {
          setError(message.message);
          setRefreshingExplorer(false);
          setSettingsSaving(false);
          const event = errorEvent(pendingRef.current, message.message);
          if (event) dispatch(event);
          break;
        }
      }
    });
  }, [bus]);

  useEffect(() => {
    setVisibleStep(state.stage === 'complete' ? 'patch' : state.stage);
  }, [state.stage]);

  // A reply that never arrives must not look like an eternal translation. The
  // host is still free to finish: a late result still moves this panel on.
  useEffect(() => {
    if (state.pending !== 'adapt') return;
    const timer = setTimeout(() => {
      const reason = '宿主在 10 分钟内没有回复翻译请求；已复位本次等待。若宿主随后返回结果，面板会自动更新。';
      setError(reason);
      dispatch({ type: 'ADAPT_FAILURE', message: reason });
    }, 600_000);
    return () => clearTimeout(timer);
  }, [state.pending]);

  function handleSearch(): void {
    if (!state.target) return;
    setModuleTranslation(null);
    setError(null);
    dispatch({ type: 'SEARCH_START' });
    bus.post({
      type: 'START_SEARCH',
      requirement: state.requirement.trim(),
      topK: state.topK,
    });
  }

  function handleAdapt(): void {
    const candidate = selectedCandidate(state);
    const directFallback = state.target?.kind === 'module' && state.candidates.length === 0 && state.requirement.trim().length > 0;
    if (!state.target || (!candidate && !directFallback)) return;
    setError(null);
    dispatch({ type: 'ADAPT_START' });
    bus.post({
      type: 'START_ADAPT',
      decisionNotes: state.decisionNotes,
    });
  }

  function handleApply(): void {
    if (!state.adaptation) return;
    setError(null);
    dispatch({ type: 'APPLY_START' });
    bus.post({ type: 'APPLY_CURRENT_RUN' });
  }

  function handleCheckRepositories(): void {
    setError(null);
    bus.post({ type: 'CHECK_REPOSITORIES' });
  }

  function handleSelectCandidate(candidateId: string): void {
    if (state.target?.kind === 'module') {
      const previous = state.selectedCandidateIds?.length ? state.selectedCandidateIds : (state.selectedCandidateId ? [state.selectedCandidateId] : []);
      const next = previous.includes(candidateId) ? previous.filter(id => id !== candidateId) : [...previous, candidateId];
      if (next.length > 3) { setError('最多选择 3 个参考模块。'); return; }
      const candidateIds = state.candidates.slice(0, 4).filter(candidate => next.includes(candidate.id)).map(candidate => candidate.id);
      setModuleTranslation(null); setError(null);
      dispatch({ type: 'SELECT_CANDIDATES', candidateIds });
      bus.post({ type: 'SELECT_CANDIDATES', candidateIds });
      return;
    }
    setModuleTranslation(null);
    dispatch({ type: 'SELECT_CANDIDATE', candidateId });
    bus.post({ type: 'SELECT_CANDIDATE', candidateId });
  }

  function handleOpenTarget(): void {
    bus.post({ type: 'OPEN_TARGET' });
  }

  function handleCopyTargetPath(): void {
    bus.post({ type: 'COPY_TARGET_PATH' });
  }

  function handleRevealTargetInExplorer(): void {
    bus.post({ type: 'REVEAL_TARGET_IN_EXPLORER' });
  }

  function handleRefreshModuleExplorer(): void {
    setError(null);
    setRefreshingExplorer(true);
    bus.post({ type: 'REFRESH_MODULE_EXPLORER' });
  }

  function handleSaveSettings(settings: PanelSettingsPresentation, modelKey?: string | null): void {
    setError(null);
    setSettingsSaving(true);
    setSettingsSaveMessage('');
    bus.post({ type: 'SAVE_SETTINGS', settings, ...(modelKey !== undefined ? { modelKey } : {}) });
  }

  function handleSelectCodeIntelligenceRevision(repositoryId: string, analysisRevision: string): void {
    setError(null);
    bus.post({ type: 'SELECT_CODE_INTELLIGENCE_REVISION', repositoryId, analysisRevision });
  }

  function handleSelectCodeIntelligenceProject(
    repositoryId: string,
    analysisRevision: string,
    projectId: string,
  ): void {
    setError(null);
    bus.post({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT', repositoryId, analysisRevision, projectId });
  }

  function handleAddTarget(mode: 'browse' | 'input' | 'workspace'): void {
    setError(null);
    targetAddModeRef.current = mode;
    targetAddStartTargetIdsRef.current = new Set(
      (codeIntelligence?.repositories ?? [])
        .filter((repository) => repository.role === 'target')
        .map((repository) => repository.repositoryId),
    );
    // A click must produce feedback immediately; the host's first phase only
    // arrives after the native dialog is already being opened.
    setTargetAdd({ status: 'pending', mode, phase: 'selecting' });
    bus.post({ type: 'ADD_TARGET_WORKSPACE', mode });
  }

  function handleSelectWorkspaceTarget(targetId: string): void {
    if (targetId === state.target?.id) return;
    setError(null);
    bus.post({ type: 'SELECT_WORKSPACE_TARGET', targetId });
  }

  function handleExplorerModeChange(mode: ModuleExplorerMode): void {
    setSettingsOpen(false);
    setExplorerMode(mode);
    setSelectedNodeId(null);
    if (
      mode === 'history' &&
      moduleExplorer?.history.some((repository) => repository.loading) &&
      !refreshingExplorer
    ) {
      handleRefreshModuleExplorer();
    }
  }

  function handleStepChange(step: WorkflowStage): void {
    if (getStepStatus(step, state.stage) === 'upcoming') return;
    setExplorerMode('target');
    setSettingsOpen(false);
    setVisibleStep(step);
  }

  if (!payload || !moduleExplorer) {
    return (
      <div className="app">
        <div className="loading-state">正在初始化 RECAST 智能开发工作台…</div>
      </div>
    );
  }

  const candidate = selectedCandidate(state);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <RecastLogo />
          <strong>RECAST</strong>
        </div>
        <div className="workbench-mode-label"><GitBranch size={14} />复用迁移</div>
        <button
          type="button"
          className={`header-settings-button${settingsOpen ? ' is-active' : ''}`}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-pressed={settingsOpen}
        >
          <Settings2 size={14} /> 设置
        </button>
      </header>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <ModuleWorkspace
        repositories={codeIntelligence?.repositories ?? []}
        onSelectProject={(repositoryId, revision, projectId) => {
          setSelectedNodeId(null);
          setTargetAdd(idleTargetAdd);
          if (explorerMode === 'history') setHistoryId(repositoryId);
          handleSelectCodeIntelligenceProject(repositoryId, revision, projectId);
        }}
        onRefreshRepository={(repositoryId) => {
          setError(null);
          setRefreshingExplorer(true);
          if (codeIntelligence?.repositories.some(repository => repository.repositoryId === repositoryId && repository.role === 'target')) {
            setTargetAdd({ status: 'pending', repositoryId, retryPending: true, phase: 'indexing', message: '正在准备目标工程索引…' });
          }
          bus.post({ type: 'REFRESH_REPOSITORY', repositoryId });
        }}
        onAddTarget={handleAddTarget}
        targetAdd={targetAdd}
        explorer={moduleExplorer}
        onLoadChildren={loadModuleChildren}
        mode={explorerMode}
        historyId={historyId}
        currentTargetId={state.target?.id ?? ''}
        selectedNodeId={selectedNodeId}
        refreshing={refreshingExplorer}
        onModeChange={handleExplorerModeChange}
        onHistoryChange={(id) => { setHistoryId(id); setSelectedNodeId(null); }}
        onNodeSelect={(node: ModuleExplorerNode) => { setSelectedNodeId(node.id); setSettingsOpen(false); }}
        onTargetSelect={handleSelectWorkspaceTarget}
        onRefresh={handleRefreshModuleExplorer}
        onRetry={(scope, force) => bus.post({ type: 'RETRY_PROJECT_ANALYSIS', ...scope, force })}
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
        afterUnderstanding={<AgentRunLog run={translationRun} enabled={Boolean(moduleTranslation)} />}
      >
        {settingsOpen ? (
          <SettingsPanel
            llm={payload.settings.llm}
            onBrowseReferenceFolders={() => browseReferenceFolders(bus)}
            modelKeyStatus={modelKeyStatus}
            topK={payload.settings.topK}
            repositoryPaths={payload.settings.repositoryPaths}
            repositoryStatuses={repositoryStatuses}
            codeIntelligence={codeIntelligence}
            saving={settingsSaving}
            saveMessage={settingsSaveMessage}
            onCheckRepositories={handleCheckRepositories}
            onSelectCodeIntelligenceRevision={handleSelectCodeIntelligenceRevision}
            onSelectCodeIntelligenceProject={handleSelectCodeIntelligenceProject}
            onSave={handleSaveSettings}
            onCancel={() => setSettingsOpen(false)}
          />
        ) : (
          <main className="stage-body">
            <div className="migration-progress"><StepRail stage={state.stage} activeStep={visibleStep} onStepChange={handleStepChange} /></div>
            {!state.target ? <div className="context-empty"><GitBranch size={25} /><strong>选择待实现的目标模块</strong></div> : null}
            {visibleStep === 'requirement' && state.target ? (
              <RequirementStage
                key={state.target.id}
                state={state}
                target={state.target}
                dispatch={dispatch}
                onSearch={handleSearch}
                onCopyTargetPath={handleCopyTargetPath}
                onRevealTarget={handleRevealTargetInExplorer}
              />
            ) : null}

            {visibleStep === 'candidates' ? (
              <CandidatesStage
                state={state}
                dispatch={dispatch}
                adaptationProvider={LLM_PRESETS[payload.settings.llm?.provider ?? 'deepseek'].label}
                onSelectCandidate={handleSelectCandidate}
                onAdapt={handleAdapt}
              />
            ) : null}

            {moduleTranslation ? <div hidden={visibleStep !== 'adaptation' && visibleStep !== 'patch'}>
              <WorkspaceTranslation key={moduleTranslation.moduleScopeId} provider={translation} moduleScopeId={moduleTranslation.moduleScopeId}
                onFinished={(completed) => dispatch({ type: 'MODULE_TRANSLATION_FINISHED', completed })}
                onRunChange={setTranslationRun} />
            </div> : null}
            {visibleStep === 'adaptation' && !moduleTranslation ? (
              <AdaptationStage state={state} candidate={candidate}
                onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
                onRetry={handleAdapt} />
            ) : null}

            {visibleStep === 'patch' && state.adaptation ? (
              <PatchStage
                state={state}
                onApply={handleApply}
                onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
                onOpenTarget={handleOpenTarget}
              />
            ) : null}
          </main>
        )}
      </ModuleWorkspace>

      <FooterStatus
        serviceStatus={serviceStatus}
        repositoryStatuses={repositoryStatuses}
        codeIntelligence={codeIntelligence}
        workspaceRoot={payload.workspaceRoot}
      />
    </div>
  );
}
