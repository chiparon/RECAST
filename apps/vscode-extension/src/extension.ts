import { createModelCredentialProvider, modelCredentialId, modelKeyRefusalReason, validateModelKey, saveWithModelCredential } from './model-credential';
import { setModelCredentialProvider } from './local-fetch';
import { BackendProcess, type BackendLaunchConfiguration } from './backend-process';
import { ConfiguredModelReranker } from './model-reranker';
import { WorkspaceTranslationHost } from './workspace-translation-host';
import { prepareDirectModuleTranslationScope, prepareModuleTranslationScope } from './module-translation-handoff';
import { localFetch } from './local-fetch';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
import type {
  AdaptationResult,
  FilePatch,
  ModuleTarget,
  SearchCandidate,
  ValidationRecord,
} from '@forexplore/contracts';
import { requestSemanticModuleMigrationProposal } from './module-plan-client';
import { HttpModuleHierarchyPlanner } from './module-hierarchy-client';
import {
  applyHunksStrict,
  canApplyAdaptation,
  evaluateValidationGate,
} from '@forexplore/workflow-core';
import { WorkspaceBackfill } from './backfill';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  type SynchronizeCodeIntelligenceRequest,
} from './code-intelligence-host';
import { indexingProgressMessage, isIndexingCancellation, retrievalAvailable,
  type RepositoryIndexingProgress } from './indexing-progress';
import { canonicalWorkspacePath } from './diff-apply';
import {
  ModuleMigrationHost,
  ModuleMigrationPreviewProvider,
  moduleMigrationPreviewScheme,
} from './module-migration-host';
import type { ModuleWaveExecutionPort } from './module-wave-execution-host';
import type { ModuleMigrationWaveRecoveryPort } from './module-migration-recovery';
import { TranslationPanel, workbenchViewType, type PanelHandlers } from './panel';
import { createPanelHandlers, publishPanelMessage } from './panel-handlers';
import { errorMessage } from './error-message';
import { buildProjectExplorer, readExplorerChildren, type ExplorerChildrenIndex } from './project-explorer';
import type {
  HostToWebviewMessage,
  PanelInitPayload,
  TargetWorkspaceAddMode,
  WebviewToHostMessage,
} from './protocol/messages';
import { RepositoryHealthCheck } from './repository-health';
import { decorateRepositoryStatuses } from './repository-status';
import { ServiceManager } from './service-manager';
import { loadSettings, savePanelSettings, type ExtensionSettings } from './settings';
import { loadPreloadedBindings, preloadedRepositoryId } from './preloaded-workspace';
import {
  addTargetWorkspace,
  pendingTargetImportKey,
  readPendingTargetImport,
  sameTargetPath,
  selectedTargetWorkspaceFolders,
  type PendingTargetImport,
} from './target-workspace';
import type { CodeIntelligencePresentation, RepositoryStatus } from './ui-types';
import { targetImportVerdict } from './target-import-outcome';

// Keep the transaction implementation bundled by esbuild without making the
// extension's strict typecheck re-check the service's broader source tree.
const GitWaveTransaction = require('@forexplore/adaptation-service/git-wave-transaction').GitWaveTransaction as {
  new (): ModuleMigrationWaveRecoveryPort;
};

// The narrow service entrypoint keeps the trusted wave coordinator available
// to the extension without bundling the HTTP/model service composition.
const ModuleWaveExecutionCoordinator = require('@forexplore/adaptation-service/module-wave-execution').ModuleWaveExecutionCoordinator as {
  new (): ModuleWaveExecutionPort;
};

interface ExtensionHost {
  context: vscode.ExtensionContext;
  services: ServiceManager;
  health: RepositoryHealthCheck;
  codeIntelligence: CodeIntelligenceHost;
  /** The RECAST channel; a panel action that leaves no line here is undiagnosable. */
  output: vscode.OutputChannel;
}

type SynchronizationOptions = Omit<SynchronizeCodeIntelligenceRequest, 'repositories'>;
type IndexingControls = Pick<SynchronizationOptions, 'signal' | 'onProgress'>;

interface ActiveMigrationRun {
  workspaceFolder: vscode.WorkspaceFolder;
  targetUri: vscode.Uri;
  target: ModuleTarget;
  /** Exact bytes read before retrieval / adaptation began. */
  originalSha256: string;
  originalContent: string;
  requirement: string;
  candidates: SearchCandidate[];
  /** Null until the user expressly clicks a candidate in this run. */
  selectedCandidateId: string | null;
  selectedCandidateIds?: string[];
  adaptation: AdaptationResult | null;
}

interface LastCheckpoint {
  checkpointId: string;
  workspaceUri: string;
  targetPath: string;
}

let activeBackend: BackendProcess | undefined;
let activeServices: ServiceManager | undefined;
function backendEndpoint(): string { return activeBackend?.url ?? loadSettings().adaptationApiUrl; }
const workspaceTranslation = new WorkspaceTranslationHost(() => ({ url: backendEndpoint(),
  token: activeBackend?.translationToken ?? process.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN, profile: process.env.FOREXPLORE_TRANSLATION_PROFILE }),
  (url, init) => localFetch(String(url), init));
let moduleSelectionVersion = 0;
function invalidateModuleTranslation(): void { moduleSelectionVersion++; workspaceTranslation.clearModuleScope(); }
let activeRun: ActiveMigrationRun | null = null;
let moduleExplorerTargets = new Map<string, ModuleTarget>();
let moduleExplorerChildren: ExplorerChildrenIndex = new Map();
let activeCodeIntelligenceHost: CodeIntelligenceHost | null = null;
let preloadedRepositoryBindings = new Map<string, string>();
let preloadedProjectBindings = new Map<string, string>();
/** One-shot startup chain, created by the first explicit use of the workbench. */
let codeIntelligenceStartup: Promise<void> | undefined;
let startupCancellation: AbortController | undefined;
const startupProgressListeners = new Set<(progress: RepositoryIndexingProgress) => void>();

/**
 * The preloaded launcher points the host at a database whose revisions and
 * module artifacts were built before the window opened. It is intentionally
 * an environment opt-in so the normal development entry keeps its existing
 * scan and modeling behavior.
 */
function isPreloadedLaunch(): boolean {
  return process.env.FOREXPLORE_PRELOADED === '1';
}

function preloadedSynchronizationOptions(): Pick<SynchronizationOptions, 'scan' | 'repairStaleIndexing'> {
  return isPreloadedLaunch() ? { scan: false, repairStaleIndexing: true } : {};
}

/**
 * An isolated preloaded profile cannot read the ordinary profile's
 * SecretStorage. The launcher still inherits the process environment, so a
 * default DeepSeek key (or an explicitly supplied preloaded key) can be used
 * without copying encrypted credential files between profiles.
 */
