import { chmod, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyGlobalProtocol, type GlobalProtocol, type WorkspaceTranslationRequest, type WorkspaceVerificationFeedback, type ProjectModule, type WorkspaceCompileCommand, type WorkspaceHistoryView, type WorkspaceTranslationRun } from '@forexplore/contracts';
export interface CodexRuntime {
  start(request: WorkspaceTranslationRequest): WorkspaceTranslationRun;
  get(id: string): WorkspaceTranslationRun;
  repairAfterVerification(id: string, feedback: WorkspaceVerificationFeedback): WorkspaceTranslationRun;
  cancel(id: string): Promise<WorkspaceTranslationRun>;
  shutdown(): Promise<void>;
}
const codexService = () => require('../../../services/adaptation-service/src/codex-workspace-translation-runtime') as {
  CodexWorkspaceTranslationRuntime: new (options: { workspaceRoot: string; compileCommand: WorkspaceCompileCommand; codexHome: string; codexModel: string;
    codexCommand?: string; timeoutMs: number; maxVerificationRepairs: number; environment: NodeJS.ProcessEnv }) => CodexRuntime;
};
import { prepareDeepSeekCodexHome, type CodexHomeHandle } from '../../../services/adaptation-service/src/codex-experiment-home';
const plannerService = () => require('../../../services/adaptation-service/src/integration-plan-agent') as {
  runIntegrationPlanAgent(input: { targetRoot: string; requirement: string; modules: ProjectModule[]; taskIdentity: string;
    model: { apiKey: string; modelConfig: { apiBase: string; model: string } }; signal: AbortSignal }): Promise<{ protocol: GlobalProtocol; warning?: string }>;
};
import { loadGlobalProtocol, mergeGlobalProtocol, persistGlobalProtocol, projectModuleProtocol, recordProtocolChecks } from '../../../services/adaptation-service/src/protocol-sidecar';
import { prepareProjectIntegrationContext } from '../../../services/adaptation-service/src/project-integration-context';
import type { ImplementationReferenceSelection } from '../../../services/adaptation-service/src/reference-selection-policy';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import { ConfiguredModelReranker } from './model-reranker';
import { prepareDirectModuleTranslationScope, prepareIntegrationTranslationScope, prepareModuleTranslationScope } from './module-translation-handoff';
import { verifyPipelineModule, type PipelineModel } from './project-module-verifier';
import type { ProjectPipelinePorts } from './project-pipeline';
import type { ProjectPipelineModule, ProjectPipelineRun, ProjectPipelineStart } from './project-pipeline-types';

type Hooks = Parameters<ProjectPipelinePorts['generate']>[2];

/** Window-owned adapter around the production pipeline components. No dataset, DB or CLI-driver defaults. */
export class ProjectPipelineBackend {
  private home?: CodexHomeHandle;
  private model?: PipelineModel;
  private protocol = emptyGlobalProtocol();
  private protocolPath = '';
  private runtime?: CodexRuntime;
  private readonly verificationRoots = new Map<string, string>();
  private verificationOutput?: string;
  private readonly history = new Map<string, WorkspaceHistoryView>();
  constructor(private readonly options: {
    codeIntelligence: Pick<CodeIntelligenceHost, 'searchHistoricalImplementations' | 'createHistoryModulesView'>;
    endpoint(): string; ensureStarted(): Promise<unknown>; model(): Promise<PipelineModel>;
    compileCommand(): WorkspaceCompileCommand;
    protectedFiles(): string[];
    codexCommand?: string; codexHome?: string;
  }, private readonly drivers = {
    runtime: (options: ConstructorParameters<ReturnType<typeof codexService>['CodexWorkspaceTranslationRuntime']>[0]): CodexRuntime => new (codexService().CodexWorkspaceTranslationRuntime)(options),
    plan: (input: Parameters<ReturnType<typeof plannerService>['runIntegrationPlanAgent']>[0]) => plannerService().runIntegrationPlanAgent(input),
    verify: verifyPipelineModule,
  }) {}

