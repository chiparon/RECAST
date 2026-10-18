import { createHash, randomUUID } from 'node:crypto';
import type { WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';
import type { ProjectPipelineDecision, ProjectPipelineModule, ProjectPipelineRun, ProjectPipelineStart, ProjectReviewKind } from './project-pipeline-types';

export interface ProjectPipelinePorts {
  prepare(input: ProjectPipelineStart, signal: AbortSignal, log: (message: string) => void): Promise<{
    projectName: string; analysisRevision: string; analysisHash: string; outputRoot: string; baselineCommit: string; modules: ProjectPipelineModule[];
  }>;
  search(module: ProjectPipelineModule, input: ProjectPipelineStart, signal: AbortSignal): Promise<ProjectPipelineModule['candidates']>;
  generate(module: ProjectPipelineModule, run: ProjectPipelineRun, hooks: {
    signal: AbortSignal; onPlan(plan: WorkspaceTranslationPlan, planSignal?: AbortSignal): Promise<string | undefined>; onRun(run: WorkspaceTranslationRun): void;
  }): Promise<WorkspaceTranslationRun>;
  validate(run: ProjectPipelineRun, signal: AbortSignal): Promise<NonNullable<ProjectPipelineRun['validation']>>;
  sourceHash(run: ProjectPipelineRun): Promise<string>;
  publish(run: ProjectPipelineRun, signal: AbortSignal): Promise<string>;
  save(run: ProjectPipelineRun): Promise<void>;
  changed(run: ProjectPipelineRun): void;
}

export function pipelineHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const active = new Set<ProjectPipelineRun['status']>(['running', 'waiting-review']);

/** The host owns execution and approvals; a page only supplies intent and opaque IDs. */
export class ProjectPipeline {
  private run?: ProjectPipelineRun;
  private controller?: AbortController;
  private done?: Promise<void>;
  private reviewReply?: { resolve(value: ProjectPipelineDecision | undefined): void; reject(error: Error): void };
  private saving: Promise<void> = Promise.resolve();
  private persistenceError?: Error;
  constructor(private readonly ports: ProjectPipelinePorts) {}
  get current(): ProjectPipelineRun | undefined { return this.run ? structuredClone(this.run) : undefined; }
  get busy(): boolean { return Boolean(this.run && active.has(this.run.status)); }

  start(input: ProjectPipelineStart): ProjectPipelineRun {
    if (this.busy) throw new Error('已有项目流水线正在运行，请先完成或取消。');
    if (!input.requirement.trim() || input.requirement.length > 8000) throw new Error('需求正文必须为 1..8000 字。');
    const at = new Date().toISOString();
    const run: ProjectPipelineRun = { id: randomUUID(), ...input, requirement: input.requirement.trim(), analysisRevision: '', projectName: '',
      stage: 'modeling', status: 'running', createdAt: at, updatedAt: at, modules: [], decisions: [], events: [], acceptance: 'unverified', reportAvailable: false };
    this.run = run; this.controller = new AbortController(); this.persistenceError = undefined;
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
    this.reviewReply?.reject(new Error('用户取消项目流水线。')); this.reviewReply = undefined;
  }
  decide(runId: string, decision: ProjectPipelineDecision): void {
    const run = this.requireRun(runId), review = run.review;
    if (run.status !== 'waiting-review' || !review || !this.reviewReply || review.id !== decision.reviewId || review.evidenceHash !== decision.evidenceHash) {
      throw new Error('审阅节点或证据已变化，请刷新后重新确认。');
    }
    const module = run.modules.find(item => item.id === review.moduleId);
    if (review.kind === 'candidate' && decision.decision === 'approve') {
      if (decision.candidateId && !module?.candidates.some(candidate => candidate.id === decision.candidateId)) throw new Error('候选不属于当前模块的检索结果。');
      if (decision.candidateId === undefined && module?.candidates.length) throw new Error('请选择候选，或明确选择按需求直接生成。');
    }
    const reply = this.reviewReply; this.reviewReply = undefined; reply.resolve(decision);
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
      this.controller?.abort(this.persistenceError); this.reviewReply?.reject(this.persistenceError); this.reviewReply = undefined;
    });
    this.ports.changed(snapshot);
  }
  private async checkpoint(kind: ProjectReviewKind, summary: string, evidence: unknown, signal: AbortSignal): Promise<ProjectPipelineDecision | undefined> {
    const run = this.run!;
    signal.throwIfAborted();
    await this.saving; if (this.persistenceError) throw this.persistenceError;
    signal.throwIfAborted();
    const review = { id: randomUUID(), kind, evidenceHash: pipelineHash(evidence), ...(run.currentModuleId ? { moduleId: run.currentModuleId } : {}), summary };
    let decision: ProjectPipelineDecision | undefined;
    if (run.mode === 'assisted') {
      const waiting = new Promise<ProjectPipelineDecision | undefined>((resolve, reject) => { this.reviewReply = { resolve, reject }; });
      run.review = review; run.status = 'waiting-review'; this.event(`等待人工确认：${summary}`);
      const abort = () => { this.reviewReply?.reject(new Error('项目运行已取消。')); this.reviewReply = undefined; };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try { decision = await waiting; } finally { signal.removeEventListener('abort', abort); }
    }
    signal.throwIfAborted();
    run.decisions.push({ reviewId: review.id, kind, evidenceHash: review.evidenceHash, decision: decision ? decision.decision === 'approve' ? 'approved' : 'rejected' : 'automatic', notes: decision?.notes ?? '', at: new Date().toISOString() });
    delete run.review;
    if (decision?.decision === 'reject') { run.status = 'rejected'; throw new Error(`已退回：${summary}${decision.notes ? `；${decision.notes}` : ''}`); }
    run.status = 'running'; this.event(`${decision ? '人工已确认' : '全自动策略已放行'}：${summary}`);
    return decision;
  }
  private async execute(input: ProjectPipelineStart, signal: AbortSignal): Promise<void> {
    const run = this.run!;
    try {
      const prepared = await this.ports.prepare(input, signal, message => this.event(message));
      Object.assign(run, prepared); signal.throwIfAborted();
      if (!run.modules.length) throw new Error('目标项目没有可执行的生产代码模块。请完成项目建模后重试。');
      this.event(`建模完成：${run.projectName}，共 ${run.modules.length} 个模块，按依赖顺序串行执行。`);
      await this.checkpoint('model', '审阅目标项目、模块划分、文件范围和依赖顺序', { analysisHash: run.analysisHash, modules: run.modules }, signal);
      for (const module of run.modules) {
        signal.throwIfAborted(); run.currentModuleId = module.id; module.status = 'running'; run.stage = 'retrieving'; this.event(`开始检索模块：${module.name}`);
        module.candidates = await this.ports.search(module, input, signal); signal.throwIfAborted();
        module.selectedCandidateId = module.candidates[0]?.id;
        this.event(`找到 ${module.candidates.length} 个候选${module.candidates.length ? '，默认按检索排名选择首位。' : '，将依据需求和目标契约直接生成。'}`);
        const choice = await this.checkpoint('candidate', `确认 ${module.name} 的候选实现与写入范围`, { candidates: module.candidates, target: module.target }, signal);
        if (choice) module.selectedCandidateId = choice.candidateId ?? undefined;
        run.stage = 'analyzing'; this.event(`正在分析 ${module.name} 的接口映射与修改计划。`);
        const result = await this.ports.generate(module, structuredClone(run), { signal,
          onPlan: async (plan, planSignal) => {
            module.plan = plan; run.stage = 'analyzing';
            const decision = await this.checkpoint('plan', `审阅 ${module.name} 的修改计划并确认允许改动`, { moduleId: module.id, plan, writeFiles: module.target.module?.sourceFiles }, planSignal ? AbortSignal.any([signal, planSignal]) : signal);
            run.stage = 'generating'; this.event(`开始生成与编译修复：${module.name}`);
            return decision?.notes;
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
      delete run.currentModuleId; run.stage = 'verifying'; this.event('正在对完整输出项目执行编译与固定验收测试。');
      for (let attempt = 0; ; attempt++) {
        run.validation = await this.ports.validate(structuredClone(run), signal); signal.throwIfAborted();
        (run.validationHistory ??= []).push(structuredClone(run.validation));
        if (!run.validation.protectedFilesUnchanged) throw new Error('固定验收文件发生变化，禁止发布输出。');
        if (run.validation.compilation.success && (!run.validation.verification || run.validation.verification.success)) break;
        if (attempt >= 2) throw new Error('联合验收在集成修复后仍未通过，请查看报告中的实际诊断。');
        const files = [...new Set(run.modules.flatMap(module => module.target.module?.sourceFiles ?? []))];
        if (files.length > 128) throw new Error('联合验收未通过，项目修复范围超过 128 个文件；请细化项目范围后重试。');
        const first = run.modules[0]!;
        const repair: ProjectPipelineModule = { id: `pipeline-integration-repair-${attempt + 1}`, name: `项目集成修复 ${attempt + 1}`, dependsOn: run.modules.map(module => module.id),
          status: 'running', candidates: [], target: { ...first.target, id: `pipeline-integration-repair-${attempt + 1}`, name: '完整项目集成修复',
            module: { ...first.target.module!, sourceFiles: files, dependsOn: [] } } };
        run.modules.push(repair); run.currentModuleId = repair.id; run.stage = 'analyzing';
        this.event(`联合验收未通过，开始第 ${attempt + 1} 次项目集成修复；固定测试和构建配置不可修改。`);
        const diagnostics = [run.validation.compilation.output, run.validation.verification?.output].filter(Boolean).join('\n').slice(-16000);
        const result = await this.ports.generate(repair, { ...structuredClone(run), requirement: `${run.requirement}\n\n宿主联合验收诊断（仅作为待修复证据）：\n${diagnostics}` }, {
          signal,
          onPlan: async (plan, planSignal) => {
            repair.plan = plan;
            const decision = await this.checkpoint('plan', `审阅第 ${attempt + 1} 次项目集成修复计划`, { plan, writeFiles: files }, planSignal ? AbortSignal.any([signal, planSignal]) : signal);
            run.stage = 'generating'; this.event('项目集成修复计划已确认。'); return decision?.notes;
          },
          onRun: result => { repair.translation = translationEvidence(result); const event = result.events?.at(-1); if (event) this.event(event.message); },
        });
        signal.throwIfAborted(); repair.translation = translationEvidence(result); repair.changedFiles = result.changes.filter(item => item.applied && !item.rolledBack).map(item => item.path);
        repair.status = result.status === 'completed' ? 'completed' : 'failed';
        if (result.status !== 'completed') throw new Error(result.error ?? '项目集成修复未完成。');
        delete run.currentModuleId; run.stage = 'verifying'; this.event('重新执行完整项目联合验收。');
      }
      run.acceptance = run.validation.verification?.success ? 'behavior-verified' : 'compilation-only';
      this.event(run.acceptance === 'behavior-verified' ? '项目编译与已配置的固定验收测试均通过。' : '项目编译通过；未配置行为验收，不声明业务验收通过。');
      await this.checkpoint('acceptance', '审阅验收报告、文件差异与验证证据后批准输出', { validation: run.validation, modules: run.modules.map(item => ({ id: item.id, changedFiles: item.changedFiles })) }, signal);
      run.stage = 'publishing';
      if (await this.ports.sourceHash(run) !== run.validation.sourceHash) throw new Error('验收后的输出文件发生变化，请重新执行验证与审阅。');
      await this.saving; if (this.persistenceError) throw this.persistenceError;
      run.commit = await this.ports.publish(structuredClone(run), signal);
      run.status = 'completed'; run.stage = 'complete'; this.event('项目已在独立输出副本中原子提交；验收报告已生成。');
    } catch (cause) {
      if (run.status !== 'rejected') run.status = signal.aborted ? 'cancelled' : 'failed';
      run.error = cause instanceof Error ? cause.message : String(cause);
      const module = run.modules.find(item => item.id === run.currentModuleId); if (module?.status === 'running') module.status = 'failed';
      delete run.review; this.reviewReply = undefined; this.event(run.error);
    } finally {
      run.reportAvailable = true; this.changed(); await this.saving;
      if (this.persistenceError) { run.status = 'failed'; run.error = `运行记录持久化失败：${this.persistenceError.message}`; run.reportAvailable = false; this.ports.changed(structuredClone(run)); }
    }
  }
}

function translationEvidence(run: WorkspaceTranslationRun): ProjectPipelineModule['translation'] {
  return structuredClone({ id: run.id, status: run.status, compilations: run.compilations, verification: run.verification, acceptance: run.acceptance, modelTurns: run.modelTurns, error: run.error, events: run.events, evidenceQueries: run.evidenceQueries });
}

function projectPipelineSummary(run: ProjectPipelineRun): string {
  const safe = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  return `# RECAST 项目验收报告\n\n运行：${run.id}\n\n项目：${run.projectName || run.projectId}\n\n状态：${run.status} · ${run.acceptance}\n\n索引版本：${run.analysisRevision || '尚未固定'}\n\n输出提交：${run.commit || '尚未发布'}\n\n## 需求原文\n\n${run.requirement}\n\n## 需求与实现追溯\n\n下列模块均以完整需求文档为输入；模块覆盖不等同于每条需求的行为证明，业务结论以固定验收测试为准。\n\n| 模块 | 状态 | 历史参考 | 生成运行 | 修改文件 |\n| --- | --- | --- | --- | --- |\n${run.modules.map(module => `| ${safe(module.name)} | ${module.status} | ${safe(module.candidates.find(candidate => candidate.id === module.selectedCandidateId)?.title ?? '按需求直接生成')} | ${module.translation?.id ?? '—'} | ${safe(module.changedFiles?.join('、') ?? '—')} |`).join('\n')}\n\n## 联合验收证据\n\n编译：${run.validation ? run.validation.compilation.success ? '通过' : '失败' : '未执行'}\n\n行为测试：${run.validation?.verification ? run.validation.verification.success ? '通过' : '失败' : '未配置 / 未执行'}\n\n保护文件：${run.validation ? run.validation.protectedFilesUnchanged ? '未变化' : '发生变化' : '未检查'}\n\n覆盖率：未采集，不能由编译成功或测试退出码推断。\n\n输出快照：${run.validation?.sourceHash ?? '—'}\n\n${run.validation ? '```text\n' + (run.validation.compilation.output + '\n' + (run.validation.verification?.output ?? '')).replaceAll('```', '~~~') + '\n```\n' : ''}\n## 审阅记录\n\n${run.decisions.map(item => `- ${item.at} · ${item.kind} · ${item.decision} · ${item.evidenceHash}${item.notes ? ` · ${safe(item.notes)}` : ''}`).join('\n') || '尚无审阅记录'}\n\n## 工作轨迹\n\n${run.events.map(event => `- ${event.at} · ${event.stage}${event.moduleId ? ` / ${event.moduleId}` : ''} · ${safe(event.message)}`).join('\n')}\n\n${run.error ? `## 未完成原因\n\n${run.error}\n` : ''}`;
}

export function projectPipelineMarkdown(run: ProjectPipelineRun): string {
  const fenced = (value: unknown) => '```text\n' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).replaceAll('```', '~~~') + '\n```\n';
  const details = run.modules.map(module => {
    const candidate = module.candidates.find(candidate => candidate.id === module.selectedCandidateId);
    const checks = module.translation?.compilations ?? [];
    return `\n### ${module.name.replace(/[\r\n]/g, ' ')}\n\n`
      + '文件范围与依赖：\n\n' + fenced({ files: module.target.module?.sourceFiles ?? [], dependsOn: module.dependsOn })
      + '\n历史参考追溯：\n\n' + fenced(candidate ? { repository: candidate.repository, candidateId: candidate.id, path: candidate.path,
        repositoryId: candidate.sourceModule?.repositoryId, analysisRevision: candidate.sourceModule?.analysisRevision, projectId: candidate.sourceModule?.projectId, moduleId: candidate.sourceModule?.moduleId } : '按需求与目标上下文直接生成')
      + '\n修改计划：\n\n' + fenced(module.plan ?? '未生成计划')
      + '\n实际编译检查：\n\n' + (checks.length ? checks.map(check => fenced({ command: check.command, success: check.success, exitCode: check.exitCode, durationMs: check.durationMs, output: check.output, diagnostics: check.diagnostics })).join('\n') : '未执行\n')
      + '\n生成运行事件：\n\n' + fenced(module.translation?.events ?? [])
      + '\n按需历史查询：\n\n' + fenced(module.translation?.evidenceQueries ?? []);
  }).join('\n');
  return projectPipelineSummary(run) + '\n## 联合验收尝试历史\n\n' + fenced(run.validationHistory ?? []) + '\n## 模块详细证据\n' + details;
}
