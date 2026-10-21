/**
 * Depth probe for the Code2Code acceptance check.
 *
 * capture.mts freezes `topK: 5`, so a candidate that merely slides down the
 * ranking looks identical to a candidate the refactor dropped. This probe
 * re-runs the same four Code2Code cases at a deeper `topK` so a displaced
 * candidate can be distinguished from a lost one.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import type { ModuleTarget } from '@forexplore/contracts';
import { ModuleImplementationSearchService, SeekDbIndexStore } from '@forexplore/code-intelligence-service';

const { values } = parseArgs({ options: {
  database: { type: 'string', default: 'forexplore_javafileupload_flow_20260913' },
  output: { type: 'string', default: 'tmp/recall-baseline/c2c-depth.json' },
  snapshot: { type: 'string', default: 'tmp/recall-baseline/after.json' },
  'top-k': { type: 'string', default: '10' },
} });
const topK = Number(values['top-k']);
const database = values.database!;
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 8 });
const store = new SeekDbIndexStore({
  host: '127.0.0.1', port: 2881, user: 'root', password: '', database, vectorDimension: 384,
  embedding: { url: 'http://127.0.0.1:4021/v1/embeddings', apiKey: '',
    model: 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78', queryPrefix: 'query: ', documentPrefix: 'passage: ' },
}, pool);
const moduleSearch = new ModuleImplementationSearchService(store);

interface Scope { repositoryId: string; analysisRevision: string; projectId?: string }
const repositories = await store.listRepositories();
const byName = new Map(repositories.map((repository) => [repository.displayName, repository]));
const scopeOf = async (displayName: string): Promise<Scope> => {
  const repository = byName.get(displayName);
  assert(repository?.activeRevision, `Repository ${displayName} has no active revision.`);
  const projects = await store.listProjects({ repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision });
  assert(projects.length > 0, `Repository ${displayName} has no project.`);
  return { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, projectId: projects[0]!.projectId };
};
const target = await scopeOf('target-repo');
const history = await Promise.all(['commons-fileupload-csharp', 'commons-fileupload-python', 'commons-fileupload-ts'].map(scopeOf));

const revisionIds = (await store.listRevisions(target.repositoryId).catch(() => []))
  .map((revision) => revision.analysisRevision ?? (revision as unknown as { analysis_revision: string }).analysis_revision);
const moduleArtifacts = (await Promise.all([target.analysisRevision, ...revisionIds]
  .map((analysisRevision) => store.listModuleArtifacts({ repositoryId: target.repositoryId, analysisRevision })))).flat();
const moduleTargetOf = (name: string): ModuleTarget => {
  for (const artifact of moduleArtifacts) {
    const payload = artifact.payload as { proposal?: { modules?: Array<Record<string, any>> } } | undefined;
    for (const module of payload?.proposal?.modules ?? []) {
      if (module.name !== name) continue;
      return {
        id: `module://${module.id}`, name: module.name, kind: 'module', path: module.sourceFiles[0], language: 'Java',
        signature: (module.coreApis ?? []).join('\n'), documentation: [module.purpose, module.description].filter(Boolean).join('\n'),
        module: { repositoryId: target.repositoryId, analysisRevision: target.analysisRevision, projectId: target.projectId,
          moduleId: module.id, purpose: module.purpose, description: module.description,
          sourceFiles: module.sourceFiles ?? [], coreApis: module.coreApis ?? [], dependsOn: module.dependsOn ?? [] },
      };
    }
  }
  throw new Error(`Module ${name} is not in the target artifact.`);
};
const targetIndex = await store.getStructuralIndex(target);
assert(targetIndex, 'The target repository has no structural index.');
const symbolTarget = async (kind: 'class' | 'function', qualifiedName: string): Promise<ModuleTarget> => {
  const symbol = targetIndex.symbols.find((item) => item.qualifiedName === qualifiedName)
    ?? targetIndex.symbols.find((item) => item.qualifiedName?.endsWith(`.${qualifiedName}`) && (kind === 'class' ? ['class', 'interface'].includes(item.kind) : ['method', 'function'].includes(item.kind)));
  assert(symbol, `Symbol ${qualifiedName} was not found in the target index.`);
  return { id: `symbol://${symbol.symbolId}`, name: symbol.name, kind, path: symbol.relativePath, language: 'Java',
    signature: symbol.signature ?? symbol.name };
};

const cases: Array<{ name: string; target: ModuleTarget }> = [
  { name: 'module-multipart', target: moduleTargetOf('Multipart 流解析') },
  { name: 'module-disk', target: moduleTargetOf('磁盘上传项存储') },
  { name: 'class-fileuploadbase', target: await symbolTarget('class', 'org.apache.commons.fileupload.FileUploadBase') },
  { name: 'function-parserequest', target: await symbolTarget('function', 'org.apache.commons.fileupload.FileUploadBase.parseRequest') },
];
const snapshot = JSON.parse(await readFile(path.resolve(values.snapshot!), 'utf8')) as {
  code2code: Array<{ name: string; candidates: Array<{ id: string }> }>;
};
const frozen = new Map(snapshot.code2code.map((entry) => [entry.name, entry.candidates.map((candidate) => candidate.id)]));

const probe: Array<Record<string, unknown>> = [];
for (const entry of cases) {
  const candidates = await moduleSearch.search({ target: entry.target, requirement: '恢复 multipart 分段流读取实现', topK,
    repositoryIds: history.map((scope) => scope.repositoryId) }, AbortSignal.timeout(120_000));
  const rankedIds = candidates.map((candidate) => candidate.id);
  const frozenIds = frozen.get(entry.name) ?? [];
  probe.push({
    name: entry.name,
    topK,
    returned: candidates.length,
    candidates: candidates.map((candidate, rank) => ({ rank, id: candidate.id, title: candidate.title, repository: candidate.repository,
      path: candidate.path, overall: Number(candidate.score.overall.toFixed(6)), semantic: Number(candidate.score.semantic.toFixed(6)),
      moduleId: candidate.sourceModule?.moduleId ?? null })),
    frozenTopK: frozenIds.length,
    frozenCandidatesStillPresent: frozenIds.filter((id) => rankedIds.includes(id)).length,
    frozenCandidatesRanked: frozenIds.map((id) => ({ id, rank: rankedIds.indexOf(id) })),
    displaced: frozenIds.filter((id) => rankedIds.includes(id) && rankedIds.indexOf(id) >= frozenIds.length)
      .map((id) => ({ id, rank: rankedIds.indexOf(id), title: candidates.find((candidate) => candidate.id === id)?.title })),
  });
}
await mkdir(path.dirname(path.resolve(values.output!)), { recursive: true });
await writeFile(path.resolve(values.output!), `${JSON.stringify({ label: `depth-${topK}`, generatedAt: new Date().toISOString(), database,
  frozenSnapshot: values.snapshot, probe }, null, 2)}\n`, 'utf8');
console.info(JSON.stringify(probe.map((entry) => ({
  name: entry.name, returned: entry.returned, frozenTopK: entry.frozenTopK,
  frozenCandidatesStillPresent: entry.frozenCandidatesStillPresent, displaced: entry.displaced,
})), null, 2));
await store.close();
