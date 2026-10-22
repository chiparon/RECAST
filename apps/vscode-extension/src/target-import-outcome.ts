import type { CodeIntelligencePresentation } from './ui-types';

/**
 * The verdict of one explicit target import.
 *
 * A target can only be imported when the workbench can offer something to
 * select. Reporting "completed" for a directory that indexed to zero projects
 * leaves the panel waiting for a choice that does not exist, which is exactly
 * how an import of a copy holding only Maven `target/` output looked.
 */
export type TargetImportVerdict = { status: 'completed' } | { status: 'failed'; message: string };

export function targetImportVerdict(
  presentation: CodeIntelligencePresentation,
  failedRepositoryIds: readonly string[],
): TargetImportVerdict {
  const targets = presentation.repositories.filter((repository) => repository.role === 'target');
  if (targets.length === 0) return { status: 'failed', message: presentation.message ?? '所选目标目录未进入当前工作区的有效配置，索引尚未开始。请重新选择目标工程；重复等待不会开始索引。' };
  const failed = targets.some((repository) => (
    repository.analysisStatus === 'failed' || failedRepositoryIds.includes(repository.repositoryId)
  ));
  // The presentation can report an unrelated history repository failure while
  // this target indexed successfully: only the target lifecycle decides.
  const incomplete = targets.some((repository) => (
    repository.analysisStatus === 'registered' || repository.analysisStatus === 'indexing' || !repository.activeRevision
  ));
  const projectless = targets.find((repository) => (
    (repository.analysisStatus === 'ready' || repository.analysisStatus === 'degraded') &&
    Boolean(repository.activeRevision) && repository.projects.length === 0
  ));
  if (failed) return { status: 'failed', message: '目标工程索引失败，请查看 RECAST 输出日志后重试。' };
  if (projectless) {
    // The two ways a target can end up projectless need different fixes, and the
    // presentation already distinguishes them: a revision with no language files
    // indexed nothing usable (a directory that holds only build output looks
    // exactly like this), while indexed sources without a build file only need a
    // different directory.
    const indexedFiles = projectless.languages.reduce((total, language) => total + language.fileCount, 0);
    return {
      status: 'failed',
      message: indexedFiles === 0
        ? `${projectless.displayName} 里没有可索引的源文件（例如只剩构建产物），请选择工程根目录后重试。`
        : `${projectless.displayName} 里没有可识别的工程（缺少 pom.xml 等构建文件），请选择工程根目录后重试。`,
    };
  }
  if (incomplete) return { status: 'failed', message: presentation.message ?? '目标工程索引未完成，请稍后重试。' };
  return { status: 'completed' };
}
