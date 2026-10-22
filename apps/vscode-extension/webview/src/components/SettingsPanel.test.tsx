import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

describe('SettingsPanel', () => {
  it('renders the configured top K and multiple repository paths', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        topK={6}
        repositoryPaths={['D:/history/one', 'D:/history/two']}
        repositoryStatuses={[]}
        saving={false}
        onCheckRepositories={vi.fn()}

        onSelectCodeIntelligenceProject={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('返回方案数');
    expect(markup).toContain('Top 6');
    expect(markup).toContain('D:/history/one');
    expect(markup).toContain('D:/history/two');
    expect(markup).toContain('添加路径');
    expect(markup).toContain('保存设置');
  });

  it('offers a clear first-path action when no repository is configured', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        topK={4}
        repositoryPaths={[]}
        repositoryStatuses={[]}
        saving={false}
        onCheckRepositories={vi.fn()}

        onSelectCodeIntelligenceProject={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('尚未添加参考工程路径');
    expect(markup).toContain('添加第一个路径');
  });

  it('hides revision internals while retaining stale model warnings', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        topK={4}
        repositoryPaths={[]}
        repositoryStatuses={[]}
        codeIntelligence={{
          status: 'ready',
          storage: 'seekdb',
          repositories: [{
            repositoryId: 'repo-history',
            displayName: '历史服务',
            role: 'history',
            analysisStatus: 'ready',
            activeRevision: 'revision-active',
            selectedRevision: 'revision-history',
            revisions: [
              {
                analysisRevision: 'revision-active',
                analysisHash: 'hash-active',
                status: 'ready',
                createdAt: '2026-09-04T00:00:00.000Z',
                isActive: true,
                isSelected: false,
              },
              {
                analysisRevision: 'revision-history',
                analysisHash: 'hash-history',
                status: 'superseded',
                createdAt: '2026-09-03T00:00:00.000Z',
                isActive: false,
                isSelected: true,
              },
            ],
            languages: [{ languageId: 'typescript', capabilityLevel: 'structural', fileCount: 4 }],
            projects: [],
            selectedProjectId: null,
            summary: {
              status: 'stale',
              analysisRevision: 'revision-history',
              analysisHash: 'hash-history',
              planHash: 'sha256:plan',
            },
          }],
        }}
        saving={false}
        onCheckRepositories={vi.fn()}

        onSelectCodeIntelligenceProject={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).not.toContain('revision');
    expect(markup).toContain('Summary 已过期');
    expect(markup).toContain('模块建模结果已过期，请重新建模后使用。');
  });
});
