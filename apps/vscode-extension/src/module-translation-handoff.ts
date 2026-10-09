import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MAX_SELECTED_HISTORY_MODULES, type Language, type ModuleTarget, type SearchCandidate, type WorkspaceEvidenceScope, type WorkspaceHistoryView } from '@forexplore/contracts';
import { buildModuleTranslationScope } from './module-translation-scope';
import type { WorkspaceTranslationModuleScope } from './workspace-translation-host';

/** Both product hosts pass their own selected target and explicitly chosen candidate. */
export async function prepareModuleTranslationScope(input: {
  workspaceRoot: string; target: ModuleTarget; candidate?: SearchCandidate;
  candidates?: readonly SearchCandidate[];
  /** Other target modules from the trusted explorer snapshot. */
  relatedModules?: readonly ModuleTarget[];
  requirement: string; decisionNotes: string;
  includeCandidateContext?: boolean;
  evidenceScopes?: WorkspaceEvidenceScope[];
  historyView?: WorkspaceHistoryView;
  relatedWriteFiles?: readonly string[];
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
  const relatedWriteFiles = input.relatedWriteFiles ?? await discoverRelatedWriteFiles(
    input.workspaceRoot, target, input.relatedModules ?? [],
  );
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
    ...(relatedWriteFiles.length ? { relatedWriteFiles } : {}),
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
  relatedModules?: readonly ModuleTarget[];
  relatedWriteFiles?: readonly string[];
}): Promise<WorkspaceTranslationModuleScope> {
  const { target } = input;
  if (target.kind !== 'module' || !target.module) {
    throw new Error('需求直实现兜底需要当前目标模块及其文件清单。');
  }
  const relatedWriteFiles = input.relatedWriteFiles ?? await discoverRelatedWriteFiles(
    input.workspaceRoot, target, input.relatedModules ?? [],
  );
  const scope = buildModuleTranslationScope({
    workspaceRoot: await realpath(input.workspaceRoot),
    targetModule: { ...target.module, name: target.name, language: target.language },
    requirement: [input.requirement.trim(), input.decisionNotes.trim()].filter(Boolean).join('\n补充约束：'),
    candidates: [],
    includeCandidateContext: false,
    readOnlyFiles: await discoverTargetReadOnlyFiles(input.workspaceRoot, target.module.sourceFiles),
    ...(relatedWriteFiles.length ? { relatedWriteFiles } : {}),
  });
  const fileHashes: Record<string, string> = {};
  for (const file of scope.profile.writeFiles) {
    fileHashes[file] = await moduleFileHash(scope.profile.workspaceRoot, file);
  }
  return { ...scope, translationMode: 'direct-translator', fileHashes };
}

/**
 * Prepare the bounded project-integration repair scope. It intentionally has
 * no history candidate and no direct-fallback route: the Codex runtime still
 * runs its Analyzer over the full readable target tree, then the Translator
 * may only change the host-computed unresolved files.
 */
