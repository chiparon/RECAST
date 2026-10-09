import { describe, expect, it } from 'vitest';
import { buildModuleTranslationScope, type ModuleCandidatePackage } from './module-translation-scope';

const workspaceRoot = process.cwd();

function candidate(overrides: Partial<ModuleCandidatePackage> = {}): ModuleCandidatePackage {
  return {
    repositoryId: 'repo-history',
    repositoryName: 'commons-fileupload',
    analysisRevision: 'analysis-1',
    projectId: 'project-1',
    moduleId: 'module-multipart',
    name: 'Multipart 流解析',
    purpose: '按边界读取分段正文',
    language: 'Java',
    sourceFiles: ['src/main/java/a/MultipartStream.java', 'src/main/java/a/ItemInputStream.java'],
    coreApis: ['MultipartStream(InputStream, byte[])', 'int readBodyData(OutputStream)'],
    dependsOn: ['module-util'],
    preview: 'public int readBodyData(OutputStream output) { ... }',
    ...overrides,
  };
}

const targetModule = {
  name: 'Multipart 流解析',
  language: 'Java',
  sourceFiles: ['src/main/java/a/MultipartStream.java'],
  coreApis: ['int readBodyData(OutputStream)'],
  dependsOn: [],
  repositoryId: 'repo-target',
  analysisRevision: 'analysis-target',
  projectId: 'project-target',
};

