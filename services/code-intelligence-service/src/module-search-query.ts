import { indexModuleHierarchy, type ModuleTarget, type ProjectAnalysisRecord } from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import { projectAnalysisProfile, projectPlanHash } from './project-analysis.js';
import type { RecallPlan } from './recall-kernel.js';

/** Fetch one current project summary, never scan the target index or historical sources. */
export async function resolveModuleRetrievalTarget(store: IndexStore, target: ModuleTarget, signal?: AbortSignal): Promise<ModuleTarget> {
  signal?.throwIfAborted();
  const metadata = target.module;
  if (!metadata?.repositoryId || !metadata.analysisRevision || !metadata.projectId || !store.getModuleArtifacts) return target;
  const scope = { repositoryId: metadata.repositoryId, analysisRevision: metadata.analysisRevision };
  const repository = await store.getRepository(scope.repositoryId, signal);
  if (repository?.activeRevision !== scope.analysisRevision) throw new Error('Target module revision changed; select the current module again.');
  const [revision, artifacts] = await Promise.all([
    store.getRevision(scope, signal),
    store.getModuleArtifacts(scope, [`project-summary:${metadata.projectId}:${projectAnalysisProfile}`], signal),
  ]);
  const artifact = artifacts[0];
  const record = artifact?.payload as ProjectAnalysisRecord | undefined;
  if (!revision || revision.status !== 'ready' || artifact?.kind !== 'module-summary' || artifact.status !== 'current' || !record?.proposal || record.state !== 'ready' ||
      artifact.repositoryId !== scope.repositoryId || artifact.analysisRevision !== scope.analysisRevision ||
      record.repositoryId !== scope.repositoryId || record.analysisRevision !== scope.analysisRevision || record.projectId !== metadata.projectId ||
      artifact.analysisHash !== revision.analysisHash || record.proposal.analysisHash !== revision.analysisHash ||
      !artifact.planHash || artifact.planHash !== projectPlanHash(record.proposal)) return target;
  const tree = indexModuleHierarchy(record.proposal.modules);
  const module = tree.byId.get(metadata.moduleId ?? target.id) ?? record.proposal.modules.find(module =>
    module.name === target.name && JSON.stringify([...tree.sourceFiles(module.id).files].sort()) === JSON.stringify([...metadata.sourceFiles].sort()));
  if (!module) return target;
  const sourceFiles = tree.sourceFiles(module.id).files;
  const symbols = store.querySymbols && sourceFiles.length ? await Promise.all([
    store.querySymbols(scope, { projectId: metadata.projectId, relativePaths: sourceFiles.slice(0, 200),
      kinds: ['class', 'interface', 'record', 'struct', 'enum'], limit: 64 }, signal),
    // A thin facade may declare only one generic class, while its injected
    // ports describe authorization, attachments or workflow dispatch precisely.
    // Use indexed type references, without loading target source or dependencies.
    store.querySymbols(scope, { projectId: metadata.projectId, relativePaths: sourceFiles.slice(0, 200),
      kinds: ['field', 'property', 'constructor'], limit: 64 }, signal),
  ]) : undefined;
  const symbolNames = symbols ? [...new Set([
    ...symbols[1]!.symbols.flatMap(symbol => (symbol.signature?.slice(0, 500).split(/=>|[={;]/, 1)[0]?.match(/(?:[\w]+\.)*[A-Z][\w]+/g) ?? [])
      .map(name => name.split('.').at(-1)!)),
    ...symbols[0]!.symbols.map(symbol => symbol.name),
  ])].slice(0, 64) : metadata.symbolNames;
  return { ...target, name: module.name, documentation: uniqueLines([module.description, module.purpose]).join('\n'),
    module: { ...metadata, moduleId: module.id, purpose: module.purpose, description: module.description,
      symbolNames,
      coreApis: module.coreApis ?? [], sourceFiles, dependsOn: module.dependsOn } };
}

function uniqueLines(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.flatMap(value => (value ?? '').split(/\r?\n/)).map(value => value.trim()).filter(Boolean))];
}

