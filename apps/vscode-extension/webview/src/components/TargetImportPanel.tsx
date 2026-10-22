import { useEffect, useId, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, History, LoaderCircle, X } from 'lucide-react';
import type { TargetImportStage, TargetImportTask } from '../../../src/target-import-task-types';

const phases = ['选择目录', '源码解析', '建立索引', '模块建模', '完成'];
const statuses = { running: '导入中', completed: '导入完成', failed: '导入失败', cancelled: '已取消', interrupted: '已中断' };
function phase(stage: TargetImportStage) {
  if (['queued', 'selecting', 'resolving', 'attaching'].includes(stage)) return 0;
  if (['indexing', 'snapshot', 'snapshot-verify', 'parse', 'assemble', 'recover'].includes(stage)) return 1;
  if (stage === 'modeling') return 3;
  return stage === 'complete' ? 4 : 2;
}
function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function elapsed(task: TargetImportTask, now: number) {
  if (task.durationUnknown) return '历史耗时未记录';
  if (task.elapsedMs !== undefined) return duration(task.elapsedMs + (task.status === 'running' ? now - Date.parse(task.activeStartedAt ?? task.createdAt) : 0));
  return duration((task.endedAt ? Date.parse(task.endedAt) : now) - Date.parse(task.createdAt));
}