function preloadedModelApiKey(): string | undefined {
  if (!isPreloadedLaunch()) return undefined;
  const explicit = process.env.FOREXPLORE_MODEL_KEY?.trim();
  if (explicit) return explicit;
  const settings = loadSettings().llm;
  if (settings.provider === 'deepseek' && settings.apiBase === DEFAULT_LLM_SETTINGS.apiBase) {
    return process.env.DEEPSEEK_API_KEY?.trim() || undefined;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const preloadedBindings = loadPreloadedBindings();
  preloadedRepositoryBindings = preloadedBindings.repositoryIds;
  preloadedProjectBindings = preloadedBindings.projectIds;
  setModelCredentialProvider(createModelCredentialProvider(context.secrets, () => loadSettings().adaptationApiUrl,
    () => loadSettings().llm, backendEndpoint, preloadedModelApiKey));
  context.subscriptions.push({ dispose: () => setModelCredentialProvider(undefined) });
  context.subscriptions.push(
    context.secrets.onDidChange(() => { void publishModelKeyStatus(context); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('forexplore.adaptationApiUrl') || event.affectsConfiguration('forexplore.llm')) void publishModelKeyStatus(context);
    }),
  );
  const output = vscode.window.createOutputChannel('RECAST');
  activeOutput = output;
  let codeIntelligence: CodeIntelligenceHost;
  const backend = new BackendProcess(async () => {
    const configuration = vscode.workspace.getConfiguration('forexplore');
    const workspaceRoot = activeRun?.workspaceFolder.uri.fsPath ?? selectedTargetWorkspaceFolders()[0]?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) throw new Error('请先打开目标工程。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，再启动模型后端。');
    const semanticEndpoint = await codeIntelligence.startSemanticQueryServer({
      port: positiveEnvironmentPort(process.env.FOREXPLORE_SEMANTIC_QUERY_PORT, 0),
      bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
    });
    return { url: loadSettings().adaptationApiUrl, extensionPath: context.extensionPath, workspaceRoot,
      trusted: vscode.workspace.isTrusted, autoStart: configuration.get<boolean>('backend.autoStart', true),
      dynamicPort: true,
      semanticPort: Number(new URL(semanticEndpoint).port),
      compileCommand: configuration.inspect<BackendLaunchConfiguration['compileCommand']>('backend.compileCommand')?.globalValue,
      verification: configuration.inspect<BackendLaunchConfiguration['verification']>('backend.verification')?.globalValue };
  }, message => output.appendLine(`[RECAST] ${message}`));
  activeBackend = backend;
  const services = new ServiceManager(output, backend);
  activeServices = services;
  const health = new RepositoryHealthCheck();
  try {
    const runtimeOptions = codeIntelligenceRuntimeOptionsFromEnvironment(process.env, {
      // A packaged extension must use durable SeekDB. The only memory path is
      // an explicitly non-production VS Code development/test host.
      allowInMemory: context.extensionMode !== vscode.ExtensionMode.Production,
    });
    const reranker = new ConfiguredModelReranker(backendEndpoint, () => backend.ensure(), undefined,
      () => JSON.stringify({ endpoint: loadSettings().adaptationApiUrl, llm: loadSettings().llm }));
    runtimeOptions.moduleCandidateReranker = reranker;
    codeIntelligence = new CodeIntelligenceHost({
      runtimeOptions,
      planProject: async (scope) => {
        await backend.ensure();
        return requestSemanticModuleMigrationProposal(backendEndpoint(), scope, undefined, AbortSignal.timeout(300_000));
      },
      hierarchyPlanner: new HttpModuleHierarchyPlanner(() =>
        process.env.FOREXPLORE_MODULE_HIERARCHY_URL?.trim() || backendEndpoint(),
        async (url, init) => {
          await backend.ensure();
          const endpoint = process.env.FOREXPLORE_MODULE_HIERARCHY_URL?.trim() ? url
            : new URL(new URL(typeof url === 'string' ? url : url instanceof URL ? url : url.url).pathname, backendEndpoint()).toString();
          return localFetch(endpoint, init);
        }),
      onChange: () => { void publishProjectView(codeIntelligence).catch((error) => output.appendLine(String(error))); },
      modelKeyRefusal: () => modelKeyRefusalReason(context.secrets, loadSettings().adaptationApiUrl, loadSettings().llm, preloadedModelApiKey),
      onModelRefusal: (reason) => reportModelRefusal(context, reason),
      identityStore: context.globalState,
      initialSelectedProjects: preloadedProjectBindings,
      output,
    });
  } catch (error) {
    const startupError = error instanceof Error ? error : new Error(String(error));
    output.appendLine(`[forexplore] invalid code intelligence configuration: ${startupError.message}`);
    codeIntelligence = new CodeIntelligenceHost({
      runtimeFactory: async () => Promise.reject(startupError),
      identityStore: context.globalState,
      output,
      storageKind: 'seekdb',
    });
  }
  activeCodeIntelligenceHost = codeIntelligence;
  const moduleMigrationPreviews = new ModuleMigrationPreviewProvider();
  const moduleMigration = new ModuleMigrationHost({
    context,
    services,
    output,
    previews: moduleMigrationPreviews,
    waveRecovery: new GitWaveTransaction(),
    waveExecution: new ModuleWaveExecutionCoordinator(),
    onCompilerProbeAnalysisReady: async ({ workspaceFolder, analysis }) => {
      // The compatibility analyzer remains the producer of this snapshot.
      // Only the trusted host can bind its compiler-confirmed subset to the
      // already-active structural revision; Agent/MCP/Webview code receives
      // the resulting semantic evidence through SemanticQueryPort only.
      const binding = await codeIntelligence.bindJavaCsharpCompilerProbeEvidence({
        localPath: workspaceFolder.uri.fsPath,
        analysis,
      });
      output.appendLine(
        binding.status === 'bound'
          ? `[forexplore] Java/C# compiler-probe evidence bound to ${binding.repositoryId}/${binding.analysisRevision}.`
          : '[forexplore] Java/C# compiler-probe evidence was not bound to the active structural revision.',
      );
      publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await codeIntelligence.presentation() });
    },
    semanticPlan: async ({ workspaceFolder, objective, immutableConstraints }) => {
      await backend.ensure();
      const scope = await codeIntelligence.activeScopeForPath(workspaceFolder.uri.fsPath);
      const projectId = await codeIntelligence.selectedProjectForPath(workspaceFolder.uri.fsPath);
      return requestSemanticModuleMigrationProposal(backendEndpoint(), {
        ...scope,
        ...(projectId ? { projectId } : {}),
        objective,
        ...(immutableConstraints.length ? { immutableConstraints } : {}),
      });
    },
    onSemanticPlanApproved: async ({ workspaceFolder, result }) => {
      const scope = await codeIntelligence.activeScopeForPath(workspaceFolder.uri.fsPath);
      await codeIntelligence.publishModuleSummary({
        ...scope,
        analysisHash: result.evidence.analysisHash,
        planHash: result.evidence.planHash,
        payload: result.proposal,
      });
      publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await codeIntelligence.presentation() });
    },
  });

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('forexplore.savePanelSettings', () => { publish({ type: 'REQUEST_SETTINGS_SAVE' }); }),
    services,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // The explicit import owns the cancellable scan. A second automatic
      // scan here would run ahead of its notification and ignore its token.
      if (readPendingTargetImport(context.globalState.get(pendingTargetImportKey(vscode.env.sessionId)))) return;
      void refreshModuleExplorer(codeIntelligence, isPreloadedLaunch()
        ? { ...preloadedSynchronizationOptions() }
        : { scanNewOnly: true })
        .catch((error) => output.appendLine(String(error)));
    }),
    createWorkbenchLauncher({ context, services, health, codeIntelligence, output }, output),
    { dispose: () => codeIntelligence.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(
      moduleMigrationPreviewScheme,
      moduleMigrationPreviews,
    ),
    // Reviving the panel matters most for exactly the flow that used to break:
    // selecting a target folder adds a workspace folder, VS Code restarts this
    // host, and without a serializer the workbench simply disappears.
    vscode.window.registerWebviewPanelSerializer(workbenchViewType, {
      deserializeWebviewPanel: async (panel) => {
        const revived = await TranslationPanel.restore(panel, context,
          panelInitPayload(services, loadSettings()),
          panelHandlers({ context, services, health, codeIntelligence, output }));
        primeWorkbench({ context, services, health, codeIntelligence, output }, revived, output);
      },
    }),
    vscode.commands.registerCommand('forexplore.showPanel', () =>
      showPanel(context, services, health, codeIntelligence, output),
    ),
    vscode.commands.registerCommand('forexplore.checkRepositories', async () => {
      const index = await synchronizeCodeIntelligence(codeIntelligence, { ...preloadedSynchronizationOptions(), scan: false });
      const statuses = await refreshRepositoryStatus(services, health);
      const summary = summarizeRepositoryStatus(statuses);
      void vscode.window.showInformationMessage(
        [summary, summarizeCodeIntelligence(index)].filter(Boolean).join('；') || '未配置本地仓库路径。',
      );
    }),
    vscode.commands.registerCommand('forexplore.reindex', async () => {
      await services.refresh();
      try {
        const result = await withIndexingProgress('RECAST: 正在刷新版本化代码智能索引', controls =>
          synchronizeCodeIntelligence(codeIntelligence, { forceFull: true, ...controls }));
        await refreshRepositoryStatus(services, health);
        void vscode.window.showInformationMessage(summarizeCodeIntelligence(result) ?? '代码智能索引未发现可注册仓库。');
      } catch (error) {
        if (!isIndexingCancellation(error)) void vscode.window.showErrorMessage(errorMessage(error, '代码索引刷新失败'));
      }
    }),
    vscode.commands.registerCommand('forexplore.refreshCodeIntelligence', async () => {
      try {
        const result = await withIndexingProgress('RECAST: 正在增量刷新代码智能索引', controls =>
          synchronizeCodeIntelligence(codeIntelligence, controls));
        void vscode.window.showInformationMessage(summarizeCodeIntelligence(result) ?? '代码智能索引未发现可注册仓库。');
      } catch (error) {
        if (!isIndexingCancellation(error)) void vscode.window.showErrorMessage(errorMessage(error, '代码索引刷新失败'));
      }
    }),
    vscode.commands.registerCommand('forexplore.restoreLastCheckpoint', () =>
      restoreLastCheckpoint(context),
    ),
    vscode.commands.registerCommand('forexplore.indexModuleMigrationRepository', async () => {
      // Keep the compatibility RepositoryStaticAnalysis artifact, but ensure
      // the target first traverses the shared structural-index chain.
      await synchronizeCodeIntelligence(codeIntelligence);
      await moduleMigration.indexRepository();
    }),
    vscode.commands.registerCommand('forexplore.reviewModuleMigrationPlan', () =>
      moduleMigration.reviewPlan(),
    ),
    vscode.commands.registerCommand('forexplore.reviewModuleMigrationWave', () =>
      moduleMigration.reviewNextWave(),
    ),
    vscode.commands.registerCommand('forexplore.prepareModuleMigrationWave', () =>
      moduleMigration.prepareNextWaveFromLocalBundle(),
    ),
    vscode.commands.registerCommand('forexplore.approveModuleMigrationWave', () =>
      moduleMigration.approveAndCommitPreparedWave(),
    ),
    vscode.commands.registerCommand('forexplore.recoverModuleMigrationReview', () =>
      moduleMigration.recoverReviewState(),
    ),
  );

  // A target import interrupted by the workspace change is finished here, on
  // the host that survived it.
  void resumeInterruptedTargetImport(
    { context, services, health, codeIntelligence, output }, output,
  ).catch((error) => output.appendLine(`[forexplore] resume failed: ${String(error)}`));

  // A preloaded window is intended to open directly on the populated
  // workbench. The command is scheduled after activation so all registrations
  // above are complete; ordinary dev:extension windows never take this path.
  if (isPreloadedLaunch() && process.env.FOREXPLORE_AUTO_OPEN_PANEL === '1') {
    setTimeout(() => {
      void Promise.resolve(vscode.commands.executeCommand('forexplore.showPanel'))
        .catch((error) => output.appendLine(`[forexplore] preloaded panel failed: ${String(error)}`));
    }, 0);
  }
}

