import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, Check, CheckCircle2, ChevronDown, FileText, FolderOpen, History, Play, ShieldCheck, Terminal, Upload } from 'lucide-react';
import { type ProjectPipelineRun, type ProjectPipelineStart } from '../../../src/project-pipeline-types';
import type { MessageBus } from '../vscode-api';
import type { RequirementDraft } from '../requirement-draft';

const stages = ['入库与建模', '模块检索', '分析与计划', '翻译与集成修复', '联合验收', '输出项目与报告'];
const stageDescriptions = ['解析项目结构与模块依赖', '匹配历史实现与可复用资产', '确定改动范围和实施步骤', '生成代码并修复集成问题', '编译项目并运行已配置的验收', '保存输出项目和验收记录'];
const stageOrder = { modeling: 0, retrieving: 1, analyzing: 2, generating: 3, verifying: 4, publishing: 5, complete: 5 };
export function ProjectPipelineWorkbench({ bus, run, scope, projectName, historyPaths, importing, importMessage, error, topK, draft, onDraftChange,
  onImportHistory, onImportTarget, onActivityChange, onStart }: {
  bus: MessageBus; run?: ProjectPipelineRun; scope?: { repositoryId: string; projectId: string }; projectName: string;
  historyPaths: string[]; importing: boolean; importMessage?: string; error: string | null; topK: number;
  draft: RequirementDraft; onDraftChange(draft: RequirementDraft): void;
  onImportHistory(): void; onImportTarget(): void; onActivityChange(active: boolean): void; onStart(input: ProjectPipelineStart): void;
}) {
  const { text: requirement, fileName: documentName } = draft;
  const [starting, setStarting] = useState(false), [reading, setReading] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [following, setFollowing] = useState(true);
  const [setupOpen, setSetupOpen] = useState(!run);
  const [executionRequested, setExecutionRequested] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0), documentReading = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null), viewport = useRef<HTMLDivElement>(null);
  const executionPanel = useRef<HTMLElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = starting || Boolean(run && run.status === 'running');
  useEffect(() => { onActivityChange(active); }, [active, onActivityChange]);
  useEffect(() => {
    if (run || error) setStarting(false);
    if (error && starting) setSetupOpen(true);
  }, [run, error]);
  useEffect(() => {
    if (run && !requirement) { onDraftChange({ text: run.requirement, fileName: '' }); }
    if (run) setSetupOpen(false);
  }, [run?.id]);
  useEffect(() => { if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [run?.events.length, following]);
  useEffect(() => {
    if (run?.status === 'completed') executionPanel.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }, [run?.status]);
  useEffect(() => {
    if (!starting) return;
    executionPanel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    const timer = setTimeout(() => { setStarting(false); setSetupOpen(true); setDocumentError('宿主尚未确认启动，请先刷新运行状态，避免重复启动。'); }, 65_000);
    return () => clearTimeout(timer);
  }, [starting]);
  const action = (action: 'read' | 'cancel' | 'open-output' | 'open-report' | 'export-report') => { if (run) bus.post({ type: 'PROJECT_PIPELINE_ACTION', runId: run.id, action }); };
  function resume(moduleId?: string) {
    if (!run || active || importing) return;
    setStarting(true); setFollowing(true); setDocumentError('');
    bus.post(moduleId ? { type: 'PROJECT_PIPELINE_ACTION', runId: run.id, action: 'retry-module', moduleId }
      : { type: 'PROJECT_PIPELINE_ACTION', runId: run.id, action: 'resume' });
  }
  async function importFile(file?: File) {
    if (!file || active || documentReading.current) return;
    setDocumentError('');
    if (!/\.(txt|md|markdown)$/i.test(file.name) || file.size > 256 * 1024) { setDocumentError('请选择不超过 8000 字的 UTF-8 TXT 或 Markdown 文档。'); return; }
    documentReading.current = true; setReading(true);
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      if (!alive.current) return;
      if (!text.trim() || text.length > 8000) { setDocumentError('文档为空或超过 8000 字上限，已保留原有正文。'); return; }
      onDraftChange({ text, fileName: file.name });
    } catch { if (alive.current) setDocumentError('文档读取失败，请直接粘贴正文或重试。'); }
    finally { documentReading.current = false; if (alive.current) setReading(false); }
  }
  const containsFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  function dropDocument(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event) && !event.dataTransfer.files.length) return;
    event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false);
    if (active || documentReading.current) return;
    if (event.dataTransfer.files.length !== 1) { setDocumentError('请每次拖入一个 TXT 或 Markdown 文档，已保留原有正文。'); return; }
    void importFile(event.dataTransfer.files[0]);
  }
  const completed = run?.status === 'completed';
  const stopped = run && ['failed', 'cancelled', 'interrupted'].includes(run.status);
  const resumable = stopped && Boolean(run.outputRoot && run.baselineCommit && run.modules.length);
  const canRetry = (id: string) => resumable && (run?.modules.some(module => module.id === id && ['failed', 'running'].includes(module.status))
    || run?.validation?.modules?.some(module => module.id === id && module.verification.disposition === 'production-defect'));
  const doneModules = run?.modules.filter(module => module.status === 'completed').length ?? 0;
  const currentModule = run?.modules.find(module => module.id === run.currentModuleId);
  const status = starting ? '正在启动' : !run ? error ? '启动失败' : '等待宿主确认' : run.status === 'completed' ? '执行完成'
    : run.status === 'running' ? stages[stageOrder[run.stage]] : { failed: '执行失败', cancelled: '已取消', interrupted: '执行已中断' }[run.status];
  const nextAction = !scope ? '请先导入目标代码' : !requirement.trim() ? '填写需求后即可开始' : '准备就绪，可以开始执行';
  const hasOutput = Boolean(run?.validation || run?.reportAvailable);
  const stageDone = (index: number) => Boolean(run && (completed || index < stageOrder[run.stage]));
  const stageState = (index: number) => stageDone(index) ? '已完成' : run && index === stageOrder[run.stage] ? stopped ? '已停止' : '进行中' : '待执行';
  const showExecution = executionRequested || Boolean(run);
  return <main className={`pipeline-workbench project-workbench${active ? ' is-running' : ''}`}
    onDragOver={event => { if (containsFiles(event)) event.preventDefault(); }}
    onDrop={event => { if (containsFiles(event)) event.preventDefault(); }}>
        <section className={`project-setup${setupOpen ? ' is-open' : ''}`} aria-label="项目任务配置">
          <button type="button" className="project-section-toggle" aria-expanded={setupOpen} aria-controls="project-task-inputs" onClick={() => setSetupOpen(value => !value)}>
            <span><span className="project-section-number">01</span><strong>{run ? '本次需求与输入材料' : '准备任务'}</strong></span>
            <span>{run ? active ? '查看配置' : '编辑并重新运行' : '导入 · 描述 · 开始'}<ChevronDown size={15} /></span>
          </button>
          <div id="project-task-inputs" hidden={!setupOpen}>
            <div className="project-setup-body">
              <section className="pipeline-inputs" aria-label="流水线输入">
                <button type="button" className={`pipeline-source${projectName ? ' is-ready' : ''}`} disabled={active || importing} onClick={onImportTarget}>
                  <span className="pipeline-source-icon is-target"><FolderOpen size={20} /></span><span><small>目标项目 · 必填</small><strong>导入目标代码</strong><span title={projectName}>{projectName || '选择待实现的代码工程'}</span></span>{projectName ? <CheckCircle2 size={16} /> : <Upload size={15} />}</button>
                <button type="button" className={`pipeline-source${historyPaths.length ? ' is-ready' : ''}`} disabled={active || importing} onClick={onImportHistory}>
                  <span className="pipeline-source-icon"><History size={20} /></span><span><small>历史参考 · 可选</small><strong>导入历史仓</strong><span>{historyPaths.length ? `已配置 ${historyPaths.length} 个历史仓` : '复用已有实现和经验'}</span></span>{historyPaths.length ? <CheckCircle2 size={16} /> : <Upload size={15} />}</button>
              </section>
              {importMessage ? <p className="pipeline-import-feedback" role="status">{importing ? <span className="spinner" /> : null}{importMessage}</p> : null}
              <section className={`pipeline-document${dragging ? ' is-dragging' : ''}`} aria-labelledby="project-document-title" aria-busy={reading}
                onDragEnter={event => {
                  if (!containsFiles(event)) return;
                  event.preventDefault();
                  if (!active && !documentReading.current) { dragDepth.current += 1; setDragging(true); }
                }}
                onDragOver={event => {
                  if (!containsFiles(event)) return;
                  event.preventDefault(); event.dataTransfer.dropEffect = active || documentReading.current ? 'none' : 'copy';
                }}
                onDragLeave={event => {
                  if (!containsFiles(event)) return;
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (!dragDepth.current) setDragging(false);
                }} onDrop={dropDocument}>
                <header><div><FileText size={17} /><h2 id="project-document-title">你希望实现什么？</h2></div>
                  <button type="button" className="text-button" disabled={active || reading} onClick={() => fileInput.current?.click()}><Upload size={13} />导入文档</button>
                  <input hidden ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" aria-label="导入项目需求文档" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></header>
                <label htmlFor="project-requirement" className="sr-only">项目需求文档正文</label>
                <textarea id="project-requirement" rows={9} value={requirement} maxLength={8000} disabled={active || reading} onChange={event => { onDraftChange({ text: event.target.value, fileName: '' }); setDocumentError(''); }}
                  placeholder={'描述业务目标、功能需求和验收标准，也可将需求文档拖到这里。\n\n例如：为订单服务增加多租户隔离。\n• 所有查询按租户过滤，禁止跨租户访问\n• 接口返回明确的权限错误\n• 验收覆盖正常访问、越权和空租户场景'} />
                <footer><span>{reading ? '正在读取文档…' : documentName || '拖拽或点击导入 TXT / Markdown，最多 8000 字'}</span><span>{requirement.length.toLocaleString()} / 8000</span></footer>
                {dragging ? <div className="project-document-drop-overlay"><Upload size={28} /><strong>松开导入需求文档</strong><span>支持 TXT / Markdown</span></div> : null}
              </section>
              {documentError ? <p role="alert" className="pipeline-file-error">{documentError}</p> : null}
            </div>
            <div className="project-launch-bar"><div><strong>{active ? '任务进行中' : nextAction}</strong><span>生成代码将保存到独立输出项目</span></div>
              <button type="button" className="primary-action pipeline-start" disabled={active || importing || reading || !scope || !requirement.trim()} onClick={() => {
                if (!scope || active) return; setExecutionRequested(true); setStarting(true); setSetupOpen(false); setFollowing(true); setDocumentError('');
                onStart({ ...scope, requirement: requirement.trim(), topK });
              }}>{active ? <span className="spinner" /> : <Play size={16} />}{active ? '任务进行中' : run ? '重新开始项目任务' : '开始执行'}{!active ? <ArrowRight size={16} /> : null}</button>
            </div>
          </div>
        </section>
    {showExecution ? <section ref={executionPanel} className={`project-execution-panel${completed ? ' is-complete' : ''}`} aria-label="任务执行信息">
      <header className="project-execution-heading"><div><span className="project-section-number">02</span><h2>任务执行</h2>
        <span className={`pipeline-status ${completed ? 'is-finished' : stopped || (!run && error) ? 'is-failed' : active ? 'is-executing' : ''}`} role="status"><i />{status}</span></div>
        <div className="project-execution-actions"><button type="button" className="text-button" disabled={!run} onClick={() => action('read')}>刷新状态</button>
          {active && run ? <button type="button" className="text-button project-cancel" onClick={() => action('cancel')}>取消项目运行</button> : null}</div>
      </header>
      <div className="project-execution-summary"><span><small>目标项目</small><strong>{run?.projectName || projectName}</strong></span>
        <span><small>当前模块</small><strong>{currentModule?.name || (completed ? '全部完成' : '项目级处理')}</strong></span>
        <span><small>模块完成</small><strong>{run?.modules.length ? `${doneModules} / ${run.modules.length}` : '待建模'}</strong></span></div>
      <ol className="pipeline-flow" aria-label="项目流水线进度">{stages.map((label, index) => <li key={label} title={stageDescriptions[index]} aria-label={`${label}：${stageState(index)}`}
        aria-current={run && !completed && index === stageOrder[run.stage] ? 'step' : undefined}
        className={stageDone(index) ? 'is-done' : run && index === stageOrder[run.stage] ? `is-current${stopped ? ' is-stopped' : ''}` : ''}>
        <span>{stageDone(index) ? <Check size={12} /> : index + 1}</span><strong>{label}</strong></li>)}</ol>
      <div className="project-execution-content">
        {stopped ? <section className={`project-attention${run.status === 'failed' ? ' is-error' : ''}`} aria-label="运行中断提示">
          <strong>{status}</strong><p>{run.error || '本次任务已停止。可从断点继续，或查看日志和报告。'}</p>
          {resumable ? <><p>按原需求继续，保留已完成模块；未完成模块重新执行，最后重新验收整个项目。</p>
            <button type="button" className="primary-action" disabled={active || importing} onClick={() => resume()}><Play size={14} />继续任务</button></> : null}
          <button type="button" className="secondary-action" onClick={() => setSetupOpen(true)}>调整需求并重新执行<ArrowRight size={14} /></button>
        </section> : null}
        {hasOutput && run ? <section className={`project-pipeline-output${completed ? ' is-complete' : ''}`} aria-label="项目输出与验收报告">
          <div className="project-output-heading"><span className="project-output-icon"><ShieldCheck size={24} /></span>
            <div><span className="pipeline-eyebrow">{completed ? '交付结果' : '当前执行记录'}</span><h2>{completed ? '项目已生成，查看交付结果' : '项目输出与验收报告'}</h2></div></div>
          <p>{run.acceptance === 'behavior-verified' ? '完整项目编译和最终行为验证通过，验证范围与未覆盖项详见报告。' : run.acceptance === 'compilation-only' ? '编译通过，行为验证尚未全部通过，详见各模块记录。' : '执行尚未完成，报告保留当前进度与失败原因。'}</p>
          <div className="project-result-facts"><span>覆盖率：未采集</span></div>
          <div className="project-delivery-actions"><button type="button" className={completed ? 'primary-action' : 'secondary-action'} disabled={!run.outputRoot} onClick={() => action('open-output')}><FolderOpen size={15} />{completed ? '打开输出项目' : '查看执行副本'}</button>
            <button type="button" className="secondary-action" onClick={() => action('open-report')}><FileText size={14} />查看验收报告</button>
            <button type="button" className="text-button" onClick={() => action('export-report')}>导出报告<ArrowRight size={13} /></button></div>
          <details className="project-output-details"><summary>输出位置与提交记录</summary>
            {run.outputRoot ? <p className="project-output-path">输出副本：<code>{run.outputRoot}</code></p> : null}
            {run.commit ? <p>输出提交：<code>{run.commit}</code></p> : null}
            <p>验收报告包含需求追溯、模块证据与工作日志。</p></details>
        </section> : null}
        <section className="pipeline-log" aria-label="实时工作日志"><header><div><Terminal size={15} /><h3>实时日志</h3><small>{run?.events.length ?? 0}</small></div>
          <button type="button" className="text-button" aria-pressed={following} onClick={() => setFollowing(value => !value)}><ArrowDown size={12} />{following ? '自动跟随' : '跟随最新'}</button></header>
          <div className="pipeline-log-viewport" ref={viewport} role="log" aria-live="polite" tabIndex={0} onScroll={event => { const view = event.currentTarget; setFollowing(view.scrollHeight - view.scrollTop - view.clientHeight < 32); }}>
            {run?.events.length ? run.events.slice(-600).map(event => <div className="pipeline-log-line" key={event.id}><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className="pipeline-log-tag">{stages[stageOrder[event.stage]]}</span><span>{event.message}</span></div>)
              : <div className="pipeline-log-empty"><Terminal size={22} /><span>{starting ? '正在启动任务，等待进度反馈…' : '尚无工作日志，可刷新运行状态'}</span></div>}
          </div></section>
        {run?.modules.length ? <details className="project-module-results"><summary><span>模块执行明细</span><span>{doneModules} / {run.modules.length} 已完成</span></summary><div className="project-modules-table"><table><thead><tr><th>模块</th><th>状态</th><th>修改文件</th><th>验证</th></tr></thead><tbody>
          {run.modules.map(module => <tr key={module.id}><td>{module.name}</td><td><span className={`project-module-status is-${module.status}`}>{{ pending: '待执行', running: '执行中', completed: '已完成', failed: '失败' }[module.status]}</span>
            {canRetry(module.id) ? <button type="button" className="text-button" aria-label={`重试模块：${module.name}`} disabled={active || importing} onClick={() => resume(module.id)}>重试此模块</button> : null}
          </td><td>{module.changedFiles?.length ?? 0}</td><td>{moduleVerificationLabel(run, module.id)}</td></tr>)}</tbody></table></div></details> : null}
      </div>
      {run ? <details className="project-run-id"><summary>运行编号</summary><code>{run.id}</code></details> : null}
    </section> : null}
  </main>;
}
function moduleVerificationLabel(run: ProjectPipelineRun, id: string): ReactNode {
  const final = run.validation?.modules?.find(item => item.id === id)?.verification;
  const generated = run.modules.find(item => item.id === id)?.moduleVerification;
  const evidence = final ?? generated;
  if (!evidence) return run.modules.find(item => item.id === id)?.translation?.compilations.at(-1)?.success ? '编译通过' : '尚无通过记录';
  const coverageUnavailable = evidence.result?.reason === 'coverage-unavailable' || evidence.result?.functions.some(item => item.reason === 'coverage-unavailable');
  const label = coverageUnavailable ? '覆盖率无法确认' : { verified: '行为验证通过', 'not-applicable': '声明模块，无可执行函数', 'production-defect': '存在生产代码缺陷', 'test-environment': '验证环境不可用', 'agent-uncertain': '行为结论未确定' }[evidence.disposition];
  const text = final ? label : label + '（生成阶段）';
  const issues = evidence.result?.functions.filter(item => item.coverageIssue).map(item => `${item.target.signature ?? item.target.name}：${item.coverageIssue}`) ?? [];
  if (!issues.length && evidence.result?.issue?.description) issues.push(evidence.result.issue.description);
  return issues.length ? <details className="project-verification-details"><summary>{text}</summary>{issues.map((issue, index) => <p key={index}>{issue}</p>)}</details> : text;
}
