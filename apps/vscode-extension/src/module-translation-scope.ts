import type { ModuleTarget, WorkspaceEvidenceScope, WorkspaceHistoryView, WorkspaceTranslationContext, WorkspaceTranslationMode } from '@forexplore/contracts';
import type { TranslationProfile } from './workspace-translation-host';
import { MAX_RETRIEVAL_SCOPES } from '@forexplore/contracts';

/**
 * A reviewed history module offered as translation context. Only the host
 * builds this from a validated candidate; the page never supplies file lists,
 * paths or source.
 */
export interface ModuleCandidatePackage {
  repositoryId: string;
  repositoryName?: string;
  analysisRevision: string;
  projectId?: string;
  moduleId: string;
  name: string;
  purpose?: string;
  language?: string;
  /** Complete module file list at the pinned revision. */
  sourceFiles: string[];
  coreApis: string[];
  dependsOn: string[];
  /** Retrieval excerpt used as representative source evidence. */
  preview?: string;
}

export interface ModuleTranslationScopeInput {
  /** Local target project root owned by the host, never a page-supplied path. */
  workspaceRoot: string;
  targetModule: NonNullable<ModuleTarget['module']> & { name: string; language?: string };
  candidates: readonly ModuleCandidatePackage[];
  requirement: string;
  maxContextChars?: number;
  /**
   * When false, candidate inventory is not pre-loaded into the context: the
   * candidates only widen the on-demand evidence scope. Use it when the
   * implementation should be fetched by the agent rather than pushed.
   */
  includeCandidateContext?: boolean;
  /** Visible, revision-pinned history repositories supplied by the trusted host. */
  evidenceScopes?: WorkspaceEvidenceScope[];
  /** Host-created, immutable snapshot of the selected history module. */
  historyView?: WorkspaceHistoryView;
  /**
   * Target-project files that the Analyzer/Translator may inspect without
   * modifying.  The write set remains the target module's own files.
   */
  readOnlyFiles?: readonly string[];
  /** Host-derived dependency-closure files allowed for a coordinated repair. */
  relatedWriteFiles?: readonly string[];
}

export interface ModuleTranslationScope {
  label: string;
  /** Task specification handed to the Analyzer, built from host-owned state. */
  spec: string;
  profile: TranslationProfile;
  context: WorkspaceTranslationContext[];
  /**
   * History revisions the agent may query on demand through the read-only
   * index. Derived from the reviewed candidates, so the agent can pull the
   * implementation it needs instead of receiving an inventory only.
   */
  evidenceScopes: WorkspaceEvidenceScope[];
  historyView?: WorkspaceHistoryView;
  /** Host-selected Agent route; direct-translator is used without history. */
  translationMode?: WorkspaceTranslationMode;
  contextCharacters: number;
  warnings: string[];
}

const defaultMaxContextChars = 120_000;
const maxCoreApisPerCandidate = 40;
const maxDependsOnPerCandidate = 40;
const maxPreviewChars = 24_000;

/**
 * Turns "a selected target module plus its retrieved history candidates" into
 * the profile and context the translation runtime consumes.
 *
 * The write scope starts with the target module's own files. The trusted host
 * may add a bounded dependency closure for a coordinated repair; a history
 * candidate can never widen it by itself.
 */