async function publishModelKeyStatus(context: vscode.ExtensionContext, message?: string): Promise<void> {
  let configured = false;
  try {
    configured = Boolean(await context.secrets.get(modelCredentialId(loadSettings().adaptationApiUrl, loadSettings().llm))) ||
      Boolean(preloadedModelApiKey());
  }
  catch { message ??= '当前后端地址不支持插件 API Key；仅支持本机地址。'; }
  // A new key (or a cleared one) makes the previous refusal stale.
  reportedModelRefusals.clear();
  publish({ type: 'MODEL_KEY_STATUS', configured, ...(message ? { message } : {}) });
}

/** Module analysis is refused without a key; say so once per configuration. */
const reportedModelRefusals = new Set<string>();

function reportModelRefusal(context: vscode.ExtensionContext, reason: string): void {
  if (reportedModelRefusals.has(reason)) return;
  reportedModelRefusals.add(reason);
  void vscode.window.showWarningMessage(reason, '配置 API Key').then((choice) => {
    if (choice === '配置 API Key') void configureModelKey(context, false);
  });
}

async function configureModelKey(context: vscode.ExtensionContext, clear: boolean): Promise<void> {
  try {
    const { adaptationApiUrl: endpoint, llm } = loadSettings();
    const id = modelCredentialId(endpoint, llm);
    if (clear) {
      await context.secrets.delete(id);
      await publishModelKeyStatus(context, '已清除当前服务在插件中保存的 Key。');
      return;
    }
    const value = await vscode.window.showInputBox({
      title: `RECAST · ${llm.provider} API Key`, password: true, ignoreFocusOut: true,
      prompt: `保存到 VS Code 加密凭据存储，由本地 AI 后端用于 ${llm.apiBase}`,
      validateInput: validateModelKey,
    });
    if (value === undefined) return;
    await context.secrets.store(id, value.trim());
    await publishModelKeyStatus(context, 'API Key 已保存，下次模型请求立即生效。');
  } catch {
    await publishModelKeyStatus(context, 'API Key 操作失败，请检查本地后端地址和 VS Code 凭据存储。');
  }
}

export function deactivate(): void {
  startupCancellation?.abort(new DOMException('扩展已关闭', 'AbortError'));
  activeServices = undefined;
  activeRun = null;
  invalidateModuleTranslation();
  moduleExplorerTargets = new Map();
  moduleExplorerChildren = new Map();
  activeCodeIntelligenceHost?.dispose();
  activeCodeIntelligenceHost = null;
}

/**
 * The workbench is a Webview panel, so this Activity Bar container exists only
 * as its launcher and its view never has items of its own. A click brings the
 * workbench forward and then dismisses the sidebar the click opened, so the
 * workbench is the only thing that appears.
 *
 * The sidebar is kept when the workbench is already the active editor: there
 * the toggle was deliberate (Ctrl+B with RECAST selected) and the view shows
 * its welcome commands instead of an empty panel.
 */
function createWorkbenchLauncher(
  host: ExtensionHost,
  output: vscode.OutputChannel,
): vscode.Disposable {
  const launcher = vscode.window.createTreeView('forexplore.launcher', {
    treeDataProvider: {
      getTreeItem: (item) => item,
      getChildren: () => [],
    },
  });
  launcher.onDidChangeVisibility(({ visible }) => {
    if (!visible) return;
    const workbenchInFront = TranslationPanel.current?.panel.active === true;
    void showPanel(host.context, host.services, host.health, host.codeIntelligence, output)
      .then(() => workbenchInFront
        ? undefined
        : vscode.commands.executeCommand('workbench.action.closeSidebar'))
      .catch((error) => output.appendLine(`[forexplore] launcher failed: ${String(error)}`));
  });
  return launcher;
}

/**
 * The trusted host starts the shared local indexing chain; services used for
 * translation remain independently health-checked and are never replaced.
 *
 * This runs on the first explicit use rather than at activation: opening the
 * workbench is what needs the index, and doing it earlier would scan
 * repositories or bind the semantic query port in windows that never asked for
 * it. A failure stays retryable on the next use.
 */
function ensureCodeIntelligenceStarted(
  host: ExtensionHost,
  output: vscode.OutputChannel,
  options: IndexingControls = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.onProgress) startupProgressListeners.add(options.onProgress);
  if (!codeIntelligenceStartup) {
    const controller = new AbortController();
    startupCancellation = controller;
    let failed = false;
    // The shared startup owns its one native notification, including ordinary
    // panel opening. Resumed imports only subscribe to the same scan's progress.
    codeIntelligenceStartup = withIndexingProgress('RECAST: 正在初始化代码智能索引', controls => Promise.all([
      host.services.ensureStarted().catch(error => {
        output.appendLine(`[RECAST] ${errorMessage(error, '后端启动失败')}`);
        publish({ type: 'SERVICE_STATUS', status: host.services.serviceStatus });
      }),
      host.codeIntelligence.startSemanticQueryServer({
        port: positiveEnvironmentPort(process.env.FOREXPLORE_SEMANTIC_QUERY_PORT, 0),
        bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
      }),
    ])
      // Backend initialization creates .forexplore in the workspace. Finish that
      // write before capturing directory metadata for the immutable source snapshot.
      .then(() => synchronizeCodeIntelligence(host.codeIntelligence, {
        signal: controller.signal,
        ...preloadedSynchronizationOptions(),
        onProgress: progress => {
          controls.onProgress?.(progress);
          for (const listener of startupProgressListeners) listener(progress);
        },
      }))
      .then(presentation => {
        if (presentation.status === 'error') {
          failed = true;
          output.appendLine(`[RECAST] ${presentation.message ?? '代码索引失败，请查看 RECAST 输出。'}`);
        }
        host.services.setModuleSearchReady(retrievalAvailable(presentation));
      })
      .catch(async error => {
        failed = true;
        host.services.setModuleSearchReady(retrievalAvailable(await host.codeIntelligence.presentation()));
        controller.signal.throwIfAborted();
        output.appendLine(`[RECAST] ${errorMessage(error, '检索索引启动失败')}`);
      })
      .then(() => {
        publish({ type: 'SERVICE_STATUS', status: host.services.serviceStatus });
        return refreshRepositoryStatus(host.services, host.health);
      })
      .then(() => undefined)
      .catch(error => {
        failed = true;
        controller.signal.throwIfAborted();
        output.appendLine(`[forexplore] preflight failed: ${String(error)}`);
      }), false, controller)
      .catch(error => { failed = true; throw error; })
      .finally(() => {
        startupCancellation = undefined;
        if (failed) codeIntelligenceStartup = undefined;
      });
  }
  const cancel = () => startupCancellation?.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  return codeIntelligenceStartup.then(() => { options.signal?.throwIfAborted(); }).finally(() => {
    options.signal?.removeEventListener('abort', cancel);
    if (options.onProgress) startupProgressListeners.delete(options.onProgress);
  });
}

