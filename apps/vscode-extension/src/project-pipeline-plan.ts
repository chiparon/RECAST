import { indexModuleHierarchy, type Language, type ProjectModule, type StructuralIndex } from '@forexplore/contracts';
import { orderModulesByDependency } from './module-order';
import type { ProjectPipelineModule } from './project-pipeline-types';

const source = /\.(java|kt|kts|cs|ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|cc|cpp|h|hpp)$/i;
const testDirectory = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/i;
const testName = /(?:Test|Tests|Spec)\.[^.]+$|\.(?:test|spec)\.[^.]+$/;

/** Every production file has one writer. Parent aggregates never run over their children again. */
export function buildProjectPipelineModules(index: StructuralIndex, projectId: string, proposal: ProjectModule[], protectedFiles: readonly string[] = []): ProjectPipelineModule[] {
  const hierarchy = indexModuleHierarchy(proposal);
  const production = index.files.filter(file => file.projectId === projectId && source.test(file.relativePath) && file.role !== 'test'
    && !testDirectory.test(file.relativePath) && !testName.test(file.relativePath) && !protectedFiles.includes(file.relativePath));
  const paths = new Set(production.map(file => file.relativePath));
  const owners = new Map<string, string>();
  const ranked = [...proposal].sort((a, b) => (hierarchy.depthById.get(b.id) ?? 0) - (hierarchy.depthById.get(a.id) ?? 0) || a.sourceFiles.length - b.sourceFiles.length);
  for (const module of ranked) for (const file of module.sourceFiles) if (paths.has(file) && !owners.has(file)) owners.set(file, module.id);
  const unassigned = production.filter(file => !owners.has(file.relativePath));
  const units = proposal.map(module => ({ ...module, sourceFiles: production.filter(file => owners.get(file.relativePath) === module.id).map(file => file.relativePath) })).filter(module => module.sourceFiles.length);
  if (unassigned.length) units.push({ id: 'pipeline-unassigned', name: '未归属生产代码', kind: 'feature', description: '根据需求完成其余生产文件，保持既有公开接口。', sourceFiles: unassigned.map(file => file.relativePath), symbolKeys: [], dependsOn: units.map(module => module.id), evidenceIds: [] });
  const byId = new Map(units.map(module => [module.id, module]));
  // Resolve aggregate dependencies to their descendant file owners.
  const dependencies = new Map(units.map(module => [module.id, [...new Set(module.dependsOn.flatMap(id => {
    if (byId.has(id)) return [id];
    return hierarchy.sourceFiles(id).files.flatMap(file => owners.has(file) ? [owners.get(file)!] : []);
  }).filter(id => id !== module.id))]]));
  // Merge each strongly connected component, so a cycle can be planned and compiled as one unit.
  const pending = new Set(units.map(module => module.id)), groups: string[][] = [];
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false; seen.add(from);
    return (dependencies.get(from) ?? []).some(next => reaches(next, to, seen));
  };
  for (const unit of units) {
    if (!pending.has(unit.id)) continue;
    const members = [...pending].filter(id => reaches(unit.id, id) && reaches(id, unit.id));
    groups.push(members); members.forEach(id => pending.delete(id));
  }
  const groupOf = new Map(groups.flatMap(group => group.map(id => [id, group[0]!] as const)));
  return orderModulesByDependency(groups.map(group => {
    const modules = group.map(id => byId.get(id)!);
    const files = [...new Set(modules.flatMap(module => module.sourceFiles))];
    if (files.length > 128) throw new Error(`模块 ${modules[0]!.name} 含 ${files.length} 个生产文件，超过单次生成上限 128；请细化模块划分。`);
    const name = modules.map(module => module.name).join(' + '), id = group[0]!;
    const languageName = modules[0]!.language ?? production.find(file => file.relativePath === files[0])?.languageId ?? 'unknown';
    const language = ({ java: 'Java', csharp: 'C#', 'c#': 'C#', typescript: 'TypeScript', javascript: 'TypeScript', python: 'Python', rust: 'Rust', go: 'Go' } as Record<string, Language>)[languageName.toLowerCase()];
    if (!language) throw new Error(`当前生成契约尚不支持目标语言：${languageName}`);
    const dependsOn = [...new Set(group.flatMap(member => dependencies.get(member) ?? []).map(dependency => groupOf.get(dependency)!).filter(dependency => dependency !== id))];
    return { id, name, dependsOn, status: 'pending' as const, candidates: [],
      target: { id: `project-module:${id}`, kind: 'module' as const, name, path: files[0]!, language,
        signature: modules.flatMap(module => module.coreApis ?? []).join('\n'), documentation: modules.map(module => module.description).join('\n'),
        module: { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, projectId, sourceFiles: files,
          coreApis: modules.flatMap(module => module.coreApis ?? []), dependsOn } },
    };
  }));
}
