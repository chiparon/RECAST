import { currentProjectAnalysis, historyImportState } from './history-import-state';
import { TargetImportTasks } from './target-import-tasks';
import type { TargetImportTask } from './target-import-task-types';
import type { CodeIntelligencePresentation, CodeIntelligenceRepositoryPresentation as Repository } from './ui-types';
import type { RepositoryIndexingProgress } from './indexing-progress';

/** One journal entry per repository attempt; all its subprojects must finish. */
export class HistoryImportTasks {
  readonly journal: TargetImportTasks;
  private repositories = new Map<string, Repository>();
  private restarting = new Map<string, 'index' | 'model' | 'rebuild-model'>();
  private failures = new Map<string, { revision: string; error: unknown }>();
  private failureKey(repositoryId: string, revision?: string | null) { return `${repositoryId}\0${revision ?? ''}`; }
  /** A credential save/startup may explicitly resume a prior failed modelling attempt. */
  resumeModels(repositoryIds?: readonly string[]) {
    for (const repository of this.repositories.values()) {
      if (repositoryIds && !repositoryIds.includes(repository.repositoryId)) continue;
      const latest = this.latest(repository.repositoryId);
      if (latest && ['failed', 'interrupted'].includes(latest.status) && repository.activeRevision && repository.projects.length) {
        this.retry(repository.repositoryId);
      }
    }
  }
  constructor(options: ConstructorParameters<typeof TargetImportTasks>[0]) {
    this.journal = new TargetImportTasks({ ...options, concurrent: true });
  }
  snapshot() { return this.journal.snapshot(); }
  flush() { return this.journal.flush(); }
  private latest(repositoryId: string) { return this.snapshot().find(task => task.repositoryId === repositoryId); }
  private begin(repository: Repository, restored = false) {
    return this.journal.begin('workspace', undefined, { repositoryId: repository.repositoryId,
      displayName: repository.displayName, analysisRevision: repository.activeRevision ?? undefined,
      stage: 'queued', message: '等待解析', durationUnknown: restored });
  }
  /** Called before retry dispatch, so old failure records cannot finish the new attempt. */
  retry(repositoryId: string, mode: 'index' | 'model' | 'rebuild-model' = 'model') {
    const repository = this.repositories.get(repositoryId);
    if (!repository) throw new Error('参考工程已移除，请刷新后重试。');
    const latest = this.latest(repositoryId);
    if (latest?.status === 'running') throw new Error('该参考工程正在导入，请等待当前任务完成。');
    const id = this.begin(repository);
    this.failures.delete(this.failureKey(repositoryId, repository.activeRevision));
    this.restarting.set(repositoryId, mode);
    if (mode !== 'index') this.journal.update(id, { stage: 'modeling', indexReady: Boolean(repository.activeRevision), message: '正在重新准备模块建模…' });
    return id;
  }
  fail(repositoryId: string, error: unknown, revision?: string) {
    if (revision) this.failures.set(this.failureKey(repositoryId, revision), { revision, error });
    const latest = this.latest(repositoryId);
    if (!latest || latest.status !== 'running' || revision && latest.analysisRevision && revision !== latest.analysisRevision || revision && !latest.indexReady) return;
    this.restarting.delete(repositoryId);
    this.journal.finish(latest.id, 'failed', error instanceof Error ? error.message : String(error));
  }
  indexing(progress: RepositoryIndexingProgress) {
    const repository = this.repositories.get(progress.repositoryId);
    if (!repository) return;
    let task = this.latest(repository.repositoryId);
    if (!task || task.status !== 'running') {
      const id = this.begin(repository); task = this.journal.get(id)!;
    }
    this.restarting.delete(repository.repositoryId);
    this.journal.indexing(task.id, progress);
  }
  observe(presentation: CodeIntelligencePresentation) {
    // An unavailable runtime is not evidence that every registered repository vanished.
    if (presentation.runtimeStatus === 'error' || presentation.status === 'initializing') return;
    const visible = new Map(presentation.repositories.filter(repository => repository.role === 'history')
      .map(repository => [repository.repositoryId, repository]));
    for (const task of this.snapshot()) if (task.status === 'running' && task.repositoryId && !visible.has(task.repositoryId)) {
      this.journal.finish(task.id, 'interrupted', '参考工程已从本窗口移除，任务记录已保留。');
    }
    this.repositories = visible;
    for (const repository of visible.values()) {
      // Read-only historical browsing must never certify the active artifacts.
      if (repository.selectedRevision && repository.selectedRevision !== repository.activeRevision) continue;
      const state = historyImportState(repository);
      let task = this.latest(repository.repositoryId);
      const failure = this.failures.get(this.failureKey(repository.repositoryId, repository.activeRevision));
      const latestModelUpdate = Math.max(...repository.projects.map(project => Date.parse(currentProjectAnalysis(repository, project)?.updatedAt ?? '') || 0));
      const freshModelUpdate = !failure && latestModelUpdate > Date.parse(task?.endedAt ?? task?.updatedAt ?? '');
      const reconciled = state.ready && (task?.status === 'interrupted' || task?.status === 'failed' && freshModelUpdate);
      const restored = (!task || reconciled) && !state.busy && (Boolean(repository.activeRevision) || repository.analysisStatus === 'failed');
      const newRevision = task?.analysisRevision && repository.activeRevision && task.analysisRevision !== repository.activeRevision;
      const workStarted = state.busy && (repository.indexing || task?.status === 'completed' || task?.status === 'interrupted' || task?.status === 'failed' && freshModelUpdate && !state.failed);
      if (!task || task.status !== 'running' && (newRevision || workStarted || reconciled)) {
        task = this.journal.get(this.begin(repository, restored))!;
      }
      if (task.status !== 'running') continue;
      if (this.restarting.has(repository.repositoryId)) {
        // Retry scheduling is async; wait for a new active lifecycle or an explicit error.
        const failure = this.failures.get(this.failureKey(repository.repositoryId, repository.activeRevision));
        if (failure?.revision === repository.activeRevision && !repository.indexing) {
          this.journal.update(task.id, { stage: 'modeling', indexReady: Boolean(repository.activeRevision) });
          this.fail(repository.repositoryId, failure.error, failure.revision);
          continue;
        }
        if ((!state.busy || state.failed && !repository.indexing) && !(state.ready && this.restarting.get(repository.repositoryId) === 'model')) continue;
        this.restarting.delete(repository.repositoryId);
      }
      const indexReady = Boolean(repository.activeRevision) && !repository.indexing && repository.analysisStatus !== 'failed';
      const stage = repository.indexing?.stage ?? (indexReady ? 'modeling' : 'indexing');
      const ready = repository.projects.filter(project => {
        const analysis = currentProjectAnalysis(repository, project);
        return analysis?.state === 'ready' && analysis.projection === 'ready';
      }).length;
      const patch: Partial<TargetImportTask> = { stage, indexReady, modelReady: state.ready && repository.projects.length > 0,
        analysisRevision: repository.indexing ? task.analysisRevision : repository.activeRevision ?? undefined,
        displayName: repository.displayName, message: state.text,
        progress: indexReady && repository.projects.length ? { completed: ready, total: repository.projects.length, unit: '个子项目' } : undefined };
      // High frequency file counters use the throttled host callback, not stale snapshots.
      if (repository.indexing && repository.indexing.stage !== 'queued') {
        this.indexing({ ...repository.indexing, stage: repository.indexing.stage, repositoryId: repository.repositoryId, displayName: repository.displayName });
      } else if (Object.entries(patch).some(([key, value]) => JSON.stringify(task![key as keyof TargetImportTask]) !== JSON.stringify(value))) {
        this.journal.update(task.id, patch);
      }
      if (state.failed) this.journal.finish(task.id, 'failed', state.text);
      else if (state.ready) {
        // Empty repositories are indexed, but cannot truthfully claim to have a model.
        if (repository.projects.length) this.journal.finish(task.id, 'completed', state.text);
        else this.journal.finish(task.id, 'failed', '索引完成，未发现可建模子项目，请确认工程目录。');
      } else if (restored) this.journal.finish(task.id, 'interrupted', `${state.text}，可重试导入。`);
      if (failure?.revision === repository.activeRevision && !repository.indexing) {
        this.fail(repository.repositoryId, failure.error, failure.revision);
      }
    }
  }
  stop() {
    for (const task of this.snapshot()) if (task.status === 'running') {
      this.journal.finish(task.id, 'interrupted', '工作区已关闭，导入已中断；重试将复用已完成的索引与模型。');
    }
  }
}
