import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { indexingProgressMessage, type RepositoryIndexingProgress } from './indexing-progress';
import { isTargetImportTask, type TargetImportTask } from './target-import-task-types';
import type { TargetWorkspaceAddMode } from './protocol/messages';
import type { CodeIntelligencePresentation } from './ui-types';

interface Store { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
export class TargetImportTasks {
  private tasks: TargetImportTask[];
  private writes: Promise<void> = Promise.resolve();
  private writing = false;
  private pendingSnapshot?: TargetImportTask[];
  constructor(private readonly options: { store: Store; key: string; previousKey?: string;
    publish(tasks: TargetImportTask[]): void; onPersistenceError(error: unknown): void; now?: () => number; concurrent?: boolean }) {
    const read = (key: string) => {
      const value = options.store.get<unknown>(key);
      return Array.isArray(value) ? value.filter(isTargetImportTask) : [];
    };
    this.tasks = [...new Map([...read(options.key), ...(options.previousKey ? read(options.previousKey) : [])]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map(task => [task.id, task])).values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(task => structuredClone(task));
    for (const task of this.tasks) if (task.status === 'running') {
      task.elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.activeStartedAt ?? task.createdAt));
      delete task.activeStartedAt;
      task.status = 'interrupted'; task.endedAt = task.updatedAt;
      task.updatedAt = this.at();
      task.message = '上次导入已中断，可重试；已完成的索引和模型会复用。';
      task.events.push({ at: task.updatedAt, stage: task.stage, message: task.message });
      task.events = task.events.slice(-200);
    }
    this.save();
  }
  private at() { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }
  snapshot(): TargetImportTask[] { return structuredClone(this.tasks); }
  get(id: string) { return this.tasks.find(task => task.id === id); }
  get active() { return this.tasks.find(task => task.status === 'running'); }
  flush() { return this.writes; }
  private save() {
    const snapshot = this.snapshot();
    this.options.publish(snapshot);
    this.pendingSnapshot = snapshot;
    if (this.writing) return;
    this.writing = true;
    this.writes = (async () => {
      try {
        while (this.pendingSnapshot) {
          const latest = this.pendingSnapshot;
          this.pendingSnapshot = undefined;
          await this.options.store.update(this.options.key, latest);
        }
      } finally { this.writing = false; }
    })().catch(error => { this.options.onPersistenceError(error); throw error; });
    // Progress callbacks are synchronous; critical transitions explicitly await flush().
    void this.writes.catch(() => {});
  }
  begin(mode: TargetWorkspaceAddMode, previousId?: string, initial: Partial<Pick<TargetImportTask, 'repositoryId' | 'analysisRevision' | 'displayName' | 'stage' | 'message' | 'durationUnknown'>> = {}): string {
    if (this.active && !this.options.concurrent) throw new Error('已有目标工程正在导入，请等待完成或取消当前任务。');
    const previous = previousId && this.get(previousId);
    if (previous && previous.status === 'interrupted') {
      previous.status = 'running'; delete previous.endedAt;
      previous.activeStartedAt = this.at();
      this.update(previous.id, { message: '正在恢复工作区变更中断的导入…' });
      return previous.id;
    }
    const at = this.at(), id = randomUUID(), message = '请选择目标工程目录…';
    this.tasks.unshift({ id, mode, status: 'running', stage: 'selecting', createdAt: at, updatedAt: at,
      activeStartedAt: at, elapsedMs: 0,
      displayName: '待选择目标工程', indexReady: false, modelReady: false, message, ...initial,
      events: [{ at, stage: initial.stage ?? 'selecting', message: initial.message ?? message }] });
    this.tasks = [...this.tasks.filter(task => task.status === 'running'), ...this.tasks.filter(task => task.status !== 'running')].slice(0, 30);
    this.save(); return id;
  }
  update(id: string, patch: Partial<Omit<TargetImportTask, 'id' | 'createdAt' | 'events'>>, log = true) {
    const task = this.get(id);
    if (!task || task.status !== 'running') return;
    const previousMessage = task.message, previousStage = task.stage;
    Object.assign(task, patch, { updatedAt: this.at() });
    task.message = task.message.replace(/\bsk-[a-z0-9_-]{12,}\b/gi, '[已隐藏凭据]').slice(0, 2000);
    if (log && (task.message !== previousMessage || task.stage !== previousStage)) {
      task.events.push({ at: task.updatedAt, stage: task.stage, message: task.message });
      task.events = task.events.slice(-200);
    }
    this.save();
  }
  directory(id: string, directory: string) { this.update(id, { directory, displayName: path.basename(directory) || directory }); }
  indexing(id: string, progress: RepositoryIndexingProgress) {
    const task = this.get(id);
    if (!task || task.repositoryId && task.repositoryId !== progress.repositoryId) return;
    const files = progress.filesCompleted !== undefined;
    const completed = files ? progress.filesCompleted : progress.completed, total = files ? progress.filesTotal : progress.total;
    const message = indexingProgressMessage(progress);
    const last = task.events.at(-1);
    const log = task.stage !== progress.stage || total !== undefined && completed === total
      || !last || (this.options.now?.() ?? Date.now()) - Date.parse(last.at) >= 5000;
    this.update(id, { stage: progress.stage, repositoryId: progress.repositoryId, displayName: progress.displayName, message,
      progress: completed === undefined ? undefined : { completed, ...(total === undefined ? {} : { total }), unit: files || progress.stage === 'parse' ? '个文件' : '条' } }, log);
  }
  observeModel(presentation: CodeIntelligencePresentation) {
    const task = this.active;
    if (!task || task.stage !== 'modeling' || !task.projectId) return;
    const repository = presentation.repositories.find(repository => repository.repositoryId === task.repositoryId);
    if (!repository || repository.activeRevision !== task.analysisRevision) return;
    const analysis = repository.projects.find(project => project.projectId === task.projectId)?.analysis;
    const messages: Record<string, string> = { queued: '索引已完成，正在等待模块建模…', analyzing: '索引已完成，正在生成模块模型…', validating: '正在校验模块模型与源码的对应关系…' };
    const message = analysis?.state === 'ready' && analysis.projection === 'pending' ? '模块模型已生成，正在保存检索信息…'
      : messages[analysis?.state ?? ''];
    if (message && message !== task.message) this.update(task.id, { message });
  }
  finish(id: string, status: Exclude<TargetImportTask['status'], 'running'>, message: string) {
    const task = this.get(id);
    if (!task || task.status !== 'running') return;
    const elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, Date.parse(this.at()) - Date.parse(task.activeStartedAt ?? task.createdAt));
    this.update(id, { status, message: message.slice(0, 2000), endedAt: this.at(),
      elapsedMs, activeStartedAt: undefined,
      ...(status === 'completed' ? { stage: 'complete', modelReady: true, progress: undefined } : {}) });
  }
}

/** Index success is separate from the selected project's complete, validated model. */
export async function finishTargetImportModel(tasks: TargetImportTasks, id: string, ports: {
  scope(directory: string): Promise<{ repositoryId: string; analysisRevision: string }>;
  selectedProject(directory: string): Promise<string | null>;
  ensureModel(scope: { repositoryId: string; analysisRevision: string; projectId: string }, signal: AbortSignal): Promise<unknown>;
}, signal: AbortSignal) {
  signal.throwIfAborted();
  const task = tasks.get(id);
  if (!task?.directory) throw new Error('目标目录未保存，请重新选择目标工程。');
  const scope = await ports.scope(task.directory);
  tasks.update(id, { ...scope, indexReady: true, progress: undefined, message: '源码索引已完成。' });
  const projectId = await ports.selectedProject(task.directory);
  if (!projectId) throw new Error('索引已完成，请在工程资源中选择具体项目，再重试模块建模。');
  tasks.update(id, { stage: 'modeling', projectId, message: '索引已完成，正在生成模块模型…' });
  await ports.ensureModel({ ...scope, projectId }, signal);
  signal.throwIfAborted();
  tasks.finish(id, 'completed', '目标工程导入完成：索引与模块建模均已完成。');
  await tasks.flush();
}
