import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MAX_SELECTED_HISTORY_MODULES, type ModuleTarget, type SearchCandidate, type WorkspaceEvidenceScope, type WorkspaceHistoryView } from '@forexplore/contracts';
import { buildModuleTranslationScope } from './module-translation-scope';
import type { WorkspaceTranslationModuleScope } from './workspace-translation-host';

/** Both product hosts pass their own selected target and explicitly chosen candidate. */
export async function prepareModuleTranslationScope(input: {
  workspaceRoot: string; target: ModuleTarget; candidate?: SearchCandidate;
  candidates?: readonly SearchCandidate[];
  requirement: string; decisionNotes: string;
  includeCandidateContext?: boolean;
  evidenceScopes?: WorkspaceEvidenceScope[];
  historyView?: WorkspaceHistoryView;
}): Promise<WorkspaceTranslationModuleScope> {
  const { target } = input;
  const candidates = input.candidates ?? (input.candidate ? [input.candidate] : []);
  if (candidates.length < 1 || candidates.length > MAX_SELECTED_HISTORY_MODULES ||
      new Set(candidates.map(item => JSON.stringify([item.sourceModule?.repositoryId, item.sourceModule?.analysisRevision, item.sourceModule?.projectId, item.sourceModule?.moduleId]))).size !== candidates.length) {
    throw new Error('请选择 1～3 个不同的历史模块。');
  }
  if (target.kind !== 'module' || !target.module || candidates.some(candidate => candidate.kind !== 'module' || !candidate.sourceModule)) {
    throw new Error('模块翻译需要当前目标模块和已选中的历史模块候选。');
  }
  const readOnlyFiles = await discoverTargetReadOnlyFiles(input.workspaceRoot, target.module.sourceFiles);
  const scope = buildModuleTranslationScope({
    workspaceRoot: await realpath(input.workspaceRoot),
    targetModule: { ...target.module, name: target.name, language: target.language },
    requirement: [input.requirement.trim(), input.decisionNotes.trim()].filter(Boolean).join('\n补充约束：'),
    includeCandidateContext: input.includeCandidateContext,
    evidenceScopes: input.evidenceScopes,
    candidates: candidates.map(candidate => {
      const source = candidate.sourceModule!;
      return { repositoryId: source.repositoryId, repositoryName: candidate.repository,
      analysisRevision: source.analysisRevision, projectId: source.projectId, moduleId: source.moduleId,
      name: source.name, purpose: source.purpose, language: candidate.language,
      sourceFiles: source.sourceFiles ?? [candidate.path], coreApis: source.coreApis ?? [], dependsOn: source.dependsOn ?? candidate.dependencies,
      preview: candidate.preview };
    }),
    readOnlyFiles,
    ...(input.historyView ? { historyView: input.historyView } : {}),
  });
  scope.profile.sourceLanguage = candidates[0]!.language;
  const fileHashes: Record<string, string> = {};
  for (const file of scope.profile.writeFiles) {
    fileHashes[file] = await moduleFileHash(scope.profile.workspaceRoot, file);
  }
  return { ...scope, fileHashes };
}

/**
 * Prepare a module translation when retrieval has no usable history candidate.
 * The target write scope and requirement context are still host-derived; only
 * the Agent route changes to the direct Translator fallback.
 */
export async function prepareDirectModuleTranslationScope(input: {
  workspaceRoot: string; target: ModuleTarget; requirement: string; decisionNotes: string;
}): Promise<WorkspaceTranslationModuleScope> {
  const { target } = input;
  if (target.kind !== 'module' || !target.module) {
    throw new Error('需求直实现兜底需要当前目标模块及其文件清单。');
  }
  const scope = buildModuleTranslationScope({
    workspaceRoot: await realpath(input.workspaceRoot),
    targetModule: { ...target.module, name: target.name, language: target.language },
    requirement: [input.requirement.trim(), input.decisionNotes.trim()].filter(Boolean).join('\n补充约束：'),
    candidates: [],
    includeCandidateContext: false,
    readOnlyFiles: await discoverTargetReadOnlyFiles(input.workspaceRoot, target.module.sourceFiles),
  });
  const fileHashes: Record<string, string> = {};
  for (const file of scope.profile.writeFiles) {
    fileHashes[file] = await moduleFileHash(scope.profile.workspaceRoot, file);
  }
  return { ...scope, translationMode: 'direct-translator', fileHashes };
}

