import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowRight, Check, CheckCircle2, ChevronDown, FileText, FolderOpen, History, Play, ShieldCheck, Sparkles, Terminal, Upload } from 'lucide-react';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { canApplyAdaptation, type WorkflowEvent, type WorkflowState } from '@forexplore/workflow-core';
import type { TranslationProvider } from '../workspace-translation-provider';
import { CandidatesStage } from './CandidatesStage';
import { PatchStage } from './PatchStage';
import { WorkspaceTranslation } from './WorkspaceTranslation';

type Phase = 'idle' | 'searching' | 'selecting' | 'review' | 'preparing' | 'executing' | 'finished' | 'failed';
type LogLine = { at: string; phase: string; message: string };
const activeStatuses = new Set(['analyzing', 'translating', 'compiling', 'testing', 'rolling-back']);
const runLabels: Record<WorkspaceTranslationRun['status'], string> = {
  analyzing: '正在制定适配计划', translating: '正在生成目标代码', compiling: '正在编译检查', testing: '正在执行行为测试',
  completed: '执行完成，请审阅输出', failed: '执行失败，可查看原因后继续或回滚', cancelled: '运行已取消', interrupted: '运行已中断',
  'rolling-back': '正在回滚修改', 'rolled-back': '修改已回滚',
};
const eventPhaseLabels: Record<WorkspaceTranslationRun['status'], string> = {
  analyzing: '分析', translating: '生成', compiling: '编译', testing: '测试', completed: '完成', failed: '错误',
  cancelled: '取消', interrupted: '中断', 'rolling-back': '回滚', 'rolled-back': '已回滚',
};

interface Props {
  state: WorkflowState;
  dispatch: React.Dispatch<WorkflowEvent>;
  historyPaths: string[];
  targetName: string;
  importing: boolean;
  importMessage?: string;
  error: string | null;
  adaptationProvider: string;
  moduleScopeId?: string;
  translation: TranslationProvider;
  onImportHistory(): void;
  onImportTarget(): void;
  onStart(requirement: string): void;
  onSelectCandidate(id: string): void;
  onAdapt(): void;
  onApply(): void;
  onOpenTarget(): void;
  onActivityChange(active: boolean): void;
}

