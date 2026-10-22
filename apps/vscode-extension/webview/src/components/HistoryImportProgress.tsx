import { useState } from 'react';
import type { CodeIntelligenceRepositoryPresentation as Repository } from '../../../src/ui-types';
import type { TargetImportTask } from '../../../src/target-import-task-types';
import { historyImportState } from '../../../src/history-import-state';
import { ImportTaskPanel } from './TargetImportPanel';
export { historyImportState } from '../../../src/history-import-state';

/** Same task surface as targets; the repository list preserves serial queue feedback. */
export function HistoryImportProgress({ repositories, tasks, error, locked = false, onRetry }: {
  repositories: Repository[]; tasks?: TargetImportTask[]; error?: string | null; locked?: boolean;
  onRetry(repository: Repository): void;
}) {
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>();
  const [observedAt] = useState(() => new Date().toISOString());
  const history = [...new Map(repositories.filter(repository => repository.role === 'history')
    .map(repository => [repository.repositoryId, repository])).values()];
  // INIT can arrive before the durable journal snapshot. Never invent an old import duration.
  const effectiveTasks: TargetImportTask[] = tasks?.length ? tasks : history.map(repository => {
    const state = historyImportState(repository);
    const stage = repository.indexing?.stage ?? (repository.activeRevision ? 'modeling' : 'queued');
    return { id: repository.repositoryId, repositoryId: repository.repositoryId, displayName: repository.displayName,
      mode: 'workspace', status: state.busy ? 'running' : state.failed ? 'failed' : state.ready ? 'completed' : 'interrupted',
      stage: state.ready ? 'complete' : stage, createdAt: observedAt, updatedAt: observedAt, durationUnknown: true,
      message: state.text, indexReady: Boolean(repository.activeRevision), modelReady: state.ready && repository.projects.length > 0,
      events: [{ at: observedAt, stage, message: state.text }] };
  });
  if (!history.length && !effectiveTasks.length) return null;
  const visibleIds = new Set(history.map(repository => repository.repositoryId));
  const activeTasks = effectiveTasks.filter(task => visibleIds.has(task.repositoryId ?? ''));
  const states = history.map(repository => {
    const task = activeTasks.find(task => task.repositoryId === repository.repositoryId);
    return task && tasks?.length ? { text: task.message, busy: task.status === 'running', failed: task.status === 'failed', ready: task.status === 'completed' }
      : historyImportState(repository);
  });
  function retry(repository?: Repository) { if (repository && !locked) onRetry(repository); }
  const ready = states.filter(state => state.ready).length, failed = states.filter(state => state.failed).length;
  const caption = `参考工程 ${ready}/${history.length} 个完成${failed ? ` · ${failed} 个需重试` : ''}`;
  return <ImportTaskPanel kind="history" tasks={effectiveTasks} locked={locked} error={error} caption={caption}
    canRetry={task => visibleIds.has(task.repositoryId ?? '')}
    repositoryId={selectedRepositoryId} onAction={(id, action) => {
      if (action === 'retry') retry(history.find(repository => repository.repositoryId === effectiveTasks.find(task => task.id === id)?.repositoryId));
    }}>
    {history.length ? <ul className="history-import-repositories" aria-label="参考工程导入队列">{history.map((repository, index) => <li key={repository.repositoryId} className={states[index]!.failed ? 'is-error' : ''}>
      <button type="button" className="text-button" aria-pressed={selectedRepositoryId === repository.repositoryId} onClick={() => setSelectedRepositoryId(repository.repositoryId)}><strong>{repository.displayName}</strong></button>
      <span>{states[index]!.text}</span>
      {!states[index]!.busy && !states[index]!.ready ? <button type="button" className="text-button" disabled={locked} onClick={() => retry(repository)}>{states[index]!.failed ? '重试' : '开始解析'}</button> : null}
    </li>)}</ul> : null}
  </ImportTaskPanel>;
}