describe('module translation scope', () => {
  it('widens read-only evidence without widening target writes and refuses scope overflow', () => {
    const evidenceScopes = Array.from({ length: 9 }, (_, i) => ({ repositoryId: `history-${i}`, analysisRevision: 'v1' }));
    const input = { workspaceRoot, targetModule, candidates: [candidate()], requirement: 'upload', evidenceScopes };
    const scope = buildModuleTranslationScope(input);
    expect(scope.evidenceScopes).toHaveLength(10);
    expect(scope.profile.writeFiles).toEqual(targetModule.sourceFiles);
    expect(scope.context.some(c => c.content.includes('history-8@v1'))).toBe(true);
    expect(() => buildModuleTranslationScope({ ...input, evidenceScopes: Array.from({ length: 65 }, (_, i) => ({ repositoryId: `history-${i}`, analysisRevision: 'v1' })) })).toThrow('64');
  });
  it('derives the write set from the target module and the context from history candidates', () => {
    const scope = buildModuleTranslationScope({
      workspaceRoot,
      targetModule,
      candidates: [candidate()],
      requirement: '恢复按边界读取分段正文的实现',
    });

    expect(scope.profile.workspaceRoot).toBe(workspaceRoot);
    expect(scope.profile.sourceLanguage).toBe('Java');
    expect(scope.profile.targetLanguage).toBe('Java');
    expect(scope.profile.writeFiles).toEqual(['src/main/java/a/MultipartStream.java']);
    expect(scope.profile.workspaceFiles).toEqual(['src/main/java/a/MultipartStream.java']);
    expect(scope.label).toBe('模块 Multipart 流解析');

    const kinds = scope.context.map((item) => item.kind);
    expect(kinds).toEqual(['summary', 'summary', 'interface', 'dependency', 'source']);
    expect(scope.context[0]?.content).toContain('开发需求：恢复按边界读取分段正文的实现');
    const inventory = scope.context[1]!.content;
    expect(inventory).toContain('src/main/java/a/ItemInputStream.java');
    expect(scope.context[2]?.content).toContain('readBodyData');
    expect(scope.context[3]?.content).toContain('module-util');
    expect(scope.context[4]).toMatchObject({ repository: 'repo-history', revision: 'analysis-1', path: 'src/main/java/a/MultipartStream.java' });
    expect(scope.warnings).toEqual([]);
    // The reviewed candidate's revision becomes an on-demand evidence scope.
    expect(scope.evidenceScopes).toEqual([{ repositoryId: 'repo-history', analysisRevision: 'analysis-1', projectId: 'project-1' }]);
  });

  it('scopes on-demand evidence to the reviewed candidates only', () => {
    const scope = buildModuleTranslationScope({
      workspaceRoot, targetModule,
      candidates: [
        candidate(),
        candidate({ moduleId: 'other-module' }),
        candidate({ repositoryId: 'repo-second', projectId: undefined, analysisRevision: 'analysis-2' }),
      ],
      requirement: '',
    });
    expect(scope.evidenceScopes).toEqual([
      { repositoryId: 'repo-history', analysisRevision: 'analysis-1', projectId: 'project-1' },
      { repositoryId: 'repo-second', analysisRevision: 'analysis-2' },
    ]);
    expect(scope.evidenceScopes.some((entry) => entry.repositoryId === 'repo-target')).toBe(false);
    expect(buildModuleTranslationScope({ workspaceRoot, targetModule, candidates: [], requirement: '' }).evidenceScopes).toEqual([]);
  });

  it('never widens the write set with candidate files', () => {
    const scope = buildModuleTranslationScope({
      workspaceRoot,
      targetModule,
      candidates: [candidate(), candidate({ repositoryId: 'other', moduleId: 'other', sourceFiles: ['src/elsewhere.cs'] })],
      requirement: '',
    });
    expect(scope.profile.writeFiles).toEqual(['src/main/java/a/MultipartStream.java']);
    expect(scope.profile.workspaceFiles).toEqual(['src/main/java/a/MultipartStream.java']);
    expect(JSON.stringify(scope.profile)).not.toContain('elsewhere');
    // Candidate paths only ever appear as evidence context, never as a write target.
    expect(scope.context.some((item) => item.kind === 'summary' && item.content.includes('src/elsewhere.cs'))).toBe(true);
  });

  it('adds host-selected target dependencies to read scope without making them writable', () => {
    const scope = buildModuleTranslationScope({
      workspaceRoot,
      targetModule,
      candidates: [candidate()],
      requirement: 'read dependencies',
      readOnlyFiles: ['src/main/java/a/Contracts.java', 'src/main/java/a/Ports.java', 'src/main/java/a/MultipartStream.java'],
    });
    expect(scope.profile.workspaceFiles).toEqual([
      'src/main/java/a/MultipartStream.java',
      'src/main/java/a/Contracts.java',
      'src/main/java/a/Ports.java',
    ]);
    expect(scope.profile.writeFiles).toEqual(['src/main/java/a/MultipartStream.java']);
  });

  it('adds only a host-computed dependency closure to the coordinated write scope', () => {
    const scope = buildModuleTranslationScope({
      workspaceRoot,
      targetModule,
      candidates: [candidate()],
      requirement: 'repair the call chain',
      relatedWriteFiles: ['src/main/java/a/Ports.java', '../escape.java', '/absolute.java'],
    });
    expect(scope.profile.writeFiles).toEqual([
      'src/main/java/a/MultipartStream.java',
      'src/main/java/a/Ports.java',
    ]);
    expect(scope.profile.workspaceFiles).toEqual(scope.profile.writeFiles);
    expect(scope.warnings.some((warning) => warning.includes('受控跨模块写范围'))).toBe(true);
  });

  it('refuses an unusable scope instead of silently translating elsewhere', () => {
    expect(() => buildModuleTranslationScope({ workspaceRoot: 'relative/path', targetModule, candidates: [], requirement: '' }))
      .toThrow(/绝对的目标工程根目录/);
    expect(() => buildModuleTranslationScope({ workspaceRoot, targetModule: { ...targetModule, sourceFiles: [] }, candidates: [], requirement: '' }))
      .toThrow(/没有文件清单/);
    expect(() => buildModuleTranslationScope({ workspaceRoot, targetModule: { ...targetModule, sourceFiles: ['../outside.java'] }, candidates: [], requirement: '' }))
      .toThrow(/没有文件清单/);
  });

  it('bounds the context and reports what it dropped', () => {
    const scope = buildModuleTranslationScope({
      workspaceRoot,
      targetModule,
      candidates: Array.from({ length: 6 }, (_, index) => candidate({ moduleId: `module-${index}`, preview: 'x'.repeat(4_000) })),
      requirement: '',
      maxContextChars: 6_000,
    });
    expect(scope.contextCharacters).toBeLessThanOrEqual(6_000);
    expect(scope.warnings.some((warning) => warning.includes('字符上限'))).toBe(true);
  });

  it('explains that a run without candidates relies on task evidence', () => {
    const scope = buildModuleTranslationScope({ workspaceRoot, targetModule, candidates: [], requirement: '' });
    expect(scope.warnings.some((warning) => warning.includes('尚未选择历史候选模块'))).toBe(true);
    expect(scope.context).toHaveLength(1);
  });
});
