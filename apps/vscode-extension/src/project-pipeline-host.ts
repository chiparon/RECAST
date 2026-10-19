import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { WorkspaceCompilation, WorkspaceCompileCommand } from '@forexplore/contracts';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import type { ServiceManager } from './service-manager';
import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol/messages';
import { ProjectPipeline } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import { buildProjectPipelineModules } from './project-pipeline-plan';
import { ProjectPipelineBackend } from './project-pipeline-backend';
import type { PipelineModel } from './project-module-verifier';
import type { ProjectPipelineModule, ProjectPipelineRun } from './project-pipeline-types';

const runtimeService = () => require('@forexplore/adaptation-service/workspace-compiler') as {
  compileWorkspace(root: string, command: WorkspaceCompileCommand, signal: AbortSignal): Promise<WorkspaceCompilation>;
};
const lastRunKey = 'forexplore.projectPipeline.lastRun';

export class ProjectPipelineHost {
  private readonly files: ProjectPipelineFiles;
  private readonly pipeline: ProjectPipeline;
  private readonly knownRuns = new Set<string>();
  private config?: { compileCommand: WorkspaceCompileCommand; verification?: { command: WorkspaceCompileCommand; protectedFiles: string[] } };
  constructor(private readonly options: {
    context: vscode.ExtensionContext; codeIntelligence: CodeIntelligenceHost; services: ServiceManager;
    endpoint(): { url: string; token?: string }; publish(message: HostToWebviewMessage): void;
    selectRoot(root: string): void; model(): Promise<PipelineModel>;
  }) {
    this.files = new ProjectPipelineFiles(options.context.globalStorageUri.fsPath);
    const previous = options.context.globalState.get<string>(lastRunKey); if (previous) this.knownRuns.add(previous);
    const backend = new ProjectPipelineBackend({ codeIntelligence: options.codeIntelligence,
      endpoint: () => options.endpoint().url, ensureStarted: () => options.services.ensureStarted(), model: options.model,
      compileCommand: () => this.config!.compileCommand, protectedFiles: () => this.config?.verification?.protectedFiles ?? [],
      codexCommand: process.env.ADAPTATION_CODEX_COMMAND?.trim(), codexHome: process.env.ADAPTATION_CODEX_HOME?.trim(),
    });
    this.pipeline = new ProjectPipeline({
      proactiveIntegration: true,
      initialize: (run, signal, log) => backend.prepare(run, signal, log),
      finish: () => backend.close(),
      prepare: async (input, signal, log) => {
        if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区。');
        log('等待结构索引与项目建模完成…'); await options.codeIntelligence.waitForProjects(); signal.throwIfAborted();
        const entry = (await options.codeIntelligence.explorerData()).find(item => item.repository.repositoryId === input.repositoryId && item.projectId === input.projectId && item.repository.role === 'target');
        if (!entry || entry.index.analysisRevision !== entry.repository.activeRevision) throw new Error('只能执行当前已导入目标项目的活动版本，请重新选择目标项目。');
        if (entry.analysis?.state !== 'ready' || !entry.analysis.proposal) throw new Error('目标项目建模尚未完成或已失败，请先在工程理解结果中完成建模。');
        const root = await realpath(entry.repository.localPath);
        for (const document of vscode.workspace.textDocuments) if (document.isDirty && document.uri.scheme === 'file') {
          const relative = path.relative(root, document.uri.fsPath); if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('目标工程存在未保存文件，请先保存后开始。');
        }
        options.selectRoot(root); await options.services.ensureStarted(); signal.throwIfAborted();
        const settings = vscode.workspace.getConfiguration('forexplore');
        const project = entry.index.projects.find(project => project.projectId === input.projectId)!;
        const compileCommand = settings.inspect<WorkspaceCompileCommand>('backend.compileCommand')?.globalValue ?? {
          executable: process.execPath, args: [path.join(options.context.extensionPath, 'dist/extension/workspace-compile.cjs')], timeoutMs: 120_000, ...(project.relativePath ? { cwd: project.relativePath } : {}),
        };
        const verification = settings.inspect<NonNullable<typeof this.config>['verification']>('backend.verification')?.globalValue;
        this.config = { compileCommand, ...(verification ? { verification } : {}) };
        const modules = buildProjectPipelineModules(entry.index, entry.projectId, entry.analysis.proposal.modules, verification?.protectedFiles);
        const current = this.pipeline.current!;
        log('正在创建独立输出副本并固定源文件快照…');
        const output = await this.files.snapshot(root, current.id, signal);
        // Hash the copied bytes against the index, so stale models cannot authorize a new source tree.
        for (const file of entry.index.files.filter(file => file.projectId === input.projectId)) {
          if (file.relativePath.split('/').some(part => ['.git', '.forexplore', 'node_modules', 'bin', 'obj', 'dist', 'target', 'build'].includes(part))) continue;
          const copied = await readFile(path.join(output.outputRoot, file.relativePath)).catch(() => undefined);
          if (!copied || createHash('sha256').update(copied).digest('hex') !== file.sha256) throw new Error(`目标文件与索引快照不一致，请刷新索引后重试：${file.relativePath}`);
        }
        log(verification ? '已绑定宿主配置的固定验收测试；保护文件不进入代码写入范围。' : '将使用模块 Verifier 验证需求行为；未配置额外固定验收命令。');
        return { projectName: `${entry.repository.displayName} / ${project.displayName}`, analysisRevision: entry.index.analysisRevision,
          analysisHash: entry.index.analysisHash, modules, ...output };
      },
      search: (module, input, signal) => backend.search(module, input, signal),
      generate: (module, run, hooks) => backend.generate(module, run, hooks),
      validate: async (run, signal, log) => {
        const root = this.files.output(run), config = this.config!;
        await this.files.assertWriteScope(run);
        const protectedBefore = await this.protectedHashes(root, config.verification?.protectedFiles ?? []);
        const compilation = await runtimeService().compileWorkspace(root, config.compileCommand, signal);
        const verification = compilation.success && config.verification ? await runtimeService().compileWorkspace(root, config.verification.command, signal) : undefined;
        await this.files.assertWriteScope(run);
        const sourceHash = await this.files.sourceHash(run);
        const modules = compilation.success && (!verification || verification.success)
          ? (await backend.verifyFinal(run, sourceHash, signal, log ?? (() => {}))).map(module => ({ id: module.id, verification: module.moduleVerification! })) : undefined;
        await this.files.assertWriteScope(run);
        if (await this.files.sourceHash(run) !== sourceHash) throw new Error('最终验证期间生产文件发生变化，禁止发布。');
        const protectedAfter = await this.protectedHashes(root, config.verification?.protectedFiles ?? []);
        return { compilation, ...(verification ? { verification } : {}), protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
          sourceHash, coverage: null, ...(modules ? { modules } : {}) };
      },
      sourceHash: run => this.files.sourceHash(run), publish: (run, signal) => this.files.publish(run, signal),
      save: async run => { await this.files.save(run); await options.context.globalState.update(lastRunKey, run.id); },
      changed: run => { this.knownRuns.add(run.id); options.publish({ type: 'PROJECT_PIPELINE_STATE', run }); },
    });
  }
  get busy(): boolean { return this.pipeline.busy; }
  async restore(): Promise<void> {
    const run = this.pipeline.current; if (run) { this.options.publish({ type: 'PROJECT_PIPELINE_STATE', run }); return; }
    const id = this.options.context.globalState.get<string>(lastRunKey);
    if (id) { const previous = await this.files.read(id).catch(() => undefined); if (previous) this.options.publish({ type: 'PROJECT_PIPELINE_STATE', run: previous }); }
  }
  async handle(message: Extract<WebviewToHostMessage, { type: 'START_PROJECT_PIPELINE' | 'PROJECT_PIPELINE_ACTION' }>): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区。');
    if (message.type === 'START_PROJECT_PIPELINE') { this.pipeline.start(message.input); return; }
    if (!this.knownRuns.has(message.runId)) throw new Error('本窗口不存在该项目运行。');
    if (message.action === 'cancel') { this.pipeline.cancel(message.runId); return; }
    const run = this.pipeline.current?.id === message.runId ? this.pipeline.current! : await this.files.read(message.runId);
    if (message.action === 'read') { this.options.publish({ type: 'PROJECT_PIPELINE_STATE', run }); return; }
    if (message.action === 'open-diff') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: await this.files.diff(run), language: 'diff' })); return;
    }
    if (message.action === 'open-output') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.files.output(run)), { forceNewWindow: true }); return;
    }
    const report = path.join(this.files.directory(run.id), 'acceptance-report.md');
    await this.pipeline.flush();
    if (message.action === 'open-report') { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(report))); return; }
    if (message.action === 'export-report') {
      const destination = await vscode.window.showSaveDialog({ title: '导出项目验收报告', defaultUri: vscode.Uri.file(path.join(this.files.directory(run.id), `recast-report-${run.id}.md`)), filters: { Markdown: ['md'], JSON: ['json'] } });
      if (destination?.scheme === 'file') {
        const source = destination.fsPath.toLowerCase().endsWith('.json') ? path.join(this.files.directory(run.id), 'run.json') : report;
        await vscode.workspace.fs.writeFile(destination, await vscode.workspace.fs.readFile(vscode.Uri.file(source)));
      }
    }
  }
  private async protectedHashes(root: string, files: string[]): Promise<string[]> {
    return Promise.all(files.map(async file => {
      const absolute = await realpath(path.resolve(root, file)), relative = path.relative(root, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(absolute)).isFile()) throw new Error('固定验收文件不在输出工程内。');
      return createHash('sha256').update(await readFile(absolute)).digest('hex');
    }));
  }
  dispose(): void { const run = this.pipeline.current; if (run) this.pipeline.cancel(run.id); }
}
