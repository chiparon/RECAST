import { describe, expect, it } from 'vitest';
import type { LanguageId, ProjectRecord } from '@forexplore/contracts';
import { createProjectLookup, discoverProjects, projectForPath } from './project-discovery.js';

describe('project discovery', () => {
  it('keeps CMake subdirectories in their buildable root and recognises independent nested projects', () => {
    const { projects } = discoverProjects({ repositoryId: 'native', analysisRevision: 'r1', files: [
      { relativePath: 'CMakeLists.txt', content: 'project(Shop LANGUAGES C CXX)\nadd_subdirectory(src)' },
      { relativePath: 'src/CMakeLists.txt', content: 'add_library(price price.cxx)' },
      { relativePath: 'src/price.cxx', content: '', languageId: 'cpp' },
      { relativePath: 'tools/CMakeLists.txt', content: 'project(Tool LANGUAGES C)' },
    ] });
    expect(projects.filter(project => project.kind === 'cmake').map(project => project.relativePath).sort()).toEqual(['', 'tools']);
    expect(projectForPath(projects, 'src/price.cxx', 'cpp')?.relativePath).toBe('');
    expect(projectForPath(projects, 'include/price.h', 'c')?.kind).toBe('cmake');
  });
  it('recognizes repository-relative build/package boundaries and C# project references', () => {
    const result = discoverProjects({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'java/pom.xml', content: '<project />' },
        { relativePath: 'gradle/build.gradle.kts', content: 'plugins {}' },
        { relativePath: 'dotnet/App/App.csproj', content: '<Project><ItemGroup><ProjectReference Include="../Core/Core.csproj" /></ItemGroup></Project>' },
        { relativePath: 'dotnet/Core/Core.csproj', content: '<Project />' },
        { relativePath: 'web/package.json', content: '{"name":"web"}' },
        { relativePath: 'python/pyproject.toml', content: '[project]\nname = "demo"' },
        { relativePath: 'go/go.mod', content: 'module example.com/demo' },
        { relativePath: 'rust/Cargo.toml', content: '[package]\nname = "demo"' },
      ],
    });

    expect(result.projects.map((project) => project.kind).sort()).toEqual([
      'cargo', 'dotnet', 'dotnet', 'go', 'gradle', 'maven', 'node', 'python',
    ]);
    expect(result.projects.every((project) =>
      project.repositoryId === 'history-one' && project.analysisRevision === 'revision-a',
    )).toBe(true);
    expect(result.projectReferences).toEqual([
      expect.objectContaining({
        sourceRelativePath: 'dotnet/App/App.csproj',
        targetReference: '../Core/Core.csproj',
      }),
    ]);
  });

  it('selects the deepest language-compatible boundary for a file', () => {
    const result = discoverProjects({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'package.json', content: '{}' },
        { relativePath: 'packages/widget/package.json', content: '{}' },
      ],
    });
    const project = projectForPath(result.projects, 'packages/widget/src/View.ts', 'typescript');
    expect(project?.relativePath).toBe('packages/widget');
    expect(projectForPath(result.projects, 'packages/widget/src/View.py', 'python')).toBeUndefined();
  });

  it('preserves boundary, language, and tie-breaking rules in a reusable project lookup', () => {
    const project = (projectId: string, relativePath: string, languageIds: LanguageId[], kind = 'node'): ProjectRecord => ({
      repositoryId: 'history-one', analysisRevision: 'revision-a', projectId, relativePath,
      kind, languageIds, displayName: projectId, manifestPaths: [], sourceRoots: [], testRoots: [],
    });
    const projects = [
      project('root', '', ['java', 'typescript']),
      project('directory', '', ['python', 'java', 'typescript'], 'directory'),
      project('nested-z', 'packages/widget', ['typescript']),
      project('nested-a', './packages\\widget', ['typescript']),
      project('nested-directory', 'packages/widget', ['typescript'], 'directory'),
      project('python', 'packages/widget/python/', ['python']),
      project('trailing-root', 'trailing/', ['java']),
      project('plain-root', 'trailing', ['java']),
    ];
    const find = createProjectLookup(projects);
    const cases: Array<[string, LanguageId | undefined, string | undefined]> = [
      ['packages/widget/src/View.ts', 'typescript', 'nested-a'],
      ['./packages\\widget//src/View.ts', 'typescript', 'nested-a'],
      ['packages/widget', undefined, 'nested-a'],
      ['packages/widget/python/script.py', 'python', 'python'],
      ['packages/widget/python/Use.java', 'java', 'root'],
      ['packages/widgetish/View.ts', 'typescript', 'root'],
      ['packages/widget/script.py', 'python', 'directory'],
      ['trailing/Use.java', 'java', 'trailing-root'],
      ['unclaimed.rs', 'rust', undefined],
      ['', undefined, 'root'],
    ];
    for (const [relativePath, languageId, expected] of cases) {
      expect(find(relativePath, languageId)?.projectId, relativePath).toBe(expected);
      expect(projectForPath(projects, relativePath, languageId)?.projectId, relativePath).toBe(expected);
    }
    expect(projects.map(({ projectId }) => projectId)).toEqual([
      'root', 'directory', 'nested-z', 'nested-a', 'nested-directory', 'python', 'trailing-root', 'plain-root',
    ]);
  });

  it('retains explicit local build/package references for every v1 project ecosystem', () => {
    const result = discoverProjects({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'maven/pom.xml', content: '<project><modules><module>core</module></modules></project>' },
        { relativePath: 'maven/core/pom.xml', content: '<project />' },
        { relativePath: 'gradle/settings.gradle.kts', content: 'include(\":core\")' },
        { relativePath: 'gradle/core/build.gradle.kts', content: 'plugins {}' },
        { relativePath: 'node/app/package.json', content: '{"dependencies":{"@demo/core":"workspace:*","other":"file:../other"}}' },
        { relativePath: 'node/core/package.json', content: '{"name":"@demo/core"}' },
        { relativePath: 'node/other/package.json', content: '{"name":"other"}' },
        { relativePath: 'cargo/app/Cargo.toml', content: '[dependencies]\ncore = { path = "../core" }' },
        { relativePath: 'cargo/core/Cargo.toml', content: '[package]\nname = "core"' },
        { relativePath: 'go/app/go.mod', content: 'module demo/app\nreplace demo/core => ../core' },
        { relativePath: 'go/core/go.mod', content: 'module demo/core' },
        { relativePath: 'python/app/pyproject.toml', content: '[tool.poetry.dependencies]\ncore = { path = "../core" }' },
        { relativePath: 'python/core/pyproject.toml', content: '[project]\nname = "core"' },
      ],
    });

    const pairs = result.projectReferences.map((reference) =>
      `${reference.sourceRelativePath}->${reference.targetReference}`,
    );
    expect(pairs).toEqual(expect.arrayContaining([
      'maven/pom.xml->core/pom.xml',
      'gradle/settings.gradle.kts->core/build.gradle.kts',
      'node/app/package.json->../core/package.json',
      'node/app/package.json->../other/package.json',
      'cargo/app/Cargo.toml->../core/Cargo.toml',
      'go/app/go.mod->../core/go.mod',
      'python/app/pyproject.toml->../core/pyproject.toml',
    ]));
  });
});