/**
 * The workbench's opening state. The Webview is stateless, so the same payload
 * serves a first mount and a revived panel.
 */
function panelInitPayload(services: ServiceManager, settings: ExtensionSettings): PanelInitPayload {
  return {
    target: null, workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    settings, repositoryStatuses: [],
    codeIntelligence: { status: 'initializing', storage: 'seekdb', repositories: [] },
    serviceStatus: services.serviceStatus,
    moduleExplorer: {
      generatedAt: new Date().toISOString(), history: [],
      target: {
        id: 'target:unselected', mode: 'target', name: '选择目标工程', rootLabel: '', tree: [],
        stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
        summary: { exists: false, path: '.forexplore/module-summary.json' },
      },
    }, searchProvider: 'SeekDB', adaptationProvider: settings.llm.provider,
  };
}

function panelHandlers(host: ExtensionHost): PanelHandlers {
  return createPanelHandlers({
    output: host.output,
    dispatch: (message) => handlePanelMessage(host, message),
    publish,
  });
}

/** Runs after a panel exists: starts the indexing chain and fills the panel. */
function primeWorkbench(
  host: ExtensionHost,
  panel: TranslationPanel,
  output: vscode.OutputChannel,
): void {
  // Opening the workbench is the explicit use that starts the indexing chain.
  void (async () => {
    try {
      // A workspace-folder change can revive this panel while the startup
      // synchronization is still running.  Reading the explorer first would
      // publish the transient `indexing` state and, if the host was revived
      // after the final result was emitted, leave the Webview with no later
      // message to settle that state.
      const startup = ensureCodeIntelligenceStarted(host, output).catch(error => {
        if (!isIndexingCancellation(error)) throw error;
      });
      // Published indexing results are readable while another repository scans.
      // Opening a panel must not enqueue a status read behind that scan.
      await publishProjectView(host.codeIntelligence);
      // The first publication may have raced the workspace change or revival.
      // Publish once more after startup so a completed or failed target scan
      // always reaches a panel that was attached a moment later.
      await startup;
      await publishProjectView(host.codeIntelligence);
      const [status, statuses] = await Promise.all([
        host.services.refresh(),
        refreshRepositoryStatus(host.services, host.health),
      ]);
      if (TranslationPanel.current !== panel) return;
      panel.post({ type: 'SERVICE_STATUS', status });
      panel.post({ type: 'REPOSITORY_STATUS', statuses });
    } catch (error) {
      if (isIndexingCancellation(error)) return;
      if (TranslationPanel.current === panel) panel.post({ type: 'ERROR', message: errorMessage(error, '面板数据加载失败') });
    }
  })();
}

async function showPanel(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
  codeIntelligence: CodeIntelligenceHost,
  output: vscode.OutputChannel,
): Promise<void> {
  const host: ExtensionHost = { context, services, health, codeIntelligence, output };
  // Opening the workbench is the explicit use that starts the indexing chain.
  // Memoized, so reopening an existing panel costs nothing while a failed
  // startup is still retried on the next click.
  void ensureCodeIntelligenceStarted(host, output).catch(error => {
    if (!isIndexingCancellation(error)) output.appendLine(`[RECAST] ${errorMessage(error, '索引启动失败')}`);
  });
  if (TranslationPanel.current) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const panel = await TranslationPanel.createOrShow(context,
    panelInitPayload(services, loadSettings()), panelHandlers(host));
  primeWorkbench(host, panel, output);
}

async function handlePanelMessage(
  host: ExtensionHost,
  message: WebviewToHostMessage,
): Promise<void> {
  switch (message.type) {
    case 'WORKSPACE_TRANSLATION': {
      const panel = TranslationPanel.current;
      if (!vscode.workspace.isTrusted) { panel?.post({ type: 'WORKSPACE_TRANSLATION_ERROR', requestId: message.requestId, message: '请先信任工作区。' }); return; }
      try { await host.services.ensureStarted(); }
      catch (error) { panel?.post({ type: 'WORKSPACE_TRANSLATION_ERROR', requestId: message.requestId, message: errorMessage(error, '后端启动失败') }); return; }
      if (message.action === 'start' && message.moduleScopeId) {
        try { assertModuleDocumentsSaved(requireActiveRun()); }
        catch (error) { panel?.post({ type: 'WORKSPACE_TRANSLATION_ERROR', requestId: message.requestId, message: errorMessage(error, '请先保存模块文件。') }); return; }
      }
      const result = await workspaceTranslation.handle(message);
      if (TranslationPanel.current === panel) panel?.post(result);
      return;
    }
    case 'LOAD_MODULE_CHILDREN':
      try {
        TranslationPanel.current?.post({ type: 'MODULE_CHILDREN', requestId: message.requestId,
          page: readExplorerChildren(moduleExplorerChildren, message.request) });
      } catch (error) {
        TranslationPanel.current?.post({ type: 'MODULE_CHILDREN_ERROR', requestId: message.requestId,
          message: errorMessage(error, '模块节点读取失败') });
      }
      return;
    case 'ADD_TARGET_WORKSPACE':
      await addTargetWorkspaceFromWebview(host, message.mode);
      return;
    case 'SETTINGS_VISIBILITY_CHANGED':
      await vscode.commands.executeCommand('setContext', 'forexplore.settingsOpen', message.open);
      return;
    case 'BROWSE_REFERENCE_FOLDERS':
      try {
        const folders = await vscode.window.showOpenDialog({
          title: '选择参考工程文件夹', openLabel: '添加参考工程',
          canSelectFiles: false, canSelectFolders: true, canSelectMany: true,
        });
        publish({ type: 'REFERENCE_FOLDERS_SELECTED', requestId: message.requestId, paths: (folders ?? []).filter(uri => uri.scheme === 'file').map(uri => uri.fsPath) });
      } catch {
        publish({ type: 'REFERENCE_FOLDERS_SELECTED', requestId: message.requestId, paths: [], error: '无法打开目录选择器，请重试或手动输入路径。' });
      }
      return;
    case 'READY':
      await publishModelKeyStatus(host.context);
      return;
    case 'CONFIGURE_MODEL_KEY':
    case 'CLEAR_MODEL_KEY':
      await configureModelKey(host.context, message.type === 'CLEAR_MODEL_KEY');
      return;
    case 'START_SEARCH':
      await startSearch(host, message);
      return;
    case 'SELECT_CANDIDATE':
      selectCandidate(message.candidateId);
      return;
    case 'SELECT_CANDIDATES':
      selectCandidates(message.candidateIds);
      return;
    case 'START_ADAPT':
      await startAdaptation(host, message.decisionNotes);
      return;
    case 'APPLY_CURRENT_RUN':
      await applyCurrentRun(host.context);
      return;
    case 'CHECK_REPOSITORIES':
      await refreshPanelStatus(host);
      return;
    case 'REFRESH_MODULE_EXPLORER':
      await refreshModuleExplorer(host.codeIntelligence);
      return;
    case 'REFRESH_REPOSITORY': {
      const repository = (await host.codeIntelligence.presentation()).repositories.find(item => item.repositoryId === message.repositoryId);
      const targetImport = repository?.role === 'target';
      try {
        const presentation = await withIndexingProgress('RECAST: 正在重试工程索引', controls =>
          synchronizeCodeIntelligence(host.codeIntelligence, { scanRepositoryIds: [message.repositoryId], ...controls }), targetImport);
        if (targetImport) {
          const refreshed = presentation.repositories.find(item => item.repositoryId === message.repositoryId);
          const completed = refreshed?.activeRevision && ['ready', 'degraded'].includes(refreshed.analysisStatus);
          publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: completed ? 'completed' : 'failed', mode: 'workspace',
            message: completed ? '目标工程已完成索引。' : presentation.message ?? '目标工程索引失败，请查看 RECAST 输出日志后重试。' });
        }
      } catch (error) {
        if (targetImport) publish({ type: 'TARGET_WORKSPACE_RESULT',
          outcome: isIndexingCancellation(error) ? 'cancelled' : 'failed', mode: 'workspace',
          message: errorMessage(error, '目标工程索引失败') });
        else if (!isIndexingCancellation(error)) throw error;
      } finally { await publishProjectView(host.codeIntelligence); }
      return;
    }
    case 'SAVE_SETTINGS':
      await updatePanelSettings(host, message.settings, message.modelKey);
      return;
    case 'SELECT_CODE_INTELLIGENCE_REVISION':
      await selectCodeIntelligenceRevision(host.codeIntelligence, message);
      return;
    case 'RETRY_PROJECT_ANALYSIS':
      await host.codeIntelligence.retryProject(message, message.force);
      return;
    case 'SELECT_CODE_INTELLIGENCE_PROJECT':
      await selectCodeIntelligenceProject(host.codeIntelligence, message);
      return;
    case 'SELECT_WORKSPACE_TARGET':
      await selectWorkspaceTarget(message.targetId);
      return;
    case 'COPY_TARGET_PATH':
      await copyTargetPath();
      return;
    case 'REVEAL_TARGET_IN_EXPLORER':
      await revealTargetInExplorer();
      return;
    case 'OPEN_TARGET':
      await openTarget();
      return;
  }
}