  async prepare(run: ProjectPipelineRun, signal: AbortSignal, log: (message: string) => void, resume = false): Promise<void> {
    await this.close(); signal.throwIfAborted();
    this.verificationOutput = run.outputRoot;
    this.model = await this.options.model();
    if (!this.model.apiKey.trim()) throw new Error('请先在设置中配置模型 API Key。');
    this.home = await prepareDeepSeekCodexHome({ apiKey: this.model.apiKey, model: this.model.model, baseUrl: this.model.apiBase, explicitHome: this.options.codexHome });
    this.protocolPath = path.join(path.dirname(run.outputRoot!), 'global-protocol.json');
    if (resume) {
      const loaded = await loadGlobalProtocol(this.protocolPath, run.id);
      this.protocol = loaded.protocol;
      if (loaded.error) log('原任务协议文件不可用，将依据原需求和目标契约继续，并重新执行最终验收。');
      log('已恢复原任务协议与输出工程；继续使用当前配置的模型。');
      return;
    }
    this.protocol = emptyGlobalProtocol();
    const modules: ProjectModule[] = run.modules.map(module => ({ id: module.id, name: module.name, kind: 'feature',
      description: module.target.documentation ?? module.name, sourceFiles: module.target.module!.sourceFiles,
      coreApis: module.target.module?.coreApis ?? [], symbolKeys: [], evidenceIds: [], dependsOn: module.dependsOn }));
    log('正在制定项目 Integration Plan 与跨模块协议。');
    const planned = await this.drivers.plan({ targetRoot: run.outputRoot!, requirement: run.requirement, modules,
      taskIdentity: run.id, model: { apiKey: this.model.apiKey, modelConfig: { apiBase: this.model.apiBase, model: this.model.model } }, signal });
    signal.throwIfAborted();
    if (planned.warning) log(`Integration Plan 未完整生成，保留未确定项：${planned.warning}`);
    this.protocol = mergeGlobalProtocol(this.protocol, planned.protocol, run.id);
    await persistGlobalProtocol(this.protocolPath, this.protocol);
  }

  async search(module: ProjectPipelineModule, input: ProjectPipelineStart, signal: AbortSignal): Promise<ProjectPipelineModule['candidates']> {
    let selection: ImplementationReferenceSelection | undefined;
    const reranker = new ConfiguredModelReranker(this.options.endpoint, this.options.ensureStarted, undefined,
      () => JSON.stringify({ endpoint: this.options.endpoint(), model: this.model?.model }), { onSelection: value => { selection = value; } });
    // Retain all selected references even when the single-module UI's display width is one.
    const candidates = await this.options.codeIntelligence.searchHistoricalImplementations({ target: module.target,
      requirement: input.requirement, topK: Math.max(4, input.topK) }, signal, reranker);
    signal.throwIfAborted();
    if (candidates.length && (!selection || candidates.length < selection.selected.length)) throw new Error('自动参考选择未返回可审计结果，请检查模型配置后重试。');
    module.referenceSelection = selection;
    module.selectedCandidateIds = candidates.slice(0, selection?.selected.length ?? 0).map(candidate => candidate.id);
    return candidates;
  }