export async function prepareIntegrationTranslationScope(input: {
  workspaceRoot: string;
  targetLanguage: string;
  requirement: string;
  writeFiles: readonly string[];
  readOnlyFiles?: readonly string[];
}): Promise<WorkspaceTranslationModuleScope> {
  const writeFiles = [...new Set(input.writeFiles.map((file) => file.replaceAll('\\', '/').trim()).filter(Boolean))];
  if (writeFiles.length === 0) throw new Error('项目集成修复没有宿主授权的写入文件。');
  const target: ModuleTarget = {
    id: 'project-integration-repair', kind: 'module', name: '项目集成修复', language: input.targetLanguage as Language,
    path: writeFiles[0]!, signature: 'integration',
    module: { sourceFiles: writeFiles, coreApis: [], dependsOn: [] },
  };
  const scope = buildModuleTranslationScope({
    workspaceRoot: await realpath(input.workspaceRoot),
    targetModule: { ...target.module!, name: target.name, language: input.targetLanguage as Language },
    candidates: [],
    requirement: input.requirement,
    includeCandidateContext: false,
    readOnlyFiles: input.readOnlyFiles,
  });
  const fileHashes: Record<string, string> = {};
  for (const file of scope.profile.writeFiles) fileHashes[file] = await moduleFileHash(scope.profile.workspaceRoot, file);
  return { ...scope, fileHashes };
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

/**
 * Find a small, host-derived write closure for the interactive module flow.
 * The Webview only selects a module; it cannot grant write access to another
 * module.  We therefore inspect the current module's source references and
 * add files from the already published target module snapshot only when a
 * declaration or an explicit dependency is referenced.  Callers and unrelated
 * modules remain outside this set and can be handled by the project repair
 * pass.
 */
async function discoverRelatedWriteFiles(
  root: string,
  target: ModuleTarget,
  relatedModules: readonly ModuleTarget[],
): Promise<string[]> {
  const current = target.module;
  if (!current || relatedModules.length === 0) return [];
  const normalizedRoot = await realpath(root);
  const currentFiles = current.sourceFiles.map(normalizePath).filter(Boolean);
  const currentContents = await readWorkspaceFiles(normalizedRoot, currentFiles);
  const references = [...currentContents.values()].join('\n');
  if (!references) return [];
  const related: string[] = [];
  for (const candidate of relatedModules) {
    if (candidate.kind !== 'module' || candidate.id === target.id) continue;
    const candidateModule = candidate.module;
    if (!candidateModule) continue;
    const candidateFiles = candidateModule.sourceFiles.map(normalizePath).filter(Boolean);
    if (candidateFiles.length === 0) continue;
    const declarations = new Set<string>();
    for (const file of candidateFiles) {
      const content = (await readWorkspaceFiles(normalizedRoot, [file])).get(file);
      if (!content) continue;
      for (const match of content.matchAll(/\b(?:class|record|interface|enum|struct|type|trait|object|protocol|delegate)\s+([A-Za-z_]\w*)/g)) {
        declarations.add(match[1]!);
      }
    }
    const stems = candidateFiles.map((file) => path.basename(file).replace(/\.[^.]+$/, ''))
      .filter((stem) => stem.length >= 3 && !/^(?:program|startup|global|domain|application|adapters?|policies?|ports?)$/i.test(stem));
    const apis = (candidateModule.coreApis ?? []).map((api) => api.replace(/[^A-Za-z0-9_.]/g, ' ').trim().split(/\s+/).at(-1) ?? '')
      .filter((api) => api.length >= 3);
    const tokens = [...new Set([...declarations, ...stems, ...apis])];
    const referenced = tokens.some((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'm').test(references));
    const candidateModuleId = decodeModuleTargetId(candidate.id);
    const explicitDependency = Boolean(candidateModuleId && current.dependsOn.includes(candidateModuleId));
    if (referenced || explicitDependency) related.push(...candidateFiles);
  }
  return [...new Set(related)].sort((left, right) => left.localeCompare(right));
}

async function readWorkspaceFiles(root: string, files: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const resolvedRoot = await realpath(root);
  for (const file of files) {
    const normalized = normalizePath(file);
    if (!normalized) continue;
    const absolute = path.resolve(resolvedRoot, normalized);
    const relative = path.relative(resolvedRoot, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    try {
      const resolved = await realpath(absolute);
      const resolvedRelative = path.relative(resolvedRoot, resolved);
      if (!resolvedRelative || resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) continue;
      const content = await readFile(resolved, 'utf8');
      if (content.length <= 256_000) result.set(normalized, content);
    } catch {
      // Missing or unreadable dependency files cannot widen the write scope.
    }
  }
  return result;
}

function decodeModuleTargetId(value: string): string | undefined {
  if (!value.startsWith('module://')) return undefined;
  try {
    const parts = JSON.parse(decodeURIComponent(value.slice('module://'.length))) as unknown;
    return Array.isArray(parts) && typeof parts.at(-1) === 'string' ? parts.at(-1) : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