/**
 * A Webview can choose only an existing opaque repository/revision pair for
 * read-only display. CodeIntelligenceHost validates both IDs and never alters
 * the repository's active revision for this operation.
 */
async function selectCodeIntelligenceRevision(
  codeIntelligence: CodeIntelligenceHost,
  selection: Extract<WebviewToHostMessage, { type: 'SELECT_CODE_INTELLIGENCE_REVISION' }>,
): Promise<void> {
  try {
    const presentation = await codeIntelligence.selectRevisionForDisplay({
      repositoryId: selection.repositoryId,
      analysisRevision: selection.analysisRevision,
    });
    if (presentation.repositories.some(r => r.repositoryId === selection.repositoryId && r.role === 'target')) {
      activeRun = null; invalidateModuleTranslation(); publish({ type: 'TARGET_CLEARED' });
    }
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation });
    await publishProjectView(codeIntelligence);
  } catch (error) {
    publishError(errorMessage(error, '切换代码智能 revision 失败'));
  }
}

async function selectCodeIntelligenceProject(
  codeIntelligence: CodeIntelligenceHost,
  selection: Extract<WebviewToHostMessage, { type: 'SELECT_CODE_INTELLIGENCE_PROJECT' }>,
): Promise<void> {
  try {
    const presentation = await codeIntelligence.selectProjectForDisplay(selection);
    if (presentation.repositories.some((r) => r.repositoryId === selection.repositoryId && r.role === 'target')) {
      activeRun = null;
      invalidateModuleTranslation();
      publish({ type: 'TARGET_CLEARED' });
    }
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation });
    await publishProjectView(codeIntelligence);
  } catch (error) {
    publishError(errorMessage(error, '切换目标工程失败'));
  }
}

async function updatePanelSettings(
  host: ExtensionHost,
  settings: Extract<WebviewToHostMessage, { type: 'SAVE_SETTINGS' }>['settings'],
  modelKey?: string | null,
): Promise<void> {
  let saved: Awaited<ReturnType<typeof savePanelSettings>>;
  try {
    const current = loadSettings();
    saved = await saveWithModelCredential(host.context.secrets, current.adaptationApiUrl, settings.llm ?? current.llm, modelKey, () => savePanelSettings(settings));
  } catch (error) {
    publishError(errorMessage(error, '保存设置失败'));
    return;
  }

  publish({ type: 'SETTINGS_UPDATED', settings: saved });
  await publishModelKeyStatus(host.context);
  try {
    const codeIntelligence = await synchronizeCodeIntelligence(host.codeIntelligence,
      isPreloadedLaunch()
        ? { ...preloadedSynchronizationOptions() }
        : { scanNewOnly: true, scanRoles: ['history'] });
    const [statuses, explorer] = await Promise.all([
      refreshRepositoryStatus(host.services, host.health),
      buildProjectExplorer(host.codeIntelligence, activeRun?.target),
    ]);
    moduleExplorerTargets = explorer.targets;
    moduleExplorerChildren = explorer.childrenByNodeId;
    publish({ type: 'REPOSITORY_STATUS', statuses });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: codeIntelligence });
    publish({ type: 'MODULE_EXPLORER', explorer: explorer.presentation });
  } catch (error) {
    publishError(errorMessage(error, '设置已保存，但刷新仓库状态失败'));
  }
}

async function refreshModuleExplorer(
  codeIntelligence: CodeIntelligenceHost,
  options: SynchronizationOptions & { throwErrors?: boolean } = {},
): Promise<boolean> {
  try {
    const { throwErrors = false, ...synchronizationOptions } = options;
    const synchronization = await synchronizeCodeIntelligenceResult(codeIntelligence, synchronizationOptions);
    const presentation = synchronization.presentation;
    const result = await buildProjectExplorer(codeIntelligence, activeRun?.target);
    moduleExplorerTargets = result.targets;
    moduleExplorerChildren = result.childrenByNodeId;
    publish({ type: 'MODULE_EXPLORER', explorer: result.presentation });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation });
    if (throwErrors) {
      // The verdict lives in one tested place: the panel's success, failure and
      // "no project in this directory" wording must not drift apart per caller.
      const verdict = targetImportVerdict(presentation, synchronization.failedRepositoryIds);
      if (verdict.status === 'failed') throw new Error(verdict.message);
    }
    return synchronization.failedRepositoryIds.length === 0 && presentation.status !== 'error';
  } catch (error) {
    // A caller that owns a visible progress surface reports the failure itself
    // so the user sees one message beside the control that failed.
    if (options.throwErrors || options.signal?.aborted || isIndexingCancellation(error)) throw error;
    publishError(errorMessage(error, '刷新模块视图失败'));
    return false;
  }
}

function withIndexingProgress<T>(
  title: string,
  operation: (controls: IndexingControls) => Promise<T>,
  targetImport = false,
  controller = new AbortController(),
): Promise<T> {
  return Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const cancel = () => controller.abort(new DOMException('索引已取消，可重试以继续。', 'AbortError'));
      const subscription = token.onCancellationRequested(cancel);
      if (token.isCancellationRequested) cancel();
      const report = (message: string) => {
        progress.report({ message });
        if (targetImport) publish({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing', message });
      };
      try {
        controller.signal.throwIfAborted();
        report('正在准备索引…');
        const result = await operation({ signal: controller.signal,
          onProgress: update => report(indexingProgressMessage(update)) });
        controller.signal.throwIfAborted();
        return result;
      } finally { subscription.dispose(); }
    },
  ));
}

/**
 * One explicit target choice is a user-visible transaction: a native dialog, a
 * workspace mutation that can restart this extension host, then a first-time
 * index. Every phase reaches the notification *and* the Webview, because a
 * silent multi-minute wait is indistinguishable from a dead button.
 */
