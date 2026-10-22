import { useEffect, useRef, useState } from 'react';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import type { TranslationProvider, TranslationResult } from '../workspace-translation-provider';
import { TranslationProgress } from './TranslationProgress';

const statuses: Record<WorkspaceTranslationRun['status'], string> = { analyzing: '制定计划', translating: '生成代码', compiling: '编译检查', testing: '行为测试',
  completed: '执行完成，待审阅', failed: '执行失败', cancelled: '已取消', interrupted: '执行已中断', 'rolling-back': '正在回滚', 'rolled-back': '已回滚' };
const running = new Set(['analyzing', 'translating', 'compiling', 'testing', 'rolling-back']);

export function WorkspaceTranslation({ provider, moduleScopeId, onFinished, onRunChange, autoStart = false, onFeedback, compact = false }: {
  provider: TranslationProvider; moduleScopeId?: string;
  autoStart?: boolean; onFeedback?: (message: string) => void;
  compact?: boolean;
  onFinished?: (completed: boolean) => void; onRunChange?: (run?: WorkspaceTranslationRun) => void;
}) {
  const [profile, setProfile] = useState<TranslationResult['profile']>();
  const [run, setRun] = useState<WorkspaceTranslationRun>();
  const [resumeId, setResumeId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const runChange = useRef(onRunChange); runChange.current = onRunChange;
  const generation = useRef(0);
  const autoStarted = useRef(false);
  const feedback = useRef(onFeedback); feedback.current = onFeedback;
  useEffect(() => { runChange.current?.(undefined); }, [moduleScopeId]);
  useEffect(() => { let active = true; void provider({ action: 'describe', ...(moduleScopeId ? { moduleScopeId } : {}) }).then(result => {
    if (!active) return;
    if (!result.profile || (moduleScopeId && result.profile.moduleScopeId !== moduleScopeId)) throw new Error('宿主未返回当前模块的生成配置，请重新启动任务。');
    setProfile(result.profile);
  })
    .catch(cause => { if (active) { const message = cause instanceof Error ? cause.message : '读取生成配置失败'; setError(message); feedback.current?.(message); } }); return () => { active = false; generation.current++; }; }, [provider, moduleScopeId]);

  async function action(name: 'start' | 'read' | 'cancel' | 'resume' | 'rollback') {
    const attempt = ++generation.current;
    setBusy(true); setError(''); setReviewed(false);
    try {
      const start = { action: name, profileId: profile?.profileId,
        ...(moduleScopeId ? { moduleScopeId } : {}) };
      const result = await provider(name === 'start' ? start : { action: name, runId: run?.id ?? resumeId.trim() });
      if (!result.run) throw new Error('服务未返回运行记录，请按运行编号读取状态后再继续。');
      if (generation.current === attempt) { setRun(result.run); runChange.current?.(result.run); if (result.run) setResumeId(result.run.id); }
    } catch (cause) { if (generation.current === attempt) { const message = cause instanceof Error ? cause.message : '翻译操作失败'; setError(message); feedback.current?.(message); } }
    finally { if (generation.current === attempt) setBusy(false); }
  }
  useEffect(() => {
    if (!run || !running.has(run.status) || busy || error) return;
    const timer = setTimeout(() => void action('read'), 1500);
    return () => clearTimeout(timer);
  }, [run, busy, error]);
  const finished = useRef(onFinished); finished.current = onFinished;
  useEffect(() => {
    if (run && !running.has(run.status)) finished.current?.(run.status === 'completed');
  }, [run?.status]);

  const moduleScoped = Boolean(profile?.moduleScopeId);
  const canStart = Boolean(profile) && !busy && moduleScoped;
  /** The service is working right now: the page shows the phase animation. */
  const active = Boolean(run && running.has(run.status));
  useEffect(() => {
    if (!autoStart || !canStart || run || autoStarted.current || error) return;
    autoStarted.current = true;
    void action('start');
  }, [autoStart, canStart, run, error]);

  const profileContent = profile ? <><p>{profile.sourceLanguage} → {profile.targetLanguage} · {profile.behavioralVerification ? '已配置行为测试' : '仅编译检查'}{profile.label ? ` · ${profile.label}` : ''}</p>
      <p>写入工作区：<code>{profile.workspaceRoot}</code></p><p>允许修改：{profile.writeFiles.join('、')}</p>
      {profile.warnings?.length ? <ul className="context-gaps">{profile.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{warning}</li>)}</ul> : null}</> : null;
  return <section className={`workspace-translation${compact ? ' is-compact' : ''}`} aria-label="多文件生成与验收">
    {compact ? <h3>代码生成与验收</h3> : <h2>多文件生成与验收</h2>}
    {compact && active ? <details><summary>生成范围与验证配置</summary>{profileContent}</details> : profileContent}
    {moduleScoped && !run ? <p>开始后会直接写入上述文件并执行验证；可查看每个文件的差异并回滚本次修改。</p> : null}
    {!run ? <button type="button" className="primary-action" disabled={!canStart} onClick={() => void action('start')}>{moduleScoped ? '开始模块翻译并回填' : '使用所选证据生成代码'}</button> : null}
    {active ? null : <div className="translation-actions"><label>运行编号<input aria-label="运行编号" value={resumeId} onChange={event => { setResumeId(event.target.value); setRun(undefined); }} disabled={busy || Boolean(run && running.has(run.status))} /></label>
      <button type="button" className="secondary-action" disabled={busy || !resumeId.trim()} onClick={() => void action('read')}>读取运行</button></div>}
    {error ? <p role="alert">{error}{run ? <button type="button" disabled={busy} onClick={() => void action('read')}>重试刷新</button> : null}</p> : null}
    {run ? <>
      {active
        // The workbench owns progress in compact mode; keep cancellation here.
        ? compact ? <div className="translation-compact-controls"><span>模型调用 {run.modelTurns} 次</span><button type="button" className="secondary-action" disabled={busy} onClick={() => void action('cancel')}>取消运行</button></div>
          : <TranslationProgress run={run} onCancel={busy ? undefined : () => void action('cancel')} />
        : <p role="status">{statuses[run.status]} · {run.acceptance === 'behavior-verified' ? '行为测试通过' : '尚无行为验收通过记录'}</p>}
      {run.error ? <p role="alert">{run.error}</p> : null}
      {active ? null : <div className="translation-actions">
        {['failed', 'cancelled', 'interrupted'].includes(run.status) ? <button type="button" disabled={busy} onClick={() => void action('resume')}>继续执行</button> : null}
        {run.status !== 'rolled-back' && run.changes.length ? <button type="button" disabled={busy} onClick={() => void action('rollback')}>回滚本次修改</button> : null}
      </div>}
      {run.plan ? <details open><summary>适配计划</summary><p style={{ whiteSpace: "pre-wrap" }}>{run.plan.markdown ?? run.plan.summary}</p><ol>{run.plan.steps.map(step => <li key={step.id}>{run.completedSteps.includes(step.id) ? '✓ ' : ''}{step.description} · {step.files.join('、')}</li>)}</ol></details> : null}
      {run.changes.map(change => <details key={change.path}><summary>{change.path} · {change.rolledBack ? '已回滚' : change.applied ? '已写入' : '待写入'}</summary>
        <h3>修改前</h3><pre>{change.before ?? '（新文件）'}</pre><h3>修改后</h3><pre>{change.after}</pre></details>)}
      {[...run.compilations.map((check, index) => ({ check, label: `编译 ${index + 1}` })), ...(run.verification?.runs ?? []).map((check, index) => ({ check, label: `行为测试 ${index + 1}` }))]
        .map(({ check, label }) => <details key={label}><summary>{label} · {check.success ? '通过' : '失败'}</summary><pre>{check.output || check.diagnostics.join('\n')}</pre></details>)}
      {run.status === 'completed' ? <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已审阅本次差异与验证记录{reviewed ? '（本页标记）' : ''}</label> : null}
    </> : null}
  </section>;
}

export function AgentRunLog({ run, enabled = true }: { run?: WorkspaceTranslationRun; enabled?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [run?.events?.length]);
  if (!enabled) return null;
  return <section className="agent-run-log" aria-label="Analyzer和Translator运行轨迹">
    <div className="agent-run-log-heading"><strong>Analyzer / Translator 运行轨迹</strong><small>{run?.events?.length ?? 0} 条</small></div>
    <div className="agent-run-log-viewport" ref={viewport} role="log" aria-live="polite">
      {(run?.events ?? []).length ? (run?.events ?? []).map((event, index) => <div className="agent-run-log-line" key={`${event.at}:${index}`}>
        <time>{new Date(event.at).toLocaleTimeString()}</time><span className={`agent-run-log-phase is-${event.phase}`}>{event.phase}</span><span>{event.message}</span>
      </div>) : <div className="agent-run-log-empty">{run ? (['completed', 'failed', 'cancelled', 'interrupted', 'rolled-back'].includes(run.status)
        ? '该运行未记录 Agent 历史轨迹（运行创建于日志功能启用前）' : '等待 Agent 产生运行轨迹…') : '翻译任务尚未启动'}</div>}
    </div>
  </section>;
}
