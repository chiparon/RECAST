import { expect, it } from 'vitest';
import type { ProjectModule, StructuralIndex } from '@forexplore/contracts';
import { buildProjectPipelineModules } from './project-pipeline-plan';

const module = (id: string, sourceFiles: string[], dependsOn: string[] = [], parentId?: string): ProjectModule => ({ id, name: id, kind: 'feature', sourceFiles, dependsOn,
  description: id, evidenceIds: [], symbolKeys: [], ...(parentId ? { parentId } : {}) });
const index = (paths: string[]) => ({ repositoryId: 'repo', analysisRevision: 'revision', files: paths.map(relativePath => ({ relativePath, projectId: 'project', languageId: 'java', role: relativePath.includes('/test/') ? 'test' : 'source' })) }) as StructuralIndex;

it('assigns each production file once, merges cycles and includes unassigned production files', () => {
  const data = index(['a.java', 'b.java', 'shared.java', 'unassigned.java', 'Latest.java', 'src/test/Criteria.java']);
  const modules = [module('parent', []), module('a', ['a.java', 'shared.java'], ['b'], 'parent'), module('b', ['b.java'], ['a'], 'parent'), module('tests', ['src/test/Criteria.java'])];
  const result = buildProjectPipelineModules(data, 'project', modules, ['src/test/Criteria.java']);
  expect(result).toHaveLength(2);
  expect(result[0]!.target.module!.sourceFiles.sort()).toEqual(['a.java', 'b.java', 'shared.java']);
  expect(result[1]!.target.module!.sourceFiles).toEqual(['unassigned.java', 'Latest.java']);
  expect(result.flatMap(item => item.target.module!.sourceFiles)).toHaveLength(5);
});
it('orders prerequisites before consumers and fails explicitly for a generation unit beyond the supported scope', () => {
  const data = index(['api.java', 'contract.java']);
  expect(buildProjectPipelineModules(data, 'project', [module('api', ['api.java'], ['contract']), module('contract', ['contract.java'])]).map(item => item.id)).toEqual(['contract', 'api']);
  const files = Array.from({ length: 129 }, (_, i) => `${i}.java`);
  expect(() => buildProjectPipelineModules(index(files), 'project', [module('huge', files)])).toThrow('128');
});