async function addTargetWorkspaceFromWebview(
  host: ExtensionHost,
  mode: TargetWorkspaceAddMode,
): Promise<void> {
  publish({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'selecting',
    message: mode === 'workspace' ? '请在弹出的列表中选择目标工程目录…' : '请在弹出的对话框中选择目标工程目录…' });
  // Adding the first workspace folder restarts this extension host, so the
  // intent is persisted before that mutation and cleared once this host
  // finishes the job. Otherwise a restart leaves the panel stuck on
  // "正在建立索引" with nobody left to complete or clear it.
  await host.context.globalState.update(pendingTargetImportKey(vscode.env.sessionId),
    { requestedAt: new Date().toISOString(), mode } satisfies PendingTargetImport);
  const clearIntent = () => host.context.globalState.update(pendingTargetImportKey(vscode.env.sessionId), undefined);
  const controller = new AbortController();
  let selection: Awaited<ReturnType<typeof addTargetWorkspace>>;
  try {
    selection = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RECAST: 正在添加目标工程', cancellable: true },
      async (progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort(new DOMException('添加目标工程已取消', 'AbortError')));
        try {
          if (token.isCancellationRequested) controller.abort(new DOMException('添加目标工程已取消', 'AbortError'));
          controller.signal.throwIfAborted();
          const selected = await addTargetWorkspace(mode, { signal: controller.signal, onProgress: update => {
            controller.signal.throwIfAborted();
            progress.report({ message: update.message });
            publish({ type: 'TARGET_WORKSPACE_PROGRESS', phase: update.phase, message: update.message });
          } });
          controller.signal.throwIfAborted();
          return selected;
        } finally { subscription.dispose(); }
      },
    );
  } catch (error) {
    await clearIntent();
    publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: isIndexingCancellation(error) ? 'cancelled' : 'failed', mode,
      message: errorMessage(error, '添加目标工程失败') });
    return;
  }
  if (selection.status === 'cancelled') {
    await clearIntent();
    publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'cancelled', mode });
    return;
  }
  publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'added', mode,
    message: selection.status === 'attached'
      ? '目标目录已加入工作区，正在建立索引…'
      : '目标目录已登记，正在建立索引…' });
  try {
    // `throwErrors` keeps the failure message with the retry affordance in the
    // selector instead of duplicating it into the global error banner.
    await withIndexingProgress('RECAST: 正在建立目标工程索引', controls =>
      refreshModuleExplorer(host.codeIntelligence, { scanNewOnly: true, throwErrors: true, ...controls }), true, controller);
  } catch (error) {
    await clearIntent();
    publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: isIndexingCancellation(error) ? 'cancelled' : 'failed', mode,
      message: errorMessage(error, '目标目录已登记，但索引失败') });
    return;
  }
  await clearIntent();
  // VS Code may restart this extension host to apply the workspace change. The
  // Webview then rebuilds from INIT instead of receiving this message.
  publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'completed', mode });
}

/**
 * Finishes a target import that a workspace change cut in half. Reaching this
 * means the previous host died between adding the folder and indexing it, so
 * the work only has to run again — and say so, instead of leaving the panel on
 * a progress state that will never advance.
 */
async function resumeInterruptedTargetImport(
  host: ExtensionHost,
  output: vscode.OutputChannel,
): Promise<void> {
  const pending = readPendingTargetImport(host.context.globalState.get(pendingTargetImportKey(vscode.env.sessionId)));
  if (!pending) return;
  await host.context.globalState.update(pendingTargetImportKey(vscode.env.sessionId), undefined);
  output.appendLine('[forexplore] resuming the target import interrupted by the workspace change.');
  try {
    publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'added', mode: pending.mode,
      message: '正在恢复目标工程导入…' });
    publish({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing', message: '正在恢复目标工程导入…' });
    await ensureCodeIntelligenceStarted(host, output, { onProgress: update =>
      publish({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing', message: indexingProgressMessage(update) }) });
    // Startup owns the cancellable notification and already scanned this
    // selection. Publish its verdict without another notification or scan.
    await refreshModuleExplorer(host.codeIntelligence, { ...preloadedSynchronizationOptions(), scan: false, throwErrors: true });
  } catch (error) {
    if (isIndexingCancellation(error)) {
      publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'cancelled', mode: pending.mode,
        message: errorMessage(error, '索引已取消') });
      return;
    }
    const failure = errorMessage(error, '恢复目标工程导入失败');
    publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: pending.mode, message: failure });
    void vscode.window.showWarningMessage(`RECAST: ${failure}`);
    return;
  }
  publish({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'completed', mode: pending.mode });
  void vscode.window.showInformationMessage('RECAST: 目标工程已导入并完成索引。');
}

async function selectWorkspaceTarget(targetId: string): Promise<void> {
  try {
    invalidateModuleTranslation();
    const target = moduleExplorerTargets.get(targetId);
    if (!target) throw new Error('该目标不属于当前 Host 静态分析快照。');
    if (!activeCodeIntelligenceHost) throw new Error('索引尚未初始化。');
    const selected = (await activeCodeIntelligenceHost.explorerData()).find((item) => item.selectedTarget);
    const selectedRepository = selected?.repository;
    const workspaceFolder = selectedTargetWorkspaceFolders().find((folder) => {
      if (sameTargetPath(folder.uri.fsPath, selectedRepository?.localPath ?? '')) return true;
      // A preloaded database may have been built from the other checkout
      // (`/mnt/e/...` versus `/home/...`). The launcher binds both spellings
      // to the same opaque repository ID, which is the authoritative match
      // when no filesystem path alias can connect the two roots.
      return Boolean(selectedRepository) &&
        preloadedRepositoryId(preloadedRepositoryBindings, folder.uri.fsPath) === selectedRepository?.repositoryId;
    });
    if (!workspaceFolder) throw new Error('所选工程不属于已打开的 VS Code 工作区。');
    const canonicalPath = canonicalWorkspacePath(workspaceFolder.uri.fsPath, target.path);
    const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, ...canonicalPath.split('/'));
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === targetUri.toString(),
    );
    if (openDocument?.isDirty) {
      throw new Error('新目标文件有未保存的编辑；请先保存后再切换目标。');
    }
    const originalBytes = await vscode.workspace.fs.readFile(targetUri);
    activeRun = {
      workspaceFolder,
      targetUri,
      target,
      originalSha256: sha256(originalBytes),
      originalContent: Buffer.from(originalBytes).toString('utf8'),
      requirement: '',
      candidates: [],
      selectedCandidateId: null,
      adaptation: null,
    };
    publish({ type: 'TARGET_SELECTED', target: { ...target, source: activeRun.originalContent } });
  } catch (error) {
    publishError(errorMessage(error, '切换目标失败'));
  }
}

async function startSearch(
  host: ExtensionHost,
  message: Extract<WebviewToHostMessage, { type: 'START_SEARCH' }>,
): Promise<void> {
  try {
    invalidateModuleTranslation();
    const run = requireActiveRun();
    const selectionVersion = moduleSelectionVersion;
    await assertTargetUnchanged(run);
    await host.codeIntelligence.waitForProjects();
    const candidates = await host.codeIntelligence.searchHistoricalImplementations({
      target: run.target,
      requirement: message.requirement.trim(),
      topK: message.topK,
    });
    if (activeRun !== run || selectionVersion !== moduleSelectionVersion) return;
    run.requirement = message.requirement.trim();
    run.candidates = candidates;
    run.selectedCandidateId = null;
    run.selectedCandidateIds = [];
    run.adaptation = null;
    publish({ type: 'SEARCH_RESULT', candidates: run.candidates });
  } catch (error) {
    publishError(errorMessage(error, '检索失败'));
  }
}

function selectCandidate(candidateId: string): void {
  try {
    const run = requireActiveRun();
    const candidate = run.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new Error('该候选不属于当前检索结果。');
    }
    invalidateModuleTranslation();
    // This is deliberately the only operation that changes this field. A
    // retrieval ranking never becomes consent by itself.
    run.selectedCandidateId = candidateId;
    run.selectedCandidateIds = [candidateId];
    run.adaptation = null;
  } catch (error) {
    publishError(errorMessage(error, '候选选择无效'));
  }
}

function selectCandidates(candidateIds: string[]): void {
  try {
    const run = requireActiveRun();
    if (run.target.kind !== 'module' || candidateIds.length > 3 || new Set(candidateIds).size !== candidateIds.length ||
        candidateIds.some(id => !run.candidates.slice(0, 4).some(candidate => candidate.id === id && candidate.kind === 'module' && candidate.sourceModule))) {
      throw new Error('请从当前 Top4 中选择 1～3 个历史模块。');
    }
    invalidateModuleTranslation();
    run.selectedCandidateIds = [...candidateIds];
    run.selectedCandidateId = candidateIds[0] ?? null;
    run.adaptation = null;
  } catch (error) { publishError(errorMessage(error, '候选选择无效')); }
}