export function buildModuleTranslationScope(input: ModuleTranslationScopeInput): ModuleTranslationScope {
  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot || !/^([A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(workspaceRoot)) {
    throw new Error('模块翻译需要宿主提供绝对的目标工程根目录。');
  }
  const primaryWriteFiles = unique(input.targetModule.sourceFiles.map(normalizeRelativePath).filter(Boolean));
  const relatedWriteFiles = unique((input.relatedWriteFiles ?? []).map(normalizeRelativePath).filter(Boolean))
    .filter((file) => !primaryWriteFiles.includes(file));
  const writeFiles = unique([...primaryWriteFiles, ...relatedWriteFiles]);
  const readOnlyFiles = unique((input.readOnlyFiles ?? []).map(normalizeRelativePath).filter(Boolean))
    .filter((file) => !writeFiles.includes(file));
  if (writeFiles.length === 0) {
    throw new Error('选中的目标模块没有文件清单，无法确定可修改范围。');
  }
  const language = input.targetModule.language?.trim() || 'Text';
  const scopeWarnings = relatedWriteFiles.length
    ? [`受控跨模块写范围：${relatedWriteFiles.length} 个依赖闭包文件可由本次任务一并修复。`]
    : [];
  if (input.historyView) {
    const identities = input.historyView.candidates ?? [input.historyView];
    if (identities.length !== input.candidates.length || identities.some((view, index) => {
      const selected = input.candidates[index];
      return !selected || view.repositoryId !== selected.repositoryId ||
        view.analysisRevision !== selected.analysisRevision || view.moduleId !== selected.moduleId ||
        (view.projectId ?? '') !== (selected.projectId ?? '');
    })) {
      throw new Error('历史视图与选中的候选模块不一致。');
    }
  }
  const warnings: string[] = [];
  const maxContextChars = input.maxContextChars ?? defaultMaxContextChars;
  const context: WorkspaceTranslationContext[] = [];
  let characters = 0;
  const push = (entry: WorkspaceTranslationContext): boolean => {
    if (characters + entry.content.length > maxContextChars) {
      warnings.push(`上下文达到 ${maxContextChars} 字符上限，已省略后续候选模块证据。`);
      return false;
    }
    context.push(entry);
    characters += entry.content.length;
    return true;
  };

  push({
    id: `module-target:${writeFiles.length}`,
    kind: 'summary',
    content: [
      `目标模块：${input.targetModule.name}`,
      `目标工程根目录：${workspaceRoot}`,
      `允许修改的文件：${writeFiles.join(', ')}`,
      input.targetModule.coreApis.length ? `目标模块现有接口：\n${input.targetModule.coreApis.map((api) => `- ${api}`).join('\n')}` : '',
      input.targetModule.dependsOn.length ? `目标模块依赖：${input.targetModule.dependsOn.join(', ')}` : '',
      input.requirement.trim() ? `开发需求：${input.requirement.trim()}` : '',
    ].filter(Boolean).join('\n'),
  });

  for (const candidate of input.candidates) {
    if (input.includeCandidateContext === false) break;
    const origin = candidate.repositoryName ?? candidate.repositoryId;
    const header = [
      `历史候选模块：${candidate.name}（模块 ${candidate.moduleId}）`,
      `来源仓库：${origin}`,
      `固定版本：${candidate.analysisRevision}`,
      candidate.purpose ? `职责：${candidate.purpose}` : '',
      candidate.language ? `语言：${candidate.language}` : '',
      `完整文件清单（${candidate.sourceFiles.length}）：${candidate.sourceFiles.join(', ')}`,
    ].filter(Boolean).join('\n');
    if (!push({ id: `module-candidate:${candidate.repositoryId}:${candidate.moduleId}`, kind: 'summary', content: header })) break;
    const coreApis = candidate.coreApis.slice(0, maxCoreApisPerCandidate);
    if (coreApis.length) {
      if (!push({
        id: `module-interface:${candidate.repositoryId}:${candidate.moduleId}`,
        kind: 'interface',
        content: `${candidate.name} 的公开接口：\n${coreApis.map((api) => `- ${api}`).join('\n')}`,
        repository: candidate.repositoryId,
        revision: candidate.analysisRevision,
      })) break;
      if (candidate.coreApis.length > coreApis.length) warnings.push(`${candidate.name} 的接口清单已截断到 ${maxCoreApisPerCandidate} 条。`);
    }
    const dependsOn = candidate.dependsOn.slice(0, maxDependsOnPerCandidate);
    if (dependsOn.length) {
      if (!push({
        id: `module-dependency:${candidate.repositoryId}:${candidate.moduleId}`,
        kind: 'dependency',
        content: `${candidate.name} 依赖的模块：${dependsOn.join(', ')}`,
        repository: candidate.repositoryId,
        revision: candidate.analysisRevision,
      })) break;
    }
    if (candidate.preview?.trim()) {
      if (!push({
        id: `module-source:${candidate.repositoryId}:${candidate.moduleId}`,
        kind: 'source',
        content: candidate.preview.slice(0, maxPreviewChars),
        path: candidate.sourceFiles[0],
        repository: candidate.repositoryId,
        revision: candidate.analysisRevision,
      })) break;
    }
  }
  if (input.candidates.length === 0) {
    warnings.push('尚未选择历史候选模块；本次翻译只依据目标模块自身与已勾选的任务证据，且没有可按需查询的历史版本。');
  } else if (input.includeCandidateContext === false) {
    warnings.push('候选模块只提供按需查询范围，其清册与源码不会预先注入上下文；请用 query_evidence 取回所需实现。');
  }
  const evidenceScopes: WorkspaceEvidenceScope[] = [...new Map([...input.candidates, ...(input.evidenceScopes ?? [])].map((candidate) => [
    `${candidate.repositoryId}@${candidate.analysisRevision}`,
    {
      repositoryId: candidate.repositoryId,
      analysisRevision: candidate.analysisRevision,
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    },
  ])).values()];
  if (evidenceScopes.length > MAX_RETRIEVAL_SCOPES) throw new Error(`历史取证范围超过 ${MAX_RETRIEVAL_SCOPES} 个版本，请缩小参考工程范围。`);
  if (input.evidenceScopes?.length) push({ id: 'history-evidence-scopes', kind: 'summary', content:
    `query_evidence 可查询以下固定历史版本（只读）；跨仓依赖请在此范围取证：\n${evidenceScopes.map(s => `${s.repositoryId}@${s.analysisRevision}`).join('\n')}` });

  return {
    label: `模块 ${input.targetModule.name}`,
    spec: [
      `# 模块级翻译任务：${input.targetModule.name}`,
      `目标工程根目录：${workspaceRoot}`,
      `目标语言：${language}`,
      `允许修改的文件（writeFiles）：${writeFiles.join(', ')}`,
      input.targetModule.coreApis.length ? `目标模块现有接口：\n${input.targetModule.coreApis.map((api) => `- ${api}`).join('\n')}` : '',
      input.targetModule.dependsOn.length ? `目标模块依赖：${input.targetModule.dependsOn.join(', ')}` : '',
      input.requirement.trim() ? `开发需求：${input.requirement.trim()}` : '',
      '',
      '## 约束',
      '- 只在 writeFiles 内实现；历史候选模块是证据，不是可修改目标。',
      relatedWriteFiles.length ? `- 其中 ${relatedWriteFiles.length} 个文件属于宿主计算的直接依赖闭包，只能用于闭合当前模块调用链，不得扩展到其他文件。` : '',
      '- 复用目标工程既有结构与契约，不要为通过编译而删除实现或放宽构建配置。',
      '- 目标工程的 workspaceFiles 可用 read_file 读取且只读；query_evidence 只查询固定历史版本，不要用它查目标工程依赖。',
      `- 待实现的历史候选模块：${input.candidates.length ? input.candidates.map((item) => item.name).join('、') : '（尚未选择候选模块，仅依据已勾选的任务证据）'}`,
    ].filter(Boolean).join('\n'),
    profile: {
      workspaceRoot,
      sourceLanguage: language,
      targetLanguage: language,
      workspaceFiles: [...writeFiles, ...readOnlyFiles],
      writeFiles,
    },
    context,
    evidenceScopes,
    ...(input.historyView ? { historyView: structuredClone(input.historyView) } : {}),
    contextCharacters: characters,
    warnings: [...scopeWarnings, ...warnings],
  };
}

/** Repository-relative POSIX path; absolute paths and traversal are refused. */
function normalizeRelativePath(value: string): string {
  const path = value.trim().replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) return '';
  return path;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