export function PipelineWorkbench(props: Props) {
  const { state, dispatch } = props;
  const [mode, setMode] = useState<'automatic' | 'assisted'>('automatic');
  const [document, setDocument] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [run, setRun] = useState<WorkspaceTranslationRun>();
  const [following, setFollowing] = useState(true);
  const [setupOpen, setSetupOpen] = useState(true);
  const [executionStarted, setExecutionStarted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0), documentReading = useRef(false);
  const executionPanel = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetId = useRef(state.target?.id);
  const lastError = useRef('');
  const lastRunStatus = useRef('');
  useEffect(() => { if (props.importMessage) log(props.importMessage, '导入'); }, [props.importMessage]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function move(next: Phase) { phaseRef.current = next; setPhase(next); }
  function log(message: string, step = '系统') {
    setLines(current => [...current, { at: new Date().toISOString(), phase: step, message }]);
  }
  const inSession = !['idle', 'finished', 'failed'].includes(phase);
  const activeRun = Boolean(run && activeStatuses.has(run.status));
  const locked = inSession || activeRun;
  useEffect(() => { props.onActivityChange(locked); }, [locked, props.onActivityChange]);
  useEffect(() => {
    if (targetId.current === state.target?.id) return;
    targetId.current = state.target?.id;
    move('idle'); setRun(undefined); setLines([]); setExecutionStarted(false); setSetupOpen(true);
    lastRunStatus.current = ''; lastError.current = '';
  }, [state.target?.id]);
  useEffect(() => {
    const message = props.error || state.error;
    if (!message) lastError.current = '';
    if (message && phaseRef.current !== 'idle' && message !== lastError.current) {
      lastError.current = message; log(message, '错误'); move('failed'); setSetupOpen(true);
    }
  }, [props.error, state.error]);

  // Advance only after the reducer has accepted the previous host reply.
  // In automatic mode the initial Start explicitly authorizes ranked selection.
  useEffect(() => {
    if (props.error || state.error) return;
    if (phaseRef.current === 'searching' && state.stage === 'candidates' && !state.pending) {
      log(`检索完成，找到 ${state.candidates.length} 个候选实现。`, '检索');
      if (mode === 'assisted') { move('review'); log('等待你确认候选实现和额外约束。', '待确认'); return; }
      if (state.candidates[0]) {
        move('selecting');
        log(`自动选择排名首位的候选：${state.candidates[0].title}。`, '检索');
        props.onSelectCandidate(state.candidates[0].id);
      } else if (state.target?.kind === 'module') {
        move('preparing'); log('未找到候选，将依据需求和目标上下文直接生成模块。', '生成'); props.onAdapt();
      } else {
        move('failed'); log('没有可复用实现。请修改需求后重试，或选择模块目标直接生成。', '错误');
      }
    } else if (phaseRef.current === 'selecting' && state.selectedCandidateId === state.candidates[0]?.id) {
      move('preparing'); log('正在组织目标上下文并准备代码生成。', '生成'); props.onAdapt();
    } else if (phaseRef.current === 'preparing' && props.moduleScopeId) {
      move('executing'); log(mode === 'automatic' ? '作用域已就绪，开始生成并验证目标代码。' : '作用域已就绪，请确认允许修改的文件后开始生成。', '生成');
    } else if (phaseRef.current === 'preparing' && state.adaptation) {
      if (mode === 'automatic' && canApplyAdaptation(state.adaptation)) {
        move('executing'); log('验证已通过，正在请求宿主确认回填补丁。', '验证'); props.onApply();
      } else { move('review'); log('补丁已生成，请审阅验证记录与文件差异。', '待确认'); }
    }
    if (state.applyResult && phaseRef.current !== 'finished') { move('finished'); log('补丁回填完成，可在输出区查看检查点。', '完成'); }
  }, [state, props.moduleScopeId, props.error, mode]);

  const events = [...lines, ...(run?.events ?? []).map(event => ({ ...event, phase: eventPhaseLabels[event.phase] }))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  useEffect(() => {
    if (['searching', 'review', 'finished'].includes(phase)) executionPanel.current?.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
  }, [phase]);
  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lines.length, run?.events?.length, following]);

  function onRunChange(next?: WorkspaceTranslationRun) {
    setRun(next);
    if (next && activeStatuses.has(next.status)) move('executing');
    if (!next || next.status === lastRunStatus.current) return;
    lastRunStatus.current = next.status;
    log(runLabels[next.status], activeStatuses.has(next.status) ? '执行' : '结果');
    if (next.error) log(next.error, '错误');
    if (!activeStatuses.has(next.status)) move(next.status === 'completed' || next.status === 'rolled-back' ? 'finished' : 'failed');
  }

  async function importDocument(file?: File) {
    if (!file || locked || documentReading.current) return;
    setFileError('');
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setFileError('请选择 TXT 或 Markdown 文档；其他格式可复制正文到输入框。'); return; }
    if (file.size > 256 * 1024) { setFileError('文档过大，请精简至 8000 字以内后导入。'); return; }
    documentReading.current = true; setReadingFile(true);
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      if (!alive.current) return;
      if (text.length > 8000) { setFileError(`文档共 ${text.length} 字，超过 8000 字上限，请精简后重试。`); return; }
      if (!text.trim()) { setFileError('文档内容为空，请选择其他文档。'); return; }
      setDocument(text); setFileName(file.name);
    } catch { if (alive.current) setFileError('文档读取失败，请重试或直接粘贴正文。'); }
    finally { documentReading.current = false; if (alive.current) setReadingFile(false); }
  }

  const containsFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  function dropDocument(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event) && !event.dataTransfer.files.length) return;
    event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false);
    if (locked || documentReading.current) return;
    if (event.dataTransfer.files.length !== 1) { setFileError('请每次拖入一个 TXT 或 Markdown 文档，已保留原有正文。'); return; }
    void importDocument(event.dataTransfer.files[0]);
  }

  function start() {
    if (locked || readingFile || props.importing || !state.target || !document.trim()) return;
    setRun(undefined); setLines([]); setFollowing(true); lastError.current = ''; lastRunStatus.current = '';
    setExecutionStarted(true); setSetupOpen(false); setFileError('');
    move('searching'); log(`已启动${mode === 'automatic' ? '全自动' : '半自动'}流水线：${state.target.name}。`);
    log('正在根据需求文档检索历史仓中的可复用实现。', '检索');
    props.onStart(document.trim());
  }
  const currentStep = phase === 'idle' ? -1 : phase === 'searching' || phase === 'selecting' || (phase === 'review' && !state.adaptation) ? 1
    : run?.status === 'compiling' || run?.status === 'testing' ? 3 : phase === 'finished' ? 4 : 2;
  const status = phase === 'idle' ? '等待输入' : phase === 'failed' ? '需要处理' : phase === 'finished' ? '执行结束'
    : phase === 'review' || (mode === 'assisted' && props.moduleScopeId && !run) ? '等待确认' : run ? runLabels[run.status] : '系统执行中';

  const targetName = state.target?.name || props.targetName;
  const nextAction = !state.target ? '请在工程资源中选择待实现模块' : !document.trim() ? '填写需求后即可开始' : '准备就绪，可以开始执行';
  const showExecution = executionStarted;
  const waiting = phase === 'review' || (mode === 'assisted' && props.moduleScopeId && !run);
  const successful = run?.status === 'completed' || Boolean(state.applyResult);
  const steps = ['输入与建模', '检索与候选选择', '翻译与集成修复', '编译与验证', '输出结果'];
  return <main className={`pipeline-workbench project-workbench module-workbench${locked ? ' is-running' : ''}`}
    onDragOver={event => { if (containsFiles(event)) event.preventDefault(); }}
    onDrop={event => { if (containsFiles(event)) event.preventDefault(); }}>
        <section className={`project-setup${setupOpen ? ' is-open' : ''}`} aria-label="单模块任务配置">
          <button type="button" className="project-section-toggle" aria-expanded={setupOpen} aria-controls="module-task-inputs" onClick={() => setSetupOpen(value => !value)}>
            <span><span className="project-section-number">01</span><strong>{executionStarted ? '本次需求与输入材料' : '准备任务'}</strong></span>
            <span>{executionStarted ? locked ? '查看配置' : '编辑并重新运行' : '导入 · 描述 · 开始'}<ChevronDown size={15} /></span>
          </button>
          <div id="module-task-inputs" hidden={!setupOpen}>
            <div className="project-setup-body">
              <section className="pipeline-inputs" aria-label="流水线输入">
                <button type="button" className={`pipeline-source${state.target ? ' is-ready' : ''}`} disabled={locked || props.importing} onClick={props.onImportTarget}>
                  <span className="pipeline-source-icon is-target"><FolderOpen size={20} /></span><span><small>目标模块 · 必填</small><strong>导入目标代码</strong><span title={targetName}>{targetName || '导入后从工程资源选择模块'}</span></span>{state.target ? <CheckCircle2 size={16} /> : <Upload size={15} />}</button>
                <button type="button" className={`pipeline-source${props.historyPaths.length ? ' is-ready' : ''}`} disabled={locked || props.importing} onClick={props.onImportHistory}>
                  <span className="pipeline-source-icon"><History size={20} /></span><span><small>历史参考 · 可选</small><strong>导入历史仓</strong><span>{props.historyPaths.length ? `已配置 ${props.historyPaths.length} 个历史仓` : '复用已有实现和经验'}</span></span>{props.historyPaths.length ? <CheckCircle2 size={16} /> : <Upload size={15} />}</button>
              </section>
              {props.importMessage ? <p className="pipeline-import-feedback" role="status">{props.importing ? <span className="spinner" /> : null}{props.importMessage}</p> : null}
              <section className={`pipeline-document${dragging ? ' is-dragging' : ''}`} aria-labelledby="requirement-document-title" aria-busy={readingFile}
                onDragEnter={event => {
                  if (!containsFiles(event)) return;
                  event.preventDefault();
                  if (!locked && !documentReading.current) { dragDepth.current += 1; setDragging(true); }
                }}
                onDragOver={event => {
                  if (!containsFiles(event)) return;
                  event.preventDefault(); event.dataTransfer.dropEffect = locked || documentReading.current ? 'none' : 'copy';
                }}
                onDragLeave={event => {
                  if (!containsFiles(event)) return;
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (!dragDepth.current) setDragging(false);
                }} onDrop={dropDocument}>
                <header><div><FileText size={17} /><h2 id="requirement-document-title">你希望实现什么？</h2></div>
                  <button type="button" className="text-button" disabled={locked || readingFile} onClick={() => fileInput.current?.click()}><Upload size={13} />导入文档</button>
                  <input hidden ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" aria-label="导入需求文档" onChange={event => { void importDocument(event.target.files?.[0]); event.target.value = ''; }} /></header>
                <label htmlFor="pipeline-requirement" className="sr-only">需求文档正文</label>
                <textarea id="pipeline-requirement" rows={9} value={document} maxLength={8000} disabled={locked || readingFile} onChange={event => { setDocument(event.target.value); setFileName(''); setFileError(''); }}
                  placeholder={'描述业务目标、功能需求和验收标准，也可将需求文档拖到这里。\n\n例如：为订单服务增加多租户隔离。\n• 所有查询按租户过滤，禁止跨租户访问\n• 接口返回明确的权限错误\n• 验收覆盖正常访问、越权和空租户场景'} />
                <footer><span>{readingFile ? '正在读取文档…' : fileName || '拖拽或点击导入 TXT / Markdown，最多 8000 字'}</span><span>{document.length.toLocaleString()} / 8000</span></footer>
                {dragging ? <div className="project-document-drop-overlay"><Upload size={28} /><strong>松开导入需求文档</strong><span>支持 TXT / Markdown</span></div> : null}
              </section>
              {fileError ? <p role="alert" className="pipeline-file-error">{fileError}</p> : null}
              <section className="project-mode-section" aria-label="执行配置"><div className="project-field-heading"><strong>执行方式</strong><span>选择系统何时等待你的确认</span></div>
                <div className="pipeline-modes" role="group" aria-label="执行方式">
                  <button type="button" disabled={locked} aria-pressed={mode === 'automatic'} onClick={() => setMode('automatic')}><Sparkles size={17} /><span><strong>全自动流水线</strong><small>自动生成、修复与验收</small></span><span className="project-mode-radio">{mode === 'automatic' ? <Check size={10} /> : null}</span></button>
                  <button type="button" disabled={locked} aria-pressed={mode === 'assisted'} onClick={() => setMode('assisted')}><ShieldCheck size={17} /><span><strong>半自动流水线</strong><small>关键节点由你确认</small></span><span className="project-mode-radio">{mode === 'assisted' ? <Check size={10} /> : null}</span></button>
                </div><p className="project-mode-description">{mode === 'automatic' ? '系统自动选择候选、生成目标代码并执行验证。' : '在候选选择与代码生成前暂停，确认后继续。'}</p>
              </section>
            </div>
            <div className="project-launch-bar"><div><strong>{locked ? '任务进行中' : nextAction}</strong><span>直接写入所选模块，支持差异审阅与回滚</span></div>
              <button type="button" className="primary-action pipeline-start" disabled={locked || readingFile || props.importing || !state.target || !document.trim()} onClick={start}>
                {locked ? <span className="spinner" /> : <Play size={16} />}{locked ? '任务进行中' : executionStarted ? '重新开始' : '开始执行'}<ArrowRight size={16} /></button>
            </div>
          </div>
        </section>

    {showExecution ? <section ref={executionPanel} className={`project-execution-panel${waiting ? ' is-review' : ''}${successful ? ' is-complete' : ''}`} aria-label="任务执行信息">
      <header className="project-execution-heading"><div><span className="project-section-number">02</span><h2>任务执行</h2>
        <span className={`pipeline-status ${waiting ? 'is-review' : successful ? 'is-finished' : phase === 'failed' ? 'is-failed' : locked ? 'is-executing' : ''}`} role="status"><i />{status}</span></div>
        {!locked ? <button type="button" className="text-button" onClick={() => setSetupOpen(true)}>调整需求</button> : null}
      </header>
      <div className="project-execution-summary"><span><small>目标模块</small><strong>{state.target?.name || '尚未选择'}</strong></span>
        <span><small>执行方式</small><strong>{mode === 'automatic' ? '全自动流水线' : '半自动流水线'}</strong></span>
        <span><small>修改文件</small><strong>{run ? run.changes.length : '待生成'}</strong></span></div>
      <ol className="pipeline-flow" aria-label="流水线进度">{steps.map((label, index) => {
        const done = successful || index < currentStep;
        return <li key={label} className={done ? 'is-done' : index === currentStep ? `is-current${phase === 'failed' ? ' is-stopped' : ''}` : ''}
          aria-current={!done && index === currentStep ? 'step' : undefined}>
          <span>{done ? <Check size={12} /> : index + 1}</span><strong>{label}</strong></li>;
      })}</ol>
      <div className="project-execution-content">
    {(phase === 'review' || phase === 'failed') && state.stage === 'candidates' && !props.moduleScopeId ? <section className="pipeline-review" aria-label="人工确认">
      <button type="button" className="secondary-action" onClick={() => { move('idle'); setSetupOpen(true); log('已返回需求输入，可修改文档后重新开始。', '交互'); }}>修改需求</button>
      <CandidatesStage state={state} dispatch={dispatch} adaptationProvider={props.adaptationProvider} onSelectCandidate={props.onSelectCandidate}
        onAdapt={() => { move('preparing'); log('已确认候选，正在准备生成。', '确认'); props.onAdapt(); }} /></section> : null}
    {props.moduleScopeId ? <div className="pipeline-output"><WorkspaceTranslation key={props.moduleScopeId} provider={props.translation} compact
      moduleScopeId={props.moduleScopeId} autoStart={mode === 'automatic'} onRunChange={onRunChange}
      onFeedback={message => { log(message, '错误'); move('failed'); }} onFinished={completed => dispatch({ type: 'MODULE_TRANSLATION_FINISHED', completed })} /></div> : null}
    {state.adaptation ? <div className="pipeline-output"><PatchStage state={state} onApply={props.onApply}
      onBack={() => { move('review'); dispatch({ type: 'RETURN_TO_CANDIDATES' }); }} onOpenTarget={props.onOpenTarget} /></div> : null}

    <section className="pipeline-log" aria-label="实时工作日志"><header><div><Terminal size={15} /><h3>实时日志</h3><small>{events.length}</small></div>
      <button type="button" className="text-button" aria-pressed={following} onClick={() => setFollowing(value => !value)}><ArrowDown size={12} />{following ? '自动跟随' : '跟随最新'}</button></header>
      <div ref={viewport} className="pipeline-log-viewport" role="log" aria-live="polite" aria-relevant="additions text" tabIndex={0}
        onScroll={event => { const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 32); }}>
        {events.length ? events.map((line, index) => <div className={`pipeline-log-line ${line.phase === '错误' ? 'is-error' : ''}`} key={`${line.at}:${index}`}>
          <time>{new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className="pipeline-log-tag">{line.phase}</span><span>{line.message}</span></div>)
          : <div className="pipeline-log-empty"><Terminal size={22} /><span>正在等待系统进度反馈…</span></div>}
      </div></section>


      </div>
    </section> : null}
  </main>;
}
