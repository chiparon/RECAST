import type { CodeIntelligenceRepositoryPresentation as Repository } from './ui-types';
import { indexingProgressMessage } from './indexing-progress';

export function currentProjectAnalysis(repository: Repository, project: Repository['projects'][number]) {
  const analysis = project.analysis;
  return analysis?.repositoryId === repository.repositoryId && analysis.analysisRevision === repository.activeRevision && analysis.projectId === project.projectId ? analysis : undefined;
}

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
  const projects = repository.projects.map(project => ({ ...project, analysis: currentProjectAnalysis(repository, project) }));
  const ready = projects.filter(project => project.analysis?.state === 'ready' && project.analysis.projection === 'ready').length;
  const skipped = projects.filter(project => project.analysis?.state === 'ready' && project.analysis.projection === 'ready' && project.analysis.modelingSkippedReason).length;
  const modeled = ready - skipped;
  const skippedLabel = skipped ? ` · ${skipped} 个工程无独立文件，无需建模` : '';
  const failed = projects.filter(project => project.analysis?.state === 'failed' || project.analysis?.projection === 'failed').length;
  const active = projects.some(project => ['queued', 'analyzing', 'validating'].includes(project.analysis?.state ?? '') || project.analysis?.state === 'ready' && project.analysis.projection === 'pending');
  const phase = projects.some(project => project.analysis?.state === 'validating') ? '正在校验模块模型…'
    : projects.some(project => project.analysis?.state === 'analyzing') ? '正在生成模块模型…'
      : projects.some(project => project.analysis?.state === 'ready' && project.analysis.projection === 'pending') ? '正在保存检索信息…' : '等待模块建模…';
  const error = projects.find(project => project.analysis?.error)?.analysis?.error;
  if (failed) return { text: `建模 ${modeled}/${projects.length - skipped} · ${failed} 个失败${error ? `：${error}` : '，可重试'}${skippedLabel}`, busy: active, failed: true, ready: false };
  if (projects.length && ready === projects.length) return { text: `索引${modeled ? '、建模' : ''}完成 · ${modeled} 个子项目已建模${skippedLabel}`, busy: false, failed: false, ready: true };
  if (!projects.length) return { text: '索引完成，未发现可建模子项目，请确认工程目录', busy: false, failed: true, ready: false };
  return { text: `索引完成 · 建模 ${modeled}/${projects.length - skipped}${active ? `，${phase}` : '，待建模'}${skippedLabel}`, busy: active, failed: false, ready: false };
}