async function startAdaptation(host: ExtensionHost, decisionNotes: string): Promise<void> {
  const log = (line: string) => host.output.appendLine(`[forexplore] ${line}`);
  try {
    const run = requireActiveRun();
    const candidate = run.selectedCandidateId ? selectedRunCandidate(run) : undefined;
    const candidates = (run.selectedCandidateIds ?? (candidate ? [candidate.id] : []))
      .map(id => run.candidates.find(item => item.id === id)!).filter(Boolean);
    if (!candidate && run.target.kind !== 'module') throw new Error('当前目标没有可用候选，只有模块目标支持按需求直实现。');
    log(`translation requested: target=${run.target.id} candidate=${candidate?.id ?? 'direct-fallback'} kinds=${run.target.kind}/${candidate?.kind ?? 'direct-translator'}`);
    if (run.target.kind === 'module' || candidate?.kind === 'module') {
      if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区。');
      await assertTargetUnchanged(run);
      assertModuleDocumentsSaved(run);
      const selectionVersion = moduleSelectionVersion;
      await host.services.ensureStarted();
      // The explorer snapshot is Host-owned. It supplies the complete target
      // module inventory so scope preparation can add only directly referenced
      // dependency files; the Webview's candidate selection cannot widen it.
      const relatedModules = [...moduleExplorerTargets.values()]
        .filter((item, index, all) => item.kind === 'module' && all.findIndex(other => other.id === item.id) === index);
      const scope = await (candidate ? (async () => {
        const historyView = await host.codeIntelligence.createHistoryModulesView({ workspaceRoot: run.workspaceFolder.uri.fsPath,
          candidates: candidates.map(item => ({ repositoryId: item.sourceModule!.repositoryId,
            analysisRevision: item.sourceModule!.analysisRevision, projectId: item.sourceModule!.projectId,
            moduleId: item.sourceModule!.moduleId, name: item.sourceModule!.name, language: item.language,
            sourceFiles: item.sourceModule!.sourceFiles ?? [item.path], relevanceTerms: [run.target.name, run.target.path,
              run.target.signature, ...(run.target.module?.sourceFiles ?? []), ...(run.target.module?.coreApis ?? []),
              item.sourceModule!.name, item.sourceModule!.purpose ?? '', ...(item.sourceModule!.coreApis ?? [])] })) });
        const identities = historyView.candidates ?? [historyView];
        const usableCandidates = candidates.filter(item => identities.some(view => view.repositoryId === item.sourceModule!.repositoryId &&
          view.analysisRevision === item.sourceModule!.analysisRevision && view.projectId === item.sourceModule!.projectId && view.moduleId === item.sourceModule!.moduleId));
        return prepareModuleTranslationScope({ workspaceRoot: run.workspaceFolder.uri.fsPath,
          target: run.target, candidates: usableCandidates, relatedModules, requirement: run.requirement, decisionNotes, historyView });
      })() : prepareDirectModuleTranslationScope({ workspaceRoot: run.workspaceFolder.uri.fsPath,
        target: run.target, relatedModules, requirement: run.requirement, decisionNotes }));
      if (activeRun !== run || selectionVersion !== moduleSelectionVersion) {
        // A silent return here leaves the panel waiting for a reply that will
        // never come, which is indistinguishable from a running translation.
        log('module translation handoff dropped: the selection changed while preparing the scope.');
        publishError('目标或候选在准备翻译作用域时发生了变化；请重新选择候选后再发起翻译。');
        return;
      }
      const moduleScopeId = workspaceTranslation.rememberModuleScope(scope);
      log(`module translation scope prepared: ${moduleScopeId} writeFiles=${scope.profile.writeFiles.length} `
        + `targetId=${run.target.id} candidateId=${candidate?.id ?? 'direct-fallback'}`);
      publish({ type: 'MODULE_TRANSLATION_READY', targetId: run.target.id, candidateId: candidate?.id ?? 'direct-fallback', candidateIds: candidates.map(item => item.id), moduleScopeId });
      log('module translation handoff published'
        + `${TranslationPanel.current ? '' : ' (no panel is attached, so the reply was dropped)'}; `
        + 'the workspace translation service is not called before this handoff succeeds.');
      return;
    }
    await assertTargetUnchanged(run);
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    log(`requesting /v1/adapt for target=${run.target.id}.`);
    const rawResult = await host.services.getAdaptationPort().adapt({
      target: run.target,
      candidate: candidate!,
      requirement: run.requirement,
      strategy: 'translate',
      decisionNotes,
    });
    const result = validateHostOwnedResult(run, rawResult);
    run.adaptation = result;
    publish({ type: 'ADAPT_RESULT', result });
  } catch (error) {
    log(`translation failed: ${errorMessage(error, '未知错误')}`);
    publishError(errorMessage(error, '翻译失败'));
  }
}

async function applyCurrentRun(context: vscode.ExtensionContext): Promise<void> {
  try {
    const run = requireActiveRun();
    const adaptation = run.adaptation;
    if (!adaptation) throw new Error('尚未生成当前迁移运行的补丁。');
    const gate = evaluateValidationGate(adaptation.validation);
    if (!canApplyAdaptation(adaptation)) {
      const labels = gate.blockers.map((record) => record.label).join('、');
      throw new Error(`必需验证未通过或尚未验证：${labels || '缺少可写回补丁'}。`);
    }
    await assertTargetUnchanged(run);
    const referenceFree = adaptation.validation.some(
      (record) => record.id === 'reference-candidate',
    );
    const confirmation = referenceFree
      ? `Analyzer 已拒绝所选参考实现；当前 ${run.target.language} 代码仅依据目标上下文和需求自主生成。请重点审查后再写入 ${run.target.language} 文件。确认继续？`
      : `将把已预览的补丁写入当前选中的 ${run.target.language} 文件，并创建可恢复检查点。确认继续？`;
    const choice = await vscode.window.showWarningMessage(
      confirmation,
      { modal: true },
      '应用补丁',
    );
    if (choice !== '应用补丁') {
      publishError('已取消应用补丁。');
      return;
    }

    const result = await new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPath: run.target.path,
    }).apply(adaptation.files);
    await context.workspaceState.update('forexplore.lastCheckpoint', {
      checkpointId: result.checkpointId,
      workspaceUri: run.workspaceFolder.uri.toString(),
      targetPath: run.target.path,
    });
    publish({ type: 'APPLY_RESULT', result });
  } catch (error) {
    publishError(errorMessage(error, '回填失败'));
  }
}

async function restoreLastCheckpoint(context: vscode.ExtensionContext): Promise<void> {
  const checkpoint = context.workspaceState.get<LastCheckpoint>('forexplore.lastCheckpoint');
  const run = activeRun;
  if (!checkpoint || !run) {
    void vscode.window.showInformationMessage('没有与当前迁移运行关联的可恢复检查点。');
    return;
  }
  if (
    checkpoint.workspaceUri !== run.workspaceFolder.uri.toString() ||
    checkpoint.targetPath !== run.target.path
  ) {
    void vscode.window.showWarningMessage('恢复点不属于当前选中的迁移目标，已拒绝恢复。');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    '将恢复最近一次 RECAST 写入前的文件内容；若文件后来又被编辑，恢复会被拒绝。确认继续？',
    { modal: true },
    '恢复检查点',
  );
  if (choice !== '恢复检查点') return;
  try {
    const result = await new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPath: run.target.path,
    }).restore(checkpoint.checkpointId);
    await context.workspaceState.update('forexplore.lastCheckpoint', undefined);
    void vscode.window.showInformationMessage(`已恢复 ${result.appliedFiles.join('、')}。`);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '恢复失败'));
  }
}

async function refreshPanelStatus(host: ExtensionHost): Promise<void> {
  try {
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const [statuses, codeIntelligence] = await Promise.all([
      refreshRepositoryStatus(host.services, host.health),
      synchronizeCodeIntelligence(host.codeIntelligence, { ...preloadedSynchronizationOptions(), scan: false }),
    ]);
    publish({ type: 'REPOSITORY_STATUS', statuses });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: codeIntelligence });
  } catch (error) {
    publishError(errorMessage(error, '状态检查失败'));
  }
}

async function openTarget(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.window.showTextDocument(run.targetUri, {
      preview: true,
      selection: new vscode.Range(
        Math.max(0, (run.target.line ?? 1) - 1),
        0,
        Math.max(0, (run.target.line ?? 1) - 1),
        0,
      ),
    });
  } catch (error) {
    publishError(errorMessage(error, '无法打开当前目标文件'));
  }
}

async function copyTargetPath(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.env.clipboard.writeText(run.target.path);
    vscode.window.setStatusBarMessage('RECAST: 已复制目标路径', 2_000);
  } catch (error) {
    publishError(errorMessage(error, '无法复制当前目标路径'));
  }
}

