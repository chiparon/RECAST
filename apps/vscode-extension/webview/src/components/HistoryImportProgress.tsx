import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import type { CodeIntelligenceRepositoryPresentation } from '../../../src/ui-types';
import { indexingProgressMessage } from '../../../src/indexing-progress';

type Repository = CodeIntelligenceRepositoryPresentation;

export function historyImportState(repository: Repository): { text: string; busy: boolean; failed: boolean; ready: boolean } {
  const progress = repository.indexing;
  if (progress) return {
    text: progress.stage === 'queued' ? `等待解析（第 ${progress.position}/${progress.count} 个仓库）`
      : `${indexingProgressMessage({ ...progress, stage: progress.stage, repositoryId: repository.repositoryId, displayName: '' }).slice(1)} · 第 ${progress.position}/${progress.count} 个仓库`,
    busy: true, failed: false, ready: false,
  };
  if (repository.analysisStatus === 'indexing') return { text: '上次解析未完成，可重试', busy: false, failed: true, ready: false };
  if (repository.analysisStatus === 'failed') return { text: '索引失败，可重试', busy: false, failed: true, ready: false };
  if (!repository.activeRevision) return { text: '已登记，等待导入解析', busy: false, failed: false, ready: false };
  const projects = repository.projects;
  const ready = projects.filter(project => project.analysis?.state === 'ready' && project.analysis.projection === 'ready').length;
  const skipped = projects.filter(project => project.analysis?.state === 'ready' && project.analysis.projection === 'ready' && project.analysis.modelingSkippedReason).length;
  const modeled = ready - skipped;
  const skippedLabel = skipped ? ` · ${skipped} 个工程无独立文件，无需建模` : '';
  const failed = projects.filter(project => project.analysis?.state === 'failed' || project.analysis?.projection === 'failed').length;
  const active = projects.some(project => ['queued', 'analyzing', 'validating'].includes(project.analysis?.state ?? '') || project.analysis?.state === 'ready' && project.analysis.projection === 'pending');
  const error = projects.find(project => project.analysis?.error)?.analysis?.error;
  if (failed) return { text: `建模 ${modeled}/${projects.length - skipped} · ${failed} 个失败${error ? `：${error}` : '，可重试'}${skippedLabel}`, busy: active, failed: true, ready: false };
  if (projects.length && ready === projects.length) return { text: `索引${modeled ? '、建模' : ''}完成 · ${modeled} 个子项目已建模${skippedLabel}`, busy: false, failed: false, ready: true };
  if (!projects.length) return { text: '索引完成，未发现可建模子项目', busy: false, failed: false, ready: true };
  return { text: `索引完成 · 建模 ${modeled}/${projects.length - skipped}${active ? '，正在处理…' : '，待建模'}${skippedLabel}`, busy: active, failed: false, ready: false };
}

/** Remains visible when settings or the project menu is closed. */
export function HistoryImportProgress({ repositories, onRetry }: { repositories: Repository[]; onRetry(repository: Repository): void }) {
  const history = [...new Map(repositories.filter(repository => repository.role === 'history').map(repository => [repository.repositoryId, repository])).values()];
  if (!history.length) return null;
  const states = history.map(historyImportState);
  const busy = states.some(state => state.busy);
  const failed = states.filter(state => state.failed).length;
  const ready = states.filter(state => state.ready).length;
  const active = history.findIndex((repository, index) => states[index]!.busy && repository.indexing?.stage !== 'queued');
  const current = active >= 0 ? active : states.findIndex(state => state.busy);
  return <details className="history-import-progress" open={busy || failed > 0}>
    <summary aria-live="polite">
      {busy ? <RefreshCw size={13} className="is-spinning" /> : failed ? <AlertTriangle size={13} /> : <Check size={13} />}
      <span>参考工程 {ready}/{history.length} 个完成{failed ? ` · ${failed} 个需重试` : ''}
        {current >= 0 ? ` · ${history[current]!.displayName}：${states[current]!.text}` : ''}</span>
    </summary>
    <ul>{history.map((repository, index) => <li key={repository.repositoryId} className={states[index]!.failed ? 'is-error' : ''}>
      <strong>{repository.displayName}</strong><span>{states[index]!.text}</span>
      {!states[index]!.busy && !states[index]!.ready ? <button type="button" onClick={() => onRetry(repository)}>{states[index]!.failed ? '重试' : '开始解析'}</button> : null}
    </li>)}</ul>
  </details>;
}
