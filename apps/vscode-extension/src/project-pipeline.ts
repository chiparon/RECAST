import { randomUUID } from 'node:crypto';
import type { WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';
import type { ProjectPipelineModule, ProjectPipelineRun, ProjectPipelineStart } from './project-pipeline-types';

export interface ProjectPipelinePorts {
  initialize?(run: ProjectPipelineRun, signal: AbortSignal, log: (message: string) => void): Promise<void>;
  finish?(): Promise<void>;
  proactiveIntegration?: boolean;
  prepare(input: ProjectPipelineStart, signal: AbortSignal, log: (message: string) => void): Promise<{
    projectName: string; analysisRevision: string; analysisHash: string; outputRoot: string; baselineCommit: string; modules: ProjectPipelineModule[];
  }>;
  search(module: ProjectPipelineModule, input: ProjectPipelineStart, signal: AbortSignal): Promise<ProjectPipelineModule['candidates']>;
  generate(module: ProjectPipelineModule, run: ProjectPipelineRun, hooks: {
    signal: AbortSignal; onProgress?(stage: ProjectPipelineRun['stage'], message: string): void; onPlan(plan: WorkspaceTranslationPlan): Promise<void>; onRun(run: WorkspaceTranslationRun): void;
  }): Promise<WorkspaceTranslationRun>;
  validate(run: ProjectPipelineRun, signal: AbortSignal, log?: (message: string) => void): Promise<NonNullable<ProjectPipelineRun['validation']>>;
  sourceHash(run: ProjectPipelineRun): Promise<string>;
  publish(run: ProjectPipelineRun, signal: AbortSignal): Promise<string>;
  save(run: ProjectPipelineRun): Promise<void>;
  changed(run: ProjectPipelineRun): void;
}

const active = new Set<ProjectPipelineRun['status']>(['running']);

/** The host owns execution; a page only supplies intent and opaque IDs. */
export class ProjectPipeline {
  private run?: ProjectPipelineRun;
  private executing = false;
  private controller?: AbortController;
  private done?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private persistenceError?: Error;
  constructor(private readonly ports: ProjectPipelinePorts) {}
  get current(): ProjectPipelineRun | undefined { return this.run ? structuredClone(this.run) : undefined; }
  get busy(): boolean { return this.executing || Boolean(this.run && active.has(this.run.status)); }

  start(input: ProjectPipelineStart): ProjectPipelineRun {
    if (this.busy) throw new Error('已有项目流水线正在运行，请先完成或取消。');
    if (!input.requirement.trim() || input.requirement.length > 8000) throw new Error('需求正文必须为 1..8000 字。');
    const at = new Date().toISOString();
    const run: ProjectPipelineRun = { id: randomUUID(), ...input, requirement: input.requirement.trim(), analysisRevision: '', projectName: '',
      stage: 'modeling', status: 'running', createdAt: at, updatedAt: at, modules: [], events: [], acceptance: 'unverified', reportAvailable: false };
    this.executing = true; this.run = run; this.controller = new AbortController(); this.persistenceError = undefined;
    this.event('项目流水线已启动，正在固定目标项目版本与模块范围。');
    this.done = this.execute(input, this.controller.signal);
    return structuredClone(run);
  }
  async idle(): Promise<void> { await this.done; await this.saving; }
  async flush(): Promise<void> { await this.saving; if (this.persistenceError) throw this.persistenceError; }
  cancel(runId: string): void {
    this.requireRun(runId);
    if (!this.busy) return;
    this.controller?.abort(new Error('用户取消项目流水线。'));
  }
  private requireRun(id: string): ProjectPipelineRun {
    if (!this.run || this.run.id !== id) throw new Error('项目运行不存在或不属于本窗口。');
    return this.run;
  }
  private event(message: string): void {
    const run = this.run!; run.updatedAt = new Date().toISOString();
    run.events.push({ id: randomUUID(), at: run.updatedAt, stage: run.stage, ...(run.currentModuleId ? { moduleId: run.currentModuleId } : {}), message });
    // Retain the full trace in the host report, rather than inventing progress percentages.
    this.changed();
  }
  private changed(): void {
    const snapshot = structuredClone(this.run!);
    this.saving = this.saving.then(() => this.ports.save(snapshot)).catch(error => {
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
      this.controller?.abort(this.persistenceError);
    });
    this.ports.changed(snapshot);
  }
  private async execute(input: ProjectPipelineStart, signal: AbortSignal): Promise<void> {
    const run = this.run!;
    try {
      const prepared = await this.ports.prepare(input, signal, message => this.event(message));
      Object.assign(run, prepared); signal.throwIfAborted();
      if (!run.modules.length) throw new Error('目标项目没有可执行的生产代码模块。请完成项目建模后重试。');
      await this.ports.initialize?.(structuredClone(run), signal, message => this.event(message));
      this.event(`建模完成：${run.projectName}，共 ${run.modules.length} 个模块，按依赖顺序串行执行。`);
      await this.flush(); signal.throwIfAborted();
      for (const module of run.modules) {
        signal.throwIfAborted(); run.currentModuleId = module.id; module.status = 'running'; run.stage = 'retrieving'; this.event(`开始检索模块：${module.name}`);
        module.candidates = await this.ports.search(module, input, signal); signal.throwIfAborted();
        module.selectedCandidateId = module.selectedCandidateIds?.[0] ?? module.candidates[0]?.id;
        this.event(`找到 ${module.candidates.length} 个候选${module.candidates.length ? `，已自动选择 ${module.selectedCandidateIds?.length ?? 1} 份参考。` : '，将依据需求和目标契约直接生成。'}`);
        await this.flush(); signal.throwIfAborted();
        run.stage = 'analyzing'; this.event(`正在分析 ${module.name} 的接口映射与修改计划。`);
        const result = await this.ports.generate(module, structuredClone(run), { signal,
          onProgress: (stage, message) => { run.stage = stage; this.event(message); },
          onPlan: async plan => {
            module.plan = plan; run.stage = 'analyzing';
            this.changed(); await this.flush(); signal.throwIfAborted();
            run.stage = 'generating'; this.event(`开始生成与编译修复：${module.name}`);
          },
          onRun: result => {
            module.translation = translationEvidence(result);
            const latest = result.events?.at(-1);
            if (latest) this.event(latest.message);
          },
        });
        signal.throwIfAborted(); module.translation = translationEvidence(result); module.changedFiles = result.changes.filter(item => item.applied && !item.rolledBack).map(item => item.path);
        if (result.status !== 'completed') { module.status = 'failed'; throw new Error(result.error || `模块 ${module.name} 生成未完成：${result.status}`); }
        module.status = 'completed'; this.event(`模块已完成：${module.name}，改动 ${module.changedFiles.length} 个文件。`);
      }
      if (this.ports.proactiveIntegration) {
        const first = run.modules[0]!;
        const integration: ProjectPipelineModule = { id: 'pipeline-integration', taskKind: 'project-integration', name: '项目 Integration',
          dependsOn: run.modules.map(module => module.id), status: 'running', candidates: [],
          target: { ...first.target, module: { ...first.target.module!, sourceFiles: [...new Set(run.modules.flatMap(module => module.target.module?.sourceFiles ?? []))] } } };
        run.modules.push(integration); run.currentModuleId = integration.id; run.stage = 'generating';
        this.event('所有模块生成结束，启动主动项目 Integration。');
        const result = await this.ports.generate(integration, structuredClone(run), { signal,
          onPlan: async plan => { integration.plan = plan; this.changed(); },
          onRun: result => { integration.translation = translationEvidence(result); this.changed(); },
          onProgress: (stage, message) => { run.stage = stage; this.event(message); },
        });
        signal.throwIfAborted(); integration.translation = translationEvidence(result);
        integration.changedFiles = result.changes.filter(item => item.applied && !item.rolledBack).map(item => item.path);
        integration.status = result.status === 'completed' ? 'completed' : 'failed';
        if (result.status !== 'completed') throw new Error(result.error ?? '项目 Integration 未完成。');
      }
      delete run.currentModuleId; run.stage = 'verifying'; this.event('正在对完整输出项目执行编译与最终验证。');
      for (let attempt = 0; ; attempt++) {
        run.validation = await this.ports.validate(structuredClone(run), signal, message => this.event(message)); signal.throwIfAborted();
        (run.validationHistory ??= []).push(structuredClone(run.validation));
        if (!run.validation.protectedFilesUnchanged) throw new Error('固定验收文件发生变化，禁止发布输出。');
        if (run.validation.compilation.success && (!run.validation.verification || run.validation.verification.success)) break;
        if (attempt >= 2) throw new Error('联合验收在集成修复后仍未通过，请查看报告中的实际诊断。');
        const files = [...new Set(run.modules.flatMap(module => module.target.module?.sourceFiles ?? []))];
        if (files.length > 128) throw new Error('联合验收未通过，项目修复范围超过 128 个文件；请细化项目范围后重试。');
        const first = run.modules[0]!;
        const repair: ProjectPipelineModule = { id: `pipeline-integration-repair-${attempt + 1}`, taskKind: 'project-integration', name: `项目集成修复 ${attempt + 1}`, dependsOn: run.modules.map(module => module.id),
          status: 'running', candidates: [], target: { ...first.target, id: `pipeline-integration-repair-${attempt + 1}`, name: '完整项目集成修复',
            module: { ...first.target.module!, sourceFiles: files, dependsOn: [] } } };
        run.modules.push(repair); run.currentModuleId = repair.id; run.stage = 'analyzing';
        this.event(`联合验收未通过，开始第 ${attempt + 1} 次项目集成修复；固定测试和构建配置不可修改。`);
        const diagnostics = [run.validation.compilation.output, run.validation.verification?.output].filter(Boolean).join('\n').slice(-16000);
        const result = await this.ports.generate(repair, { ...structuredClone(run), requirement: `${run.requirement}\n\n宿主联合验收诊断（仅作为待修复证据）：\n${diagnostics}` }, {
          signal,
          onPlan: async plan => {
            repair.plan = plan;
            this.changed(); await this.flush(); signal.throwIfAborted();
            run.stage = 'generating'; this.event('项目集成修复计划已生成。');
          },
          onRun: result => { repair.translation = translationEvidence(result); const event = result.events?.at(-1); if (event) this.event(event.message); },
        });
        signal.throwIfAborted(); repair.translation = translationEvidence(result); repair.changedFiles = result.changes.filter(item => item.applied && !item.rolledBack).map(item => item.path);
        repair.status = result.status === 'completed' ? 'completed' : 'failed';
        if (result.status !== 'completed') throw new Error(result.error ?? '项目集成修复未完成。');
        delete run.currentModuleId; run.stage = 'verifying'; this.event('重新执行完整项目联合验收。');
      }
      const finalModules = run.validation.modules;
      if (finalModules?.some(item => item.verification.disposition === 'production-defect')) throw new Error('最终模块验证仍发现生产代码缺陷，已保留输出和证据，禁止发布。');
      const expected = run.modules.filter(module => !module.taskKind);
      const allVerified = finalModules?.length === expected.length && expected.length > 0 && expected.every(module =>
        finalModules?.some(item => item.id === module.id && item.verification.sourceHash === run.validation!.sourceHash && ['verified', 'not-applicable'].includes(item.verification.disposition)));
      run.acceptance = ((allVerified && (finalModules?.some(item => item.verification.disposition === 'verified') || run.validation.verification?.success)) || (!finalModules && run.validation.verification?.success)) ? 'behavior-verified' : 'compilation-only';
      this.event(run.acceptance === 'behavior-verified' ? '最终项目的配置验收门槛已通过；详细行为证据见报告。' : '项目编译通过；部分行为验证未完成或不可用，详见报告。');
      await this.flush(); signal.throwIfAborted();
      run.stage = 'publishing';
      if (await this.ports.sourceHash(run) !== run.validation.sourceHash) throw new Error('验收后的输出文件发生变化，请重新执行验证。');
      await this.saving; if (this.persistenceError) throw this.persistenceError;
      run.commit = await this.ports.publish(structuredClone(run), signal);
      run.status = 'completed'; run.stage = 'complete'; this.event('项目已在独立输出副本中原子提交；验收报告已生成。');
    } catch (cause) {
      run.status = signal.aborted ? 'cancelled' : 'failed';
      run.error = cause instanceof Error ? cause.message : String(cause);
      const module = run.modules.find(item => item.id === run.currentModuleId); if (module?.status === 'running') module.status = 'failed';
      this.event(run.error);
    } finally {
      try { await this.ports.finish?.(); } catch (error) { this.event(`运行资源清理失败：${error instanceof Error ? error.message : String(error)}`); }
      run.reportAvailable = true; this.changed(); await this.saving;
      if (this.persistenceError) { run.status = 'failed'; run.error = `运行记录持久化失败：${this.persistenceError.message}`; run.reportAvailable = false; this.ports.changed(structuredClone(run)); }
      this.executing = false;
    }
  }
}

function translationEvidence(run: WorkspaceTranslationRun): ProjectPipelineModule['translation'] {
  return structuredClone({ id: run.id, status: run.status, agent: run.agent, verificationRepairs: run.verificationRepairs, compilations: run.compilations, verification: run.verification, acceptance: run.acceptance, modelTurns: run.modelTurns, error: run.error, events: run.events, evidenceQueries: run.evidenceQueries });
}

function projectPipelineSummary(run: ProjectPipelineRun): string {
  const safe = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  return `# RECAST 项目验收报告\n\n运行：${run.id}\n\n项目：${run.projectName || run.projectId}\n\n状态：${run.status} · ${run.acceptance}\n\n索引版本：${run.analysisRevision || '尚未固定'}\n\n输出提交：${run.commit || '尚未发布'}\n\n## 需求原文\n\n${run.requirement}\n\n## 需求与实现追溯\n\n下列模块均以完整需求文档为输入；模块覆盖不等同于每条需求的行为证明，最终行为结论以最终项目快照上的模块 Verifier 和已配置固定测试为准。\n\n| 模块 | 状态 | 历史参考 | 生成运行 | 修改文件 |\n| --- | --- | --- | --- | --- |\n${run.modules.map(module => `| ${safe(module.name)} | ${module.status} | ${safe(module.candidates.find(candidate => candidate.id === module.selectedCandidateId)?.title ?? '按需求直接生成')} | ${module.translation?.id ?? '—'} | ${safe(module.changedFiles?.join('、') ?? '—')} |`).join('\n')}\n\n## 联合验收证据\n\n编译：${run.validation ? run.validation.compilation.success ? '通过' : '失败' : '未执行'}\n\n固定行为测试：${run.validation?.verification ? run.validation.verification.success ? '通过' : '失败' : '未配置 / 未执行'}\n\n保护文件：${run.validation ? run.validation.protectedFilesUnchanged ? '未变化' : '发生变化' : '未检查'}\n\n覆盖率：未采集，不能由编译成功或测试退出码推断。\n\n输出快照：${run.validation?.sourceHash ?? '—'}\n\n${run.validation ? '```text\n' + (run.validation.compilation.output + '\n' + (run.validation.verification?.output ?? '')).replaceAll('```', '~~~') + '\n```\n' : ''}\n\n## 工作轨迹\n\n${run.events.map(event => `- ${event.at} · ${event.stage}${event.moduleId ? ` / ${event.moduleId}` : ''} · ${safe(event.message)}`).join('\n')}\n\n${run.error ? `## 未完成原因\n\n${run.error}\n` : ''}`;
}

export function projectPipelineMarkdown(run: ProjectPipelineRun): string {
  const fenced = (value: unknown) => '```text\n' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).replaceAll('```', '~~~') + '\n```\n';
  const details = run.modules.map(module => {
    const candidates = module.candidates.filter(candidate => module.selectedCandidateIds?.includes(candidate.id) || candidate.id === module.selectedCandidateId);
    const checks = module.translation?.compilations ?? [];
    return `\n### ${module.name.replace(/[\r\n]/g, ' ')}\n\n`
      + '文件范围与依赖：\n\n' + fenced({ files: module.target.module?.sourceFiles ?? [], dependsOn: module.dependsOn })
      + '\n历史参考追溯：\n\n' + fenced(candidates.length ? candidates.map(candidate => ({ repository: candidate.repository, candidateId: candidate.id, path: candidate.path,
        repositoryId: candidate.sourceModule?.repositoryId, analysisRevision: candidate.sourceModule?.analysisRevision, projectId: candidate.sourceModule?.projectId, moduleId: candidate.sourceModule?.moduleId })) : '按需求与目标上下文直接生成')
      + '\n自动参考选择：\n\n' + fenced(module.referenceSelection ?? '无历史参考')
      + '\n模块 Verifier 证据（生成阶段）：\n\n' + fenced(module.moduleVerification ?? '未执行')
      + '\n最终模块 Verifier：\n\n' + fenced(run.validation?.modules?.find(item => item.id === module.id)?.verification ?? '未执行 / 不适用')
      + '\nCodex 与 Integration 运行证据：\n\n' + fenced(module.translation?.agent ?? '未执行')
      + '\n修改计划：\n\n' + fenced(module.plan ?? '未生成计划')
      + '\n实际编译检查：\n\n' + (checks.length ? checks.map(check => fenced({ command: check.command, success: check.success, exitCode: check.exitCode, durationMs: check.durationMs, output: check.output, diagnostics: check.diagnostics })).join('\n') : '未执行\n')
      + '\n生成运行事件：\n\n' + fenced(module.translation?.events ?? [])
      + '\n按需历史查询：\n\n' + fenced(module.translation?.evidenceQueries ?? []);
  }).join('\n');
  return projectPipelineSummary(run) + '\n## 联合验收尝试历史\n\n' + fenced(run.validationHistory ?? []) + '\n## 模块详细证据\n' + details;
}