async function revealTargetInExplorer(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', run.targetUri);
  } catch (error) {
    publishError(errorMessage(error, '无法在资源管理器中定位当前目标文件'));
  }
}

function validateHostOwnedResult(
  run: ActiveMigrationRun,
  result: AdaptationResult,
): AdaptationResult {
  const validation = [...result.validation];
  const failures: string[] = [];
  let files: FilePatch[] = result.files;

  if (result.strategy !== 'translate' || result.targetLanguage !== run.target.language) {
    failures.push('服务返回的策略或目标语言与当前选中的目标不一致。');
  }
  if (files.length !== 1) {
    failures.push('写回只接受当前目标文件的一个修改补丁。');
  }

  const patch = files[0];
  if (patch) {
    const expectedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, run.target.path);
    let returnedPath: string | undefined;
    try {
      returnedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, patch.path);
    } catch {
      failures.push('服务返回的补丁路径不是工作区内的相对路径。');
    }
    if (patch.status !== 'modified' || returnedPath !== expectedPath) {
      failures.push('服务返回的补丁不严格对应当前选中的目标文件。');
    }
    if (patch.status === 'modified') {
      if (patch.expectedOriginalSha256 !== run.originalSha256) {
        failures.push('服务补丁的原始文件哈希与扩展宿主快照不一致。');
      }
      try {
        applyHunksStrict(run.originalContent, patch.hunks);
      } catch (error) {
        failures.push(
          `补丁不能精确应用到本次目标快照：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  validation.push({
    id: 'extension-target-snapshot',
    label: '扩展目标快照',
    status: failures.length === 0 ? 'pass' : 'fail',
    required: true,
    command: 'VS Code workspace.fs.readFile + SHA-256',
    summary:
      failures.length === 0
        ? '补丁路径、原始哈希和 hunk 均与本次编辑器目标快照一致。'
        : failures.join(' '),
    failureReason: failures.length === 0 ? undefined : 'host-owned-patch-validation-failed',
  });

  if (failures.length > 0) {
    validation.push({
      id: 'extension-patch-scope',
      label: '补丁范围与前置条件',
      status: 'fail',
      required: true,
      summary: failures.join(' '),
      failureReason: 'unsafe-or-stale-patch',
    });
    files = [];
  }

  return { ...result, validation: deduplicateValidation(validation), files };
}

function deduplicateValidation(records: ValidationRecord[]): ValidationRecord[] {
  const ids = new Set<string>();
  return records.filter((record) => {
    if (ids.has(record.id)) return false;
    ids.add(record.id);
    return true;
  });
}

function requireActiveRun(): ActiveMigrationRun {
  if (!activeRun) throw new Error('请先从已保存的目标方法启动一次迁移。');
  return activeRun;
}

function selectedRunCandidate(run: ActiveMigrationRun): SearchCandidate {
  if (!run.selectedCandidateId) {
    throw new Error('请先明确点击并选择一个候选实现。');
  }
  const candidate = run.candidates.find((item) => item.id === run.selectedCandidateId);
  if (!candidate) {
    throw new Error('当前候选已失效；请重新检索并明确选择。');
  }
  return candidate;
}

async function assertTargetUnchanged(run: ActiveMigrationRun): Promise<void> {
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === run.targetUri.toString(),
  );
  if (openDocument?.isDirty) {
    throw new Error('目标文件有未保存的编辑；请先保存并重新启动迁移以建立新快照。');
  }
  const current = await vscode.workspace.fs.readFile(run.targetUri);
  if (sha256(current) !== run.originalSha256) {
    throw new Error('目标文件已在本次迁移开始后发生变化；请重新启动迁移以生成新快照。');
  }
}

function assertModuleDocumentsSaved(run: ActiveMigrationRun): void {
  const files = new Set((run.target.module?.sourceFiles ?? []).map(file =>
    vscode.Uri.joinPath(run.workspaceFolder.uri, ...file.replaceAll('\\', '/').split('/')).toString()));
  if (vscode.workspace.textDocuments.some(document => document.isDirty && files.has(document.uri.toString()))) {
    throw new Error('目标模块有未保存的文件；请保存后重新准备翻译。');
  }
}

function refreshRepositoryStatus(
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<RepositoryStatus[]> {
  return health
    .checkConfigured()
    .then((statuses) => decorateRepositoryStatuses(statuses, services.serviceStatus));
}

/**
 * Only the extension host translates configured local roots into registry
 * inputs.  The returned presentation is safe to pass to the Webview because
 * it contains IDs/revisions only, never these local paths.
 */
function codeIntelligenceRepositoryInputs(): Array<{
  localPath: string;
  displayName?: string;
  role: 'history' | 'target';
  repositoryId?: string;
}> {
  const settings = loadSettings();
  const bind = <T extends { localPath: string }>(input: T): T & { repositoryId?: string } => {
    const repositoryId = preloadedRepositoryId(preloadedRepositoryBindings, input.localPath);
    return repositoryId ? { ...input, repositoryId } : input;
  };
  const history = settings.repositoryPaths.map((localPath) => bind({
    localPath,
    role: 'history' as const,
  }));
  const targets = selectedTargetWorkspaceFolders()
    .map((folder) => bind({
      localPath: folder.uri.fsPath,
      displayName: folder.name,
      role: 'target' as const,
    }));
  return [...history, ...targets];
}

async function synchronizeCodeIntelligence(
  host: CodeIntelligenceHost,
  options: SynchronizationOptions = {},
): Promise<CodeIntelligencePresentation> {
  return (await synchronizeCodeIntelligenceResult(host, options)).presentation;
}

async function synchronizeCodeIntelligenceResult(
  host: CodeIntelligenceHost,
  options: SynchronizationOptions = {},
): Promise<Awaited<ReturnType<CodeIntelligenceHost['synchronize']>>> {
  const updateStatus = (presentation: CodeIntelligencePresentation) => {
    activeServices?.setModuleSearchReady(retrievalAvailable(presentation));
    if (activeServices) publish({ type: 'SERVICE_STATUS', status: activeServices.serviceStatus });
  };
  try {
    const result = await host.synchronize({ repositories: codeIntelligenceRepositoryInputs(), ...options });
    updateStatus(result.presentation);
    return result;
  } catch (error) {
    updateStatus(await host.presentation());
    throw error;
  }
}

function publish(message: HostToWebviewMessage): void {
  publishPanelMessage(TranslationPanel.current, message, activeOutput);
}

/** The RECAST channel, reachable from module-level publishers. */
let activeOutput: vscode.OutputChannel | undefined;

function publishError(message: string): void {
  publish({ type: 'ERROR', message });
}

function summarizeRepositoryStatus(statuses: RepositoryStatus[]): string | null {
  if (statuses.length === 0) return null;
  const unavailable = statuses.filter((status) => !status.exists || !status.readable).length;
  return `本地参考工程：${statuses.length} 个，${unavailable} 个不可用。`;
}

function summarizeCodeIntelligence(presentation: CodeIntelligencePresentation): string | null {
  if (presentation.status === 'initializing') return '代码智能索引正在初始化。';
  if (presentation.status === 'error') return presentation.message ?? '代码智能索引刷新失败。';
  if (presentation.repositories.length === 0) return null;
  const ready = presentation.repositories.filter((repository) => (
    repository.analysisStatus === 'ready' || repository.analysisStatus === 'degraded'
  )).length;
  const staleSummaries = presentation.repositories.filter(
    (repository) => repository.summary.status === 'stale',
  ).length;
  return `${presentation.storage === 'seekdb' ? 'SeekDB' : '内存'}代码智能索引：${ready}/${presentation.repositories.length} 个仓库就绪`
    + (staleSummaries ? `，${staleSummaries} 个 Summary 已过期。` : '。');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveEnvironmentPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('FOREXPLORE_SEMANTIC_QUERY_PORT 必须为 0（自动分配）或有效 TCP 端口。');
  }
  return port;
}

let projectViewQueue: Promise<void> = Promise.resolve();
function publishProjectView(host: CodeIntelligenceHost): Promise<void> {
  projectViewQueue = projectViewQueue.catch(() => {}).then(async () => {
    if (!TranslationPanel.current) return;
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
    const explorer = await buildProjectExplorer(host, activeRun?.target);
    moduleExplorerTargets = explorer.targets;
    moduleExplorerChildren = explorer.childrenByNodeId;
    publish({ type: 'MODULE_EXPLORER', explorer: explorer.presentation });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
  });
  return projectViewQueue;
}