/** Outside the main scroll area: inputs, settings and execution mode cannot hide it. */
export function ImportTaskPanel({ tasks, error, locked, onAction, kind = 'target', caption, children, repositoryId, canRetry = () => true }: {
  tasks: TargetImportTask[]; error?: string | null; locked: boolean;
  kind?: 'target' | 'history'; caption?: string; children?: ReactNode; repositoryId?: string;
  canRetry?(task: TargetImportTask): boolean;
  onAction(id: string, action: 'cancel' | 'retry'): void;
}) {
  const label = kind === 'target' ? '目标工程' : '参考工程';
  const id = useId(), historyId = `${id}-history`, detailsId = `${id}-details`;
  const current = (repositoryId ? tasks.find(task => task.repositoryId === repositoryId) : undefined)
    ?? tasks.find(task => task.status === 'running' && task.stage !== 'queued')
    ?? tasks.find(task => task.status === 'running') ?? tasks[0];
  const busy = current?.status === 'running';
  const signature = tasks.map(task => task.id).sort().join(':');
  const [dismissed, setDismissed] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const [historyOpen, setHistoryOpen] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [requestPending, setRequestPending] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy, current?.id]);
  useEffect(() => { setRequestPending(false); }, [tasks, error]);
  const selected = tasks.find(task => task.id === selectedId) ?? current;
  function action(id: string, action: 'cancel' | 'retry') { setRequestPending(true); onAction(id, action); }
  const progress = current?.progress;
  const determinate = progress?.total !== undefined && progress.total > 0;
  const percent = determinate ? Math.min(100, Math.round(progress!.completed / progress!.total! * 100)) : undefined;
  if (dismissed === signature) return <div className="import-task-reopen"><button type="button" className="text-button" aria-label={`显示${label}导入任务`} onClick={() => setDismissed(undefined)}><History size={13} />{caption ?? `${label}导入任务`}{tasks.some(task => task.status === 'running') ? ' · 处理中' : ''}</button></div>;
  return <section className={`target-import-panel${busy ? ' is-running' : ''}${kind === 'history' ? ' history-import-progress' : ''}`} aria-label={`${label}导入任务`}>
    <header><strong>{busy ? <LoaderCircle size={15} className="is-spinning" /> : current?.status === 'failed' || current?.status === 'interrupted' ? <AlertTriangle size={15} /> : <History size={15} />}{caption ?? `${label}导入任务`}</strong>
      <div className="import-task-header-actions"><button type="button" className="text-button" disabled={!tasks.length} aria-expanded={historyOpen} aria-controls={historyId} onClick={() => setHistoryOpen(open => !open)}>查看历史（{tasks.length}）<ChevronDown size={13} /></button>
        <button type="button" className="icon-button" aria-label={`关闭${label}导入任务`} title="关闭面板，后台任务继续运行" onClick={() => setDismissed(signature)}><X size={14} /></button></div></header>
    {children}
    {current ? <>
      <div className="target-import-summary"><strong title={current.directory}>{current.displayName}</strong><span className={`target-import-status is-${current.status}`}>{statuses[current.status]}</span></div>
      {current.directory ? <div className="target-import-directory" title={current.directory}>{current.directory}</div> : null}
      <p className="target-import-message" role={current.status === 'failed' ? 'alert' : 'status'}>{current.message}</p>
      <ol className="target-import-phases" aria-label="导入阶段">{phases.map((label, index) => <li key={label} className={current.status === 'completed' || index < phase(current.stage) ? 'is-done' : index === phase(current.stage) ? 'is-current' : ''}
        aria-current={index === phase(current.stage) ? 'step' : undefined}>{index < phase(current.stage) || current.status === 'completed' ? <CheckCircle2 size={12} /> : <span>{index + 1}</span>}{label}</li>)}</ol>
      {busy ? <div className="target-import-progress-row"><div className={`target-import-progress${determinate ? '' : ' is-indeterminate'}`} role="progressbar" aria-label="当前导入阶段进度"
        aria-valuemin={0} aria-valuemax={100} {...(determinate ? { 'aria-valuenow': percent } : {})}><i style={determinate ? { width: `${percent}%` } : undefined} /></div>
        <span>{progress ? progress.total !== undefined ? `${progress.completed} / ${progress.total} ${progress.unit}` : `已完成 ${progress.completed} ${progress.unit}` : '处理中'}</span></div> : null}
      <div className="target-import-footer"><span><Clock3 size={12} />{current.durationUnknown ? '' : '已用时 '}{elapsed(current, now)}{busy ? ` · 最近更新：${Math.max(0, Math.floor((now - Date.parse(current.updatedAt)) / 1000))} 秒前` : ''}</span>
        <div><button type="button" className="text-button" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => { setSelectedId(current.id); setDetailsOpen(open => !open); }}>过程记录</button>
          {busy && kind === 'target' ? <button type="button" className="text-button" disabled={requestPending} onClick={() => action(current.id, 'cancel')}>{requestPending ? '正在停止…' : current.stage === 'modeling' ? '停止等待' : '取消导入'}</button>
            : !busy && current.status !== 'completed' && canRetry(current) ? <button type="button" className="secondary-action" disabled={locked || requestPending} onClick={() => action(current.id, 'retry')}>重试导入</button> : null}</div></div>
      <div className="target-import-results"><span>索引：{current.indexReady ? '已完成' : '未完成'}</span><span>模块建模：{current.modelReady ? '已完成' : current.stage === 'modeling' && busy ? '进行中' : '未完成'}</span></div>
    </> : <p className="target-import-empty">尚无导入记录，选择目标代码后将在这里展示进度。</p>}
    <div className="target-import-expanded">
      {historyOpen ? <div id={historyId} className="target-import-history" aria-label="导入历史记录">{tasks.map(task => <div key={task.id}>
        <button type="button" aria-pressed={selectedId === task.id} onClick={() => { setSelectedId(task.id); setDetailsOpen(true); }}><strong>{task.displayName}</strong><span>{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })} · {statuses[task.status]} · {elapsed(task, now)}</span></button>
        {!busy && !locked && task.status !== 'completed' && task.status !== 'running' && canRetry(task) && !tasks.some(other => other.repositoryId === task.repositoryId && other.status === 'running') ? <button type="button" className="text-button" disabled={requestPending} onClick={() => action(task.id, 'retry')}>重试</button> : null}</div>)}</div> : null}
      {detailsOpen && selected ? <section id={detailsId} className="target-import-details" aria-label="导入过程记录"><header><strong>{selected.displayName} · 过程记录</strong><button type="button" className="text-button" onClick={() => setDetailsOpen(false)}>收起</button></header>
        <ol role="log" aria-live="polite">{selected.events.map((event, index) => <li key={`${index}:${event.at}`}><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{event.message}</span></li>)}</ol></section> : null}
    </div>
  </section>;
}

export const TargetImportPanel = ImportTaskPanel;
