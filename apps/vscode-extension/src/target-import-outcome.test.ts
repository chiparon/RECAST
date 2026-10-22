import { describe, expect, it } from 'vitest';
import { targetImportVerdict } from './target-import-outcome';
import type { CodeIntelligencePresentation, CodeIntelligenceRepositoryPresentation } from './ui-types';

function target(overrides: Partial<CodeIntelligenceRepositoryPresentation> = {}): CodeIntelligenceRepositoryPresentation {
  return {
    repositoryId: 'repo-target',
    displayName: 'commons-fileupload-java-skeleton - 副本',
    role: 'target',
    analysisStatus: 'ready',
    activeRevision: 'analysis-1',
    selectedRevision: 'analysis-1',
    revisions: [],
    languages: [{ languageId: 'java', capabilityLevel: 'structural', fileCount: 83 }],
    projects: [{
      projectId: 'project-1',
      displayName: 'commons-fileupload',
      kind: 'maven',
      revision: 'analysis-1',
      selected: true,
      fileCount: 83,
      moduleCount: 12,
    }],
    selectedProjectId: 'project-1',
    summary: { files: 83, symbols: 0, dependencies: 0, languages: [] },
    ...overrides,
  } as CodeIntelligenceRepositoryPresentation;
}

function presentation(repositories: CodeIntelligenceRepositoryPresentation[]): CodeIntelligencePresentation {
  return { status: 'ready', storage: 'seekdb', repositories };
}

describe('targetImportVerdict', () => {
  it('completes an import whose target offers a project to select', () => {
    expect(targetImportVerdict(presentation([target()]), [])).toEqual({ status: 'completed' });
  });

  it('fails an indexed directory that holds no project instead of reporting success', () => {
    // A copy holding only Maven target/ output indexes to a ready revision with
    // zero projects. Declaring success there left the panel waiting for a choice
    // that cannot exist.
    const verdict = targetImportVerdict(presentation([target({ projects: [], selectedProjectId: null })]), []);
    expect(verdict.status).toBe('failed');
    expect(verdict.status === 'failed' ? verdict.message : '').toContain('没有可识别的工程');
    expect(verdict.status === 'failed' ? verdict.message : '').toContain('副本');
  });

  it('names missing sources when the revision indexed no files at all', () => {
    // Verified against the live index: that copy's newest revision held zero
    // documents while its 2026-09-17 revision held 2261, so the directory lost
    // its sources and the wording must not blame a missing build file.
    const verdict = targetImportVerdict(presentation([target({
      projects: [], selectedProjectId: null, languages: [],
    })]), []);
    expect(verdict.status).toBe('failed');
    expect(verdict.status === 'failed' ? verdict.message : '').toContain('没有可索引的源文件');
  });

  it('keeps the build-file wording when sources were indexed but no project exists', () => {
    const verdict = targetImportVerdict(presentation([target({
      projects: [], selectedProjectId: null,
      languages: [{ languageId: 'java', capabilityLevel: 'structural', fileCount: 59 }],
    })]), []);
    expect(verdict.status === 'failed' ? verdict.message : '').toContain('缺少 pom.xml');
  });

  it('fails while the target is still registering or indexing', () => {
    for (const analysisStatus of ['registered', 'indexing'] as const) {
      expect(targetImportVerdict(presentation([target({ analysisStatus, activeRevision: null })]), []).status).toBe('failed');
    }
  });

  it('fails when no target is configured at all', () => {
    const verdict = targetImportVerdict(presentation([target({ role: 'history' })]), []);
    expect(verdict.status).toBe('failed');
    expect(verdict.status === 'failed' ? verdict.message : '').toContain('索引尚未开始');
    expect(verdict.status === 'failed' ? verdict.message : '').toContain('有效配置');
  });

  it('reports a failed target with the index-failure reason', () => {
    const byStatus = targetImportVerdict(presentation([target({ analysisStatus: 'failed' })]), []);
    expect(byStatus.status === 'failed' ? byStatus.message : '').toContain('索引失败');
    const byId = targetImportVerdict(presentation([target()]), ['repo-target']);
    expect(byId.status === 'failed' ? byId.message : '').toContain('索引失败');
  });

  it('still completes when only an unrelated history repository failed', () => {
    const failedHistory = target({ repositoryId: 'repo-history', role: 'history', displayName: 'commons-fileupload' });
    expect(targetImportVerdict(presentation([target(), failedHistory]), ['repo-history'])).toEqual({ status: 'completed' });
  });
});