  async generate(module: ProjectPipelineModule, run: ProjectPipelineRun, hooks: Hooks): Promise<WorkspaceTranslationRun> {
    hooks.signal.throwIfAborted();
    const root = run.outputRoot!;
    const integration = module.taskKind === 'project-integration' || module.id.startsWith('pipeline-integration-repair');
    let selected = module.candidates.filter(candidate => module.selectedCandidateIds?.includes(candidate.id) || candidate.id === module.selectedCandidateId);
    const protocol = projectModuleProtocol(this.protocol, { moduleId: module.id, moduleName: module.name,
      relatedModules: module.dependsOn, relatedInterfaces: module.target.module?.coreApis, ownedFiles: module.target.module?.sourceFiles });
    let scope: Awaited<ReturnType<typeof prepareDirectModuleTranslationScope>>;
    if (integration) {
      hooks.onProgress?.('generating', '执行主动项目 Integration：检查公共需求、真实调用链和跨模块契约。');
      const prepared = await prepareProjectIntegrationContext(root);
      const permitted = new Set(run.modules.flatMap(item => [...(item.authorizedFiles ?? item.target.module?.sourceFiles ?? []), ...(item.taskKind ? item.changedFiles ?? [] : [])]));
      const writeFiles = prepared.writeFiles.filter(file => permitted.has(file) && !this.options.protectedFiles().includes(file));
      scope = await prepareIntegrationTranslationScope({ workspaceRoot: root, targetLanguage: module.target.language,
        ...prepared, writeFiles, requirement: `${run.requirement}\n\n${prepared.requirement}`, globalProtocol: this.protocol });
    } else {
      let historyView: WorkspaceHistoryView | undefined;
      if (selected.length) {
        try { historyView = await this.options.codeIntelligence.createHistoryModulesView({ workspaceRoot: root,
          candidates: selected.map(candidate => {
            if (!candidate.sourceModule) throw new Error('自动选择的历史参考缺少模块身份。');
            const source = candidate.sourceModule;
            return { repositoryId: source.repositoryId, analysisRevision: source.analysisRevision, projectId: source.projectId,
              moduleId: source.moduleId, name: source.name, language: candidate.language, sourceFiles: source.sourceFiles ?? [candidate.path],
              preferredFiles: candidate.moduleMatch?.previewFiles, relevanceTerms: [module.name, module.target.signature] };
          }) });
        this.history.set(module.id, historyView);
        const identities = historyView.candidates ?? [historyView];
        selected = selected.filter(candidate => identities.some(view => view.repositoryId === candidate.sourceModule!.repositoryId &&
          view.analysisRevision === candidate.sourceModule!.analysisRevision && view.moduleId === candidate.sourceModule!.moduleId && view.projectId === candidate.sourceModule!.projectId));
        } catch (error) {
          if (!/有效的源文件清单|source files|source file|ENOENT/i.test(error instanceof Error ? error.message : String(error))) throw error;
          selected = []; hooks.onProgress?.('analyzing', '所选历史源码不可用，改为根据公共需求与目标契约直接实现。');
        }
        module.selectedCandidateIds = selected.map(candidate => candidate.id); module.selectedCandidateId = selected[0]?.id;
      }
      const relatedWriteFiles = run.modules.filter(other => module.dependsOn.includes(other.id)).flatMap(other => other.target.module?.sourceFiles ?? [])
        .filter(file => !this.options.protectedFiles().includes(file));
      const common = { workspaceRoot: root, target: module.target, requirement: run.requirement, relatedWriteFiles,
        moduleProtocol: protocol, decisionNotes: module.referenceSelection ? JSON.stringify(module.referenceSelection) : '' };
      scope = selected.length ? await prepareModuleTranslationScope({ ...common, candidates: selected, historyView }) : await prepareDirectModuleTranslationScope(common);
    }
    module.authorizedFiles = scope.profile.writeFiles;
    await hooks.onCheckpoint?.(); hooks.signal.throwIfAborted();
    this.runtime = this.drivers.runtime({ workspaceRoot: root, compileCommand: this.options.compileCommand(),
      codexHome: this.home!.path, codexModel: this.model!.model, codexCommand: this.options.codexCommand, timeoutMs: 7_200_000, maxVerificationRepairs: 4,
      environment: { ...this.home!.environment, ELECTRON_RUN_AS_NODE: '1' } });
    const runtime = this.runtime;
    let id: string | undefined;
    const abort = () => { if (id) void runtime.cancel(id).catch(() => undefined); };
    hooks.signal.addEventListener('abort', abort, { once: true });
    try {
      hooks.signal.throwIfAborted();
      const started = runtime.start({ spec: scope.spec, sourceLanguage: scope.profile.sourceLanguage, targetLanguage: scope.profile.targetLanguage,
        workspaceFiles: scope.profile.workspaceFiles, writeFiles: scope.profile.writeFiles, context: scope.context,
        translationMode: scope.translationMode, taskKind: scope.taskKind, moduleProtocol: scope.moduleProtocol,
        globalProtocol: scope.globalProtocol, historyView: scope.historyView, evidenceScopes: scope.evidenceScopes });
      id = started.id;
      let result = await this.wait(runtime, id, hooks);
      if (result.plan?.protocolCandidates?.length) {
        this.protocol = mergeGlobalProtocol(this.protocol, { invariants: result.plan.protocolCandidates.map(candidate => ({
          scope: candidate.scope?.length ? candidate.scope : [module.id], rule: candidate.rule, source: 'observed', status: 'proposed', note: candidate.note,
        })) }, run.id);
      }
      if (!integration && result.status === 'completed' && result.compilations.at(-1)?.success) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          module.changedFiles = result.changes.filter(change => change.applied && !change.rolledBack).map(change => change.path);
          hooks.onProgress?.('verifying', `正在验证 ${module.name}，第 ${attempt} 轮。`);
          module.moduleVerification = await this.drivers.verify({ root: await this.verificationRoot(root, module.id, hooks.signal), module, requirement: run.requirement, model: this.model!, candidates: selected,
            historyView: this.history.get(module.id), protocol, signal: hooks.signal, previous: module.moduleVerification,
            log: message => hooks.onProgress?.('verifying', message) });
          await this.preserveVerificationEvidence(module.id);
          hooks.onProgress?.('verifying', `${module.name}：${module.moduleVerification.disposition}`);
          const verification = module.moduleVerification.result;
          this.protocol = recordProtocolChecks(this.protocol, verification?.protocolChecks, module.id);
          if (!verification || module.moduleVerification.disposition === 'verified' || attempt === 5) break;
          if (verification.reason === 'agent-timeout' || verification.reason === 'model-failure') continue;
          if (module.moduleVerification.disposition !== 'production-defect') break;
          runtime.repairAfterVerification(id, { attempt, status: 'failure', reason: verification.reason, issue: verification.issue, functions: verification.functions });
          hooks.onProgress?.('generating', `Verifier 已发现生产代码问题，正在交回同一 Translator 修复 ${module.name}。`);
          result = await this.wait(runtime, id, hooks);
          if (result.status !== 'completed' || !result.compilations.at(-1)?.success) break;
        }
      }
      await persistGlobalProtocol(this.protocolPath, this.protocol);
      return result;
    } finally {
      hooks.signal.removeEventListener('abort', abort);
      await runtime.shutdown(); this.runtime = undefined;
    }
  }

  /** Integration may change earlier modules. Revalidate the final assembled bytes before claiming behavior success. */
  async verifyFinal(run: ProjectPipelineRun, sourceHash: string, signal: AbortSignal, log: (message: string) => void): Promise<ProjectPipelineModule[]> {
    const modules = structuredClone(run.modules.filter(module => !module.taskKind && !module.id.startsWith('pipeline-integration-repair')));
    const owned = new Set(modules.flatMap(module => [...(module.target.module?.sourceFiles ?? []), ...(module.changedFiles ?? [])]));
    const added = run.modules.filter(module => module.taskKind === 'project-integration').flatMap(module => module.changedFiles ?? []).filter(file => !owned.has(file));
    if (modules[0]) modules[0].changedFiles = [...new Set([...(modules[0].changedFiles ?? []), ...added])];
    for (const module of modules) {
      signal.throwIfAborted(); log(`验证最终项目中的模块：${module.name}`);
      const candidates = module.candidates.filter(candidate => module.selectedCandidateIds?.includes(candidate.id));
      if (candidates.length && !this.history.has(module.id)) {
        // History views are temporary. Recreate them from the pinned selection
        // when a restarted run skips this module's generation stage.
        try {
          const history = await this.options.codeIntelligence.createHistoryModulesView({ workspaceRoot: run.outputRoot!, candidates: candidates.map(candidate => {
            const source = candidate.sourceModule!;
            return { repositoryId: source.repositoryId, analysisRevision: source.analysisRevision, projectId: source.projectId,
              moduleId: source.moduleId, name: source.name, language: candidate.language, sourceFiles: source.sourceFiles ?? [candidate.path],
              preferredFiles: candidate.moduleMatch?.previewFiles, relevanceTerms: [module.name, module.target.signature] };
          }) });
          this.history.set(module.id, history);
        } catch { log(`${module.name} 的固定历史视图不可用，最终验证改用公共需求与目标契约。`); }
      }
      module.moduleVerification = await this.drivers.verify({ root: await this.verificationRoot(run.outputRoot!, module.id, signal), module, requirement: run.requirement, model: this.model!, candidates,
        historyView: this.history.get(module.id), signal, previous: module.moduleVerification,
        protocol: projectModuleProtocol(this.protocol, { moduleId: module.id, relatedModules: module.dependsOn, ownedFiles: module.target.module?.sourceFiles }), log });
      await this.preserveVerificationEvidence(module.id);
      module.moduleVerification.sourceHash = sourceHash;
    }
    return modules;
  }

  private async wait(runtime: CodexRuntime, id: string, hooks: Hooks): Promise<WorkspaceTranslationRun> {
    let last = '', planRecorded = false;
    for (;;) {
      hooks.signal.throwIfAborted();
      const run = runtime.get(id), key = `${run.status}:${run.events?.length}:${run.changes.length}`;
      if (run.plan && !planRecorded) { planRecorded = true; await hooks.onPlan(run.plan); }
      if (key !== last) { last = key; hooks.onRun(run); }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run;
      await delay(200, undefined, { signal: hooks.signal });
    }
  }

  /** Keep generated tests and repair evidence outside the delivered project. Each
   * module retains its harness across attempts; refresh all production sources
   * before each attempt so dependency and Integration changes are verified. */
  private async verificationRoot(output: string, moduleId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    let root = this.verificationRoots.get(moduleId);
    if (!root) {
      root = await mkdtemp(path.join(tmpdir(), 'recast-verification-'));
      this.verificationRoots.set(moduleId, root);
      const excluded = new Set(['.git', '.forexplore', '.forexpore', '.agent-tmp', '.translation-verifier-tests', '.translation-verifier-coverage', 'bin', 'obj', 'target', 'dist', 'coverage']);
      await cp(output, root, { recursive: true, filter: from => { signal.throwIfAborted(); return !path.relative(output, from).split(path.sep).some(part => excluded.has(part)); } });
      await this.copyVerificationEvidence(this.verificationArchive(moduleId), path.join(root, '.forexplore', 'translation-verifier-evidence'));
    }
    const sources = await prepareProjectIntegrationContext(output);
    for (const file of sources.writeFiles) {
      signal.throwIfAborted(); const destination = path.join(root, file);
      await mkdir(path.dirname(destination), { recursive: true }); await cp(path.join(output, file), destination);
    }
    return root;
  }

  private verificationArchive(moduleId: string): string {
    return path.join(this.verificationOutput!, '.forexplore', 'project-pipeline-verifier', createHash('sha256').update(moduleId).digest('hex'));
  }
  private async copyVerificationEvidence(from: string, to: string): Promise<void> {
    try { await readdir(from); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await mkdir(to, { recursive: true }); await cp(from, to, { recursive: true, errorOnExist: false, force: false });
  }
  private async preserveVerificationEvidence(moduleId: string): Promise<void> {
    const root = this.verificationRoots.get(moduleId);
    if (root && this.verificationOutput) await this.copyVerificationEvidence(path.join(root, '.forexplore', 'translation-verifier-evidence'), this.verificationArchive(moduleId));
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.runtime?.shutdown(); } catch (error) { errors.push(error); }
    this.runtime = undefined;
    for (const moduleId of this.verificationRoots.keys()) try { await this.preserveVerificationEvidence(moduleId); } catch (error) { errors.push(error); }
    const results = await Promise.allSettled([
      ...[...this.history.values()].map(view => removeHistory(view.root)),
      ...[...this.verificationRoots.values()].map(root => rm(root, { recursive: true, force: true })),
      this.home?.cleanup(),
    ]);
    errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
    this.history.clear(); this.verificationRoots.clear(); this.verificationOutput = undefined; this.home = undefined; this.model = undefined;
    if (errors.length) throw new Error('部分运行资源未能清理，请检查运行目录权限。');
  }
}

async function removeHistory(root: string): Promise<void> {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await removeHistory(child); else await chmod(child, 0o644);
  }
  await rm(root, { recursive: true, force: true });
}