/**
 * Expose production source dependencies as read-only observations.  A module
 * summary contains ownership files, but it does not carry every C#/Java import
 * edge.  Letting the host publish the bounded production source inventory
 * prevents a valid dependency read from becoming a false scope violation while
 * keeping tests, build output, history repositories and generated files out of
 * the Agent's view.  `writeFiles` is still enforced separately by the runtime.
 */
async function discoverTargetReadOnlyFiles(root: string, ownedFiles: readonly string[]): Promise<string[]> {
  const normalizedRoot = await realpath(root);
  const sourceExtensions = new Set([
    '.c', '.cc', '.cpp', '.cxx', '.cs', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
    '.kt', '.kts', '.mjs', '.py', '.rs', '.ts', '.tsx',
  ]);
  const ignoredDirectories = new Set([
    '.git', '.forexplore', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out',
    'target', 'coverage', 'test', 'tests', '__tests__',
  ]);
  const owned = new Set(ownedFiles.map(normalizePath).filter(Boolean));
  const found = new Set<string>(owned);
  const contents = new Map<string, string>();
  const maxFiles = 256;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    if (found.size >= maxFiles) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (found.size >= maxFiles) return;
      if (entry.name === '.' || entry.name === '..' || ignoredDirectories.has(entry.name.toLowerCase())) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (/(?:^|[._-])tests?(?:[._-]|$)/i.test(entry.name) || /(?:^|\/)(?:test|tests)(?:\/|$)/i.test(relative)) continue;
      const normalized = normalizePath(relative);
      if (!normalized) continue;
      found.add(normalized);
      try {
        const content = await readFile(absolute, 'utf8');
        if (content.length <= 256_000) contents.set(normalized, content);
      } catch {
        // A file that cannot be inspected is not published as a dependency.
      }
    }
  }

  await visit(normalizedRoot, '');

  // Resolve a small source-level dependency closure.  The module proposal
  // gives us ownership files, while declarations in those files reveal the
  // target contracts/ports/domain types they use.  This keeps unrelated
  // application files out of the Agent prompt without relying on a language
  // compiler or exposing hidden tests.
  const declarations = new Map<string, Set<string>>();
  for (const [file, content] of contents) {
    const names = new Set<string>();
    for (const match of content.matchAll(/\b(?:class|record|interface|enum|struct|type|trait|object|protocol)\s+([A-Za-z_]\w*)/g)) {
      names.add(match[1]!);
    }
    for (const name of names) {
      const files = declarations.get(name) ?? new Set<string>();
      files.add(file);
      declarations.set(name, files);
    }
  }
  const selected = new Set<string>([...owned].filter((file) => contents.has(file)));
  for (let depth = 0; depth < 2; depth++) {
    const before = selected.size;
    for (const file of [...selected]) {
      const content = contents.get(file);
      if (!content) continue;
      const identifiers = new Set<string>();
      for (const match of content.matchAll(/\b[A-Z][A-Za-z0-9_]{2,}\b/g)) identifiers.add(match[0]!);
      for (const identifier of identifiers) {
        for (const dependency of declarations.get(identifier) ?? []) selected.add(dependency);
      }
    }
    if (selected.size === before) break;
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export async function moduleFileHash(root: string, file: string): Promise<string> {
  const fullPath = await realpath(path.resolve(root, file));
  const relative = path.relative(await realpath(root), fullPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('模块文件不能位于目标工作区之外。');
  }
  return createHash('sha256').update(await readFile(fullPath)).digest('hex');
}