/** Keep code identity useful across languages without embedding the target namespace and declarations. */
function capabilityTerms(target: ModuleTarget): string {
  const names = (target.module?.coreApis?.length ? target.module.coreApis : [target.signature])
    .slice(0, 16).flatMap(api => api.replace(/\(.*$/s, '').trim().split(/[\s.:]+/).slice(-2));
  // Container/task primitives and stub initializers describe the skeleton's
  // framework, not the behavior we are looking for in another language.
  const frameworkTypes = new Set(['array', 'task', 'valuetask', 'list', 'ilist', 'ireadonlylist', 'readonlylist', 'icollection',
    'ireadonlycollection', 'ienumerable', 'dictionary', 'idictionary', 'ireadonlydictionary', 'concurrentdictionary',
    'hashset', 'iset', 'exception', 'notimplementedexception', 'argumentexception', 'argumentnullexception',
    'invalidoperationexception', 'cancellationtoken', 'cancellationtokensource', 'datetime', 'datetimeoffset', 'timespan',
    'guid', 'func', 'action', 'idisposable', 'iasyncdisposable', 'stringcomparer']);
  names.push(...(target.module?.symbolNames ?? []).filter(name => !frameworkTypes.has(name.toLowerCase())));
  names.push(...(target.module?.sourceFiles ?? [target.path]).slice(0, 16)
    .map(path => path.split('/').at(-1)!.replace(/\.[^.]+$/, '')));
  const stopWords = new Set(['async', 'cs', 'java', 'ts', 'py', 'public', 'private', 'protected', 'static', 'void', 'string', 'class',
    'service', 'services', 'adapter', 'adapters', 'domain', 'application', 'infrastructure', 'impl', 'implementation', 'additional',
    'program', 'extended', 'contracts', 'ports', 'interfaces', 'components']);
  const words = names.flatMap(name => name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 1 && !stopWords.has(word.toLowerCase()));
  const distinct = new Map(words.map(word => [word.toLowerCase(), word]));
  // A multi-responsibility module must not lose its later injected ports merely
  // because its earlier type names used up the keyword head.
  return [...distinct.values()].slice(0, 64).join(' ');
}

export function buildModuleSearchQuery(target: ModuleTarget, requirement: string): { plans: RecallPlan[]; rerankQuery: string } {
  const summary = uniqueLines([target.module?.description, target.module?.purpose, target.documentation]).join('\n');
  const descriptive = uniqueLines([summary, target.name]).join('\n');
  const capabilities = capabilityTerms(target);
  // The module's behavior is always present. User text cannot displace its recall
  // evidence or cause an empty input to collapse to the module name alone.
  const behaviorQuery = uniqueLines([descriptive, capabilities]).join('\n').slice(0, 8_000);
  const implementationQuery = uniqueLines([capabilities, descriptive]).join('\n').slice(0, 8_000);
  const symbolQuery = uniqueLines([capabilities, descriptive]).join('\n').slice(0, 8_000);
  if (!behaviorQuery.trim()) throw new Error('Module query must contain between 1 and 32000 characters.');
  if (requirement.length > 32_000) throw new Error('Module query must contain between 1 and 32000 characters.');
  const recallMode = (process.env.CODE_INTELLIGENCE_MODULE_RECALL_MODE ?? 'three-view').toLowerCase();
  const identityPlan = { label: 'module-identity', query: uniqueLines([descriptive, capabilities, implementationQuery]).join('\n').slice(0, 8_000), views: ['summary'] as const, weight: 1 };
  const symbolPlan = { label: 'module-symbols', query: symbolQuery, views: ['symbol'] as const, weight: 0.7 };
  return {
    plans: recallMode === 'identity' ? [
      // Experimental low-fanout path: module summaries carry the reviewed module
      // identity and artifact link, so one hybrid query per repository is enough.
      identityPlan,
    ] : recallMode === 'identity-symbol' ? [identityPlan, symbolPlan] : [
      { label: 'module-behavior', query: behaviorQuery, views: ['summary'], weight: 1 },
      { label: 'module-implementation', query: implementationQuery, views: ['source-fragment'], weight: 0.9 },
      { label: 'module-symbols', query: symbolQuery, views: ['symbol'], weight: 0.7 },
    ],
    // User input refines the ranking over the stable module recall. It does not
    // create another database fan-out or replace the module's own summary.
    rerankQuery: uniqueLines([
      '按模块的实际职责与可复用行为排序，跨语言实现同等考虑。实现任务优先生产实现；契约任务优先相应接口与数据模型。通用基础设施、构建入口和测试辅助不能仅因同名或通用词匹配排在前面。',
      '前四个候选应尽量覆盖本次检索目标中的不同能力；已经覆盖的能力不应由近重复模块重复占位。只从有相关实现证据的候选中选取，不为多样性选择无关代码。',
      requirement.trim() ? `Priority user requirement:\n${requirement.trim()}\n以上具体需求是本次排序的首要目标。先排列直接提供这些行为的模块，再排列只满足模块其他职责的候选。` : undefined,
      `${requirement.trim() ? 'Module responsibilities (context)' : 'Primary module responsibilities'}:\n${descriptive.slice(0, 5_000)}`,
      target.module?.coreApis?.length ? `Target API responsibilities (each may need a complementary reference):\n${target.module.coreApis.slice(0, 16).map(api => `- ${api.slice(0, 300)}`).join('\n')}` : undefined,
      `Auxiliary code keywords: ${capabilities}`,
    ])
      .join('\n').slice(0, 32_000),
  };
}
