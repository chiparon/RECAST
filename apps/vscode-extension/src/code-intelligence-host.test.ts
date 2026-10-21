import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryStaticAnalysis } from '@forexplore/contracts';
import {
  CodeIntelligenceHost,
  boundHistoryViewFiles,
  HISTORY_VIEW_MAX_BYTES,
  HISTORY_VIEW_MAX_FILES,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  type CodeIntelligenceRuntime,
  type RepositoryIdentityStore,
} from './code-intelligence-host';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryIdentityStore implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function createRuntime(options: { languageId?: 'typescript' | 'java' | 'csharp' } = {}):
  CodeIntelligenceRuntime & { registeredBindings: Array<Record<string, unknown>> } {
  const repositories = new Map<string, any>();
  const revisions = new Map<string, any>();
  const indexes = new Map<string, any>();
  const artifacts = new Map<string, any[]>();
  const registeredBindings: Array<Record<string, unknown>> = [];
  const languageId = options.languageId ?? 'typescript';
  const relativePath = languageId === 'java'
    ? 'src/Example.java'
    : languageId === 'csharp'
      ? 'src/Example.cs'
      : 'src/example.ts';
  let scanCount = 0;
  const key = (scope: { repositoryId: string; analysisRevision: string }) =>
    `${scope.repositoryId}\u0000${scope.analysisRevision}`;
  const store = {
    async getRevision(scope: { repositoryId: string; analysisRevision: string }) {
      return revisions.get(key(scope)) ?? null;
    },
    async getStructuralIndex(scope: { repositoryId: string; analysisRevision: string }) {
      return indexes.get(key(scope)) ?? null;
    },
    async listRevisions(repositoryId: string) {
      return [...revisions.values()]
        .filter((revision) => revision.repositoryId === repositoryId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async listModuleArtifacts(scope: { repositoryId: string; analysisRevision: string }) {
      return [...(artifacts.get(key(scope)) ?? [])];
    },
    async putModuleArtifact(artifact: any) {
      const entries = artifacts.get(key(artifact)) ?? [];
      entries.push({ ...artifact });
      artifacts.set(key(artifact), entries);
    },
  };
  const registry = {
    async list() { return [...repositories.values()]; },
    async unregister(repositoryId: string) { repositories.delete(repositoryId); },
    async get(repositoryId: string) {
      return repositories.get(repositoryId) ?? null;
    },
    async setAnalysisStatus(repositoryId: string, analysisStatus: string) {
      const repository = { ...repositories.get(repositoryId), analysisStatus };
      repositories.set(repositoryId, repository);
      return repository;
    },
    async register(input: any) {
      const samePath = [...repositories.values()].find((repository) => repository.localPath === input.localPath);
      const current = samePath ?? {
        repositoryId: input.repositoryId,
        localPath: input.localPath,
        createdAt: '2026-01-01T00:00:00.000Z',
        activeRevision: null,
        analysisStatus: 'registered',
      };
      const next = {
        ...current,
        displayName: input.displayName ?? path.basename(input.localPath),
        role: input.role,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      repositories.set(next.repositoryId, next);
      return next;
    },
  };
  const coordinator = {
    async run(request: { repositoryId: string }) {
      const repository = repositories.get(request.repositoryId);
      if (!repository) throw new Error('unknown repository');
      scanCount += 1;
      const scope = { repositoryId: request.repositoryId, analysisRevision: `revision-${scanCount}` };
      const priorRevision = repository.activeRevision;
      if (priorRevision) {
        const prior = revisions.get(key({ repositoryId: request.repositoryId, analysisRevision: priorRevision }));
        if (prior) prior.status = 'superseded';
        const priorArtifacts = artifacts.get(key({ repositoryId: request.repositoryId, analysisRevision: priorRevision })) ?? [];
        artifacts.set(key({ repositoryId: request.repositoryId, analysisRevision: priorRevision }), priorArtifacts.map((artifact) => (
          artifact.status === 'current' ? { ...artifact, status: 'stale' } : artifact
        )));
      }
      const index = {
        ...scope,
        analysisHash: `analysis-${scanCount}`,
        projects: [],
        files: [{
          ...scope,
          fileId: `file-${scanCount}`,
          relativePath,
          languageId,
          role: 'source',
          sha256: `sha-${scanCount}`,
          sizeBytes: 1,
          parseStatus: 'parsed',
        }],
        symbols: [],
        dependencyEdges: [],
        diagnostics: [],
      };
      revisions.set(key(scope), {
        ...scope,
        status: 'ready',
        analysisHash: index.analysisHash,
        indexerVersion: 'test',
        createdAt: `2026-01-01T00:00:0${scanCount}.000Z`,
      });
      indexes.set(key(scope), index);
      repositories.set(request.repositoryId, {
        ...repository,
        activeRevision: scope.analysisRevision,
        analysisStatus: 'ready',
        updatedAt: `2026-01-01T00:00:0${scanCount}.000Z`,
      });
    },
  };
  const queryPort = {
    async listRepositories() {
      return {
        repositories: [...repositories.values()].map(({ localPath: _localPath, ...repository }) => ({
          ...repository,
          analysisRevision: repository.activeRevision,
        })),
      };
    },
    async getRepositoryOverview(scope: { repositoryId: string; analysisRevision: string }) {
      const repository = repositories.get(scope.repositoryId);
      const revision = revisions.get(key(scope));
      const index = indexes.get(key(scope));
      if (!repository || !revision || !index) throw new Error('unknown revision');
      const { localPath: _localPath, ...safeRepository } = repository;
      return {
        overview: {
          ...scope,
          evidenceId: `revision:${scope.analysisRevision}`,
          provider: 'tree-sitter',
          confidence: 1,
          evidenceLevel: 'structural',
          relativePath: null,
          sourceRange: null,
          value: {
            repository: safeRepository,
            revision,
            projectCount: 0,
            fileCount: index.files.length,
            symbolCount: 0,
            dependencyCount: 0,
            diagnosticCount: 0,
            languages: [{ languageId, capabilityLevel: 'structural', fileCount: index.files.length }],
          },
        },
      };
    },
    async listProjects() {
      return { projects: [] };
    },
  };
  return {
    store,
    registry,
    coordinator,
    javaCsharpSpecializedProvider: {
      async register(binding) {
        registeredBindings.push({ ...binding });
      },
    },
    queryPort: queryPort as any,
    registeredBindings,
    async close() {},
  };
}

it('bounds history evidence views while retaining the first source file', () => {
  const files = ['main.cs', 'large.cs', ...Array.from({ length: 20 }, (_, index) => `small-${index}.cs`)];
  const sizes = new Map([
    ['main.cs', 10], ['large.cs', HISTORY_VIEW_MAX_BYTES],
    ...Array.from({ length: 20 }, (_, index) => [`small-${index}.cs`, 10] as const),
  ]);
  const selected = boundHistoryViewFiles(files, sizes);
  expect(selected[0]).toBe('main.cs');
  expect(selected).not.toContain('large.cs');
  expect(selected.length).toBeLessThanOrEqual(HISTORY_VIEW_MAX_FILES);
  expect(selected.reduce((sum, file) => sum + sizes.get(file)!, 0)).toBeLessThanOrEqual(HISTORY_VIEW_MAX_BYTES);
});

it('prioritizes target-related history files before applying the byte budget', () => {
  const files = ['Entry.cs', 'UnrelatedLarge.cs', 'WorkflowDispatcher.cs', 'RetryPolicy.cs', 'UnrelatedSmall.cs'];
  const sizes = new Map([
    ['Entry.cs', 10], ['UnrelatedLarge.cs', 90], ['WorkflowDispatcher.cs', 20],
    ['RetryPolicy.cs', 20], ['UnrelatedSmall.cs', 10],
  ]);
  const selected = boundHistoryViewFiles(files, sizes, 3, 50, ['WorkflowDispatcher', 'RetryPolicy']);
  expect(selected).toEqual(['Entry.cs', 'WorkflowDispatcher.cs', 'RetryPolicy.cs']);
});

it('keeps the byte limit even when the first historical source is oversized', () => {
  const files = ['HugeEngine.java', 'DispatchCommand.java', 'RetryPolicy.java'];
  const sizes = new Map([['HugeEngine.java', HISTORY_VIEW_MAX_BYTES + 1], ['DispatchCommand.java', 30], ['RetryPolicy.java', 30]]);
  expect(boundHistoryViewFiles(files, sizes)).toEqual(['DispatchCommand.java', 'RetryPolicy.java']);
});

it('retains a substantial implementation together with its public interface', () => {
  const files = ['OrderProcessor.cs', 'IOrderProcessor.cs', 'OrderResult.cs'];
  const sizes = new Map([['OrderProcessor.cs', 159_000], ['IOrderProcessor.cs', 15_000], ['OrderResult.cs', 5_000]]);
  expect(boundHistoryViewFiles(files, sizes)).toEqual(files);
});

it('materializes a bounded history view from a module containing more than 256 files', async () => {
  const target = await temporaryRepository('large-view-target');
  const history = await temporaryRepository('large-view-history');
  const files = ['src/example.ts', ...Array.from({ length: 300 }, (_, i) => `src/part-${i}.ts`)];
  await Promise.all(files.slice(1).map(file => writeFile(path.join(history, file), 'export function dispatch() { return true; }\n')));
  const runtime = createRuntime();
  const instance = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const state = await instance.synchronize({ repositories: [{ localPath: history, role: 'history' }] });
  const repository = state.presentation.repositories[0]!;
  const view = await instance.createHistoryModuleView({ workspaceRoot: target, repositoryId: repository.repositoryId,
    analysisRevision: repository.activeRevision!, moduleId: 'large-engine', sourceFiles: files, preferredFiles: [files.at(-1)!] });
  expect(view.files.length).toBe(HISTORY_VIEW_MAX_FILES);
  expect(view.files).toContain(files.at(-1));
  const manifest = JSON.parse(await readFile(path.join(view.root, 'manifest.json'), 'utf8'));
  expect(manifest.omittedFiles.length).toBe(files.length - HISTORY_VIEW_MAX_FILES);
  expect(manifest.files[0].path).toBe('src/example.ts');
  const makeWritable = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
  };
  await makeWritable(view.root);
  await instance.dispose();
});

it('merges selected modules with colliding file names and skips an unreadable candidate', async () => {
  const target = await temporaryRepository('view-target');
  const histories = await Promise.all(['a', 'b', 'c'].map(name => temporaryRepository(`view-${name}`)));
  const runtime = createRuntime();
  const instance = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const state = await instance.synchronize({ repositories: histories.map(localPath => ({ localPath, role: 'history' as const })) });
  const selections = state.presentation.repositories.map((repository, index) => ({
    repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision!, moduleId: `module-${index}`,
    name: `History ${index}`, sourceFiles: index === 1 ? ['missing.ts'] : ['src/example.ts'],
  }));
  for (const [index, history] of histories.entries()) await writeFile(path.join(history, 'src/example.ts'), `export const value = ${index};`);
  const view = await instance.createHistoryModulesView({ workspaceRoot: target, candidates: selections });
  expect(view.candidates?.map(candidate => candidate.prefix)).toEqual(['candidate-1', 'candidate-3']);
  expect(view.files).toEqual(['candidate-1/src/example.ts', 'candidate-3/src/example.ts']);
  expect(await readFile(path.join(view.root, 'source/candidate-1/src/example.ts'), 'utf8')).not.toEqual(await readFile(path.join(view.root, 'source/candidate-3/src/example.ts'), 'utf8'));
  expect(JSON.parse(await readFile(path.join(view.root, 'manifest.json'), 'utf8')).skippedCandidates).toHaveLength(1);
  expect(await readdir(path.dirname(view.root))).toEqual([view.runId]);
  await expect(instance.createHistoryModulesView({ candidates: [selections[0]!, selections[0]!] })).rejects.toThrow('不同的历史模块');
  await expect(instance.createHistoryModulesView({ candidates: [...selections, { ...selections[0]!, moduleId: 'fourth' }] })).rejects.toThrow('1～3');
  // Restore directory permissions so the fixture can remove its read-only view.
  const makeWritable = async (root: string): Promise<void> => {
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await makeWritable(path.join(root, entry.name));
  };
  await makeWritable(view.root);
  await instance.dispose();
});

async function temporaryRepository(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `forexplore-code-intelligence-${name}-`));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'example.ts'), 'export const example = 1;\n');
  return root;
}

it('recovers persisted repository identities when a host starts without its identity cache', async () => {
  const root = await temporaryRepository('reopen');
  const runtime = createRuntime();
  const initial = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const first = await initial.synchronize({ repositories: [{ localPath: root, role: 'target' }] });
  const repositoryId = first.presentation.repositories[0]!.repositoryId;
  const activeRevision = first.presentation.repositories[0]!.activeRevision;
  const register = runtime.registry.register.bind(runtime.registry);
  const guarded = vi.spyOn(runtime.registry, 'register').mockImplementation(async (request) => {
    if (request.repositoryId !== repositoryId) throw new Error('Persisted path belongs to another repository ID.');
    return register(request);
  });
  const persisted = await runtime.registry.list!();
  vi.spyOn(runtime.registry, 'list').mockResolvedValue(persisted.map(repository => ({ ...repository,
    localPath: process.platform === 'win32' ? repository.localPath.replace(/^([A-Za-z]):[\\/]/,
      (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/') : repository.localPath,
  })));
  const reopened = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, identityStore: new MemoryIdentityStore() });
  const result = await reopened.synchronize({ repositories: [{ localPath: root, role: 'target' }], scan: false });
  expect(guarded).toHaveBeenCalledWith(expect.objectContaining({ repositoryId }));
  expect(result.presentation.repositories).toEqual([expect.objectContaining({ repositoryId, activeRevision })]);
  expect(await reopened.activeScopeForPath(root)).toEqual({ repositoryId, analysisRevision: activeRevision });
  initial.dispose();
  reopened.dispose();
});

it('loads an explicitly bound cross-platform repository without rewriting its shared registry row', async () => {
  const indexedRoot = await temporaryRepository('preloaded-source-path');
  const currentPlatformRoot = await temporaryRepository('preloaded-current-path');
  const runtime = createRuntime();
  const firstHost = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const first = await firstHost.synchronize({ repositories: [{ localPath: indexedRoot, role: 'target' }] });
  const repositoryId = first.presentation.repositories[0]!.repositoryId;
  await runtime.registry.setAnalysisStatus!(repositoryId, 'indexing');
  const persistedBefore = await runtime.registry.get(repositoryId);
  const scan = vi.spyOn(runtime.coordinator, 'run');
  const register = vi.spyOn(runtime.registry, 'register');
  const preloadedHost = new CodeIntelligenceHost({
    runtimeFactory: async () => runtime,
    identityStore: new MemoryIdentityStore(),
  });

  const result = await preloadedHost.synchronize({
    repositories: [{ repositoryId, localPath: currentPlatformRoot, role: 'target' }],
    scan: false,
    repairStaleIndexing: true,
  });

  expect(result.presentation.repositories).toMatchObject([{ repositoryId, analysisStatus: 'ready' }]);
  expect(register).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(await runtime.registry.get(repositoryId)).toEqual(persistedBefore);
  expect(await preloadedHost.activeScopeForPath(currentPlatformRoot)).toEqual({
    repositoryId,
    analysisRevision: first.presentation.repositories[0]!.activeRevision,
  });
  preloadedHost.dispose();
  firstHost.dispose();
});

it('uses lightweight revision metadata for presentation and rejects mismatched hashes', async () => {
  const root = await temporaryRepository('metadata');
  const runtime = createRuntime();
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const initial = await host.synchronize({ repositories: [{ localPath: root, role: 'target' }] });
  const repository = initial.presentation.repositories[0]!;
  const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision! };
  const index = await runtime.store.getStructuralIndex(scope);
  runtime.store.getStructuralIndexMetadata = vi.fn(async () => ({ ...scope, analysisHash: index!.analysisHash }));
  const fullRead = vi.spyOn(runtime.store, 'getStructuralIndex').mockRejectedValue(new Error('Unexpected full index read.'));
  expect((await host.presentation()).repositories[0]?.revisions).toHaveLength(1);
  expect((await host.selectRevisionForDisplay(scope)).repositories[0]?.selectedRevision).toBe(scope.analysisRevision);
  expect(fullRead).not.toHaveBeenCalled();
  runtime.store.getStructuralIndexMetadata = vi.fn(async () => ({ ...scope, analysisHash: 'mismatched' }));
  expect((await host.presentation()).repositories[0]?.revisions).toHaveLength(0);
  await expect(host.selectRevisionForDisplay(scope)).rejects.toThrow('not available');
  host.dispose();
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function semanticQueryTestServer(options: { bearerToken?: string; queryPort: CodeIntelligenceRuntime['queryPort'] }) {
  return createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    if (options.bearerToken && authorization !== `Bearer ${options.bearerToken}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unauthorized.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(await options.queryPort.listRepositories()));
  });
}

function javaCompilerProbeAnalysis(sha256 = 'sha-1'): RepositoryStaticAnalysis {
  return {
    schemaVersion: '1.0',
    snapshotId: 'legacy-java-snapshot',
    contentHash: 'legacy-content',
    analyzerVersion: 'legacy-compiler-probe',
    createdAt: '2026-01-01T00:00:00.000Z',
    repository: {},
    files: [{
      path: 'src/Example.java',
      sha256,
      role: 'source',
      language: 'Java',
    }],
    symbols: [{
      id: 'java:Example',
      name: 'Example',
      qualifiedName: 'sample.Example',
      kind: 'class',
      language: 'Java',
      path: 'src/Example.java',
      range: { path: 'src/Example.java', startLine: 1, endLine: 2 },
    }],
    dependencies: [{
      id: 'java-edge',
      sourceSymbolId: 'java:Example',
      targetSymbolId: 'java:Example',
      sourcePath: 'src/Example.java',
      targetPath: 'src/Example.java',
      kind: 'invocation',
      internal: true,
      resolution: 'resolved',
      evidence: 'semantic',
      evidenceRanges: [{ path: 'src/Example.java', startLine: 1, endLine: 1 }],
      snapshotId: 'legacy-java-snapshot',
    }],
    diagnostics: [],
  };
}

describe('CodeIntelligenceHost', () => {
  it('retains the last repository snapshot during a failed status read and recovers on the next read', async () => {
    const root = await temporaryRepository('status-timeout');
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    try {
      const initial = await host.synchronize({ repositories: [{ localPath: root, role: 'history' }] });
      vi.spyOn(runtime.queryPort, 'getRepositoryOverview').mockRejectedValueOnce(new Error('query timeout'));
      const unavailable = await host.presentation();
      expect(unavailable).toMatchObject({ status: 'error', runtimeStatus: 'error', message: expect.stringContaining('上次读取') });
      expect(unavailable.repositories).toEqual(initial.presentation.repositories);
      expect(await host.presentation()).toMatchObject({ status: 'ready', runtimeStatus: 'ready', repositories: initial.presentation.repositories });
    } finally { host.dispose(); }
  });

  it('does not restore a removed repository or retain a read failure after synchronization recovers', async () => {
    const roots = await Promise.all(['retained', 'removed'].map(name => temporaryRepository(`status-${name}`)));
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    try {
      await host.synchronize({ repositories: roots.map(localPath => ({ localPath, role: 'history' as const })) });
      vi.spyOn(runtime.queryPort, 'listRepositories').mockRejectedValueOnce(new Error('query timeout'));
      const result = await host.synchronize({ repositories: [{ localPath: roots[0]!, role: 'history' }], scan: false });
      expect(result.presentation.status).toBe('error');
      expect(result.presentation.repositories.map(repository => repository.displayName)).toEqual([path.basename(roots[0]!)]);
      expect(await host.presentation()).toMatchObject({ status: 'ready', runtimeStatus: 'ready' });
    } finally { host.dispose(); }
  });

  it('keeps current import progress when a status read falls back to an older snapshot', async () => {
    const root = await temporaryRepository('live-status-timeout');
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const scanning = new Promise<void>(resolve => { started = resolve; });
    try {
      const repositories = [{ localPath: root, role: 'history' as const }];
      await host.synchronize({ repositories });
      const scan = runtime.coordinator.run.bind(runtime.coordinator);
      vi.spyOn(runtime.coordinator, 'run').mockImplementationOnce(async request => {
        request.onProgress?.({ stage: 'parse', completed: 2, total: 5 });
        started();
        await gate;
        return scan(request);
      });
      const refresh = host.synchronize({ repositories });
      await scanning;
      vi.spyOn(runtime.queryPort, 'listRepositories').mockRejectedValueOnce(new Error('query timeout'));
      expect((await host.presentation()).repositories[0]).toMatchObject({
        analysisStatus: 'indexing', indexing: { stage: 'parse', completed: 2, total: 5 },
      });
      release();
      expect((await refresh).presentation.repositories[0]?.indexing).toBeUndefined();
    } finally { release(); host.dispose(); }
  });

  it('retries initialization after a failed index migration on the next refresh', async () => {
    const runtime = createRuntime();
    const runtimeFactory = vi.fn().mockRejectedValueOnce(new Error('index migration failed')).mockResolvedValue(runtime);
    const host = new CodeIntelligenceHost({ runtimeFactory });
    await expect(host.synchronize({ repositories: [] })).resolves.toMatchObject({ presentation: { status: 'error' } });
    const refreshed = await host.synchronize({ repositories: [] });
    expect(refreshed.presentation.status).not.toBe('error');
    expect(runtimeFactory).toHaveBeenCalledTimes(2);
  });

  it('initializes configured history without scanning the surrounding target workspace', async () => {
    const target = await temporaryRepository('parent-workspace');
    const history = path.join(target, 'account-stream-rs');
    await mkdir(history);
    const runtime = createRuntime();
    const scan = vi.spyOn(runtime.coordinator, 'run');
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    const repositories = [{ localPath: target, role: 'target' as const }, { localPath: history, role: 'history' as const }];
    const result = await host.synchronize({ repositories, scanRoles: ['history'] });
    const indexedHistory = result.presentation.repositories.find((repository) => repository.role === 'history')!;
    const pendingTarget = result.presentation.repositories.find((repository) => repository.role === 'target')!;
    expect(indexedHistory.analysisStatus).toBe('ready');
    expect(pendingTarget.activeRevision).toBeNull();
    expect(scan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repositoryId: indexedHistory.repositoryId, mode: 'full' }));
    const refreshed = await host.synchronize({ repositories, scanRepositoryIds: [pendingTarget.repositoryId] });
    expect(refreshed.scannedRepositoryIds).toEqual([pendingTarget.repositoryId]);
    expect(refreshed.presentation.repositories.find((repository) => repository.role === 'target')?.analysisStatus).toBe('ready');
    host.dispose();
  });

  it('indexes an existing unindexed workspace when its path is explicitly added to history', async () => {
    const directory = await temporaryRepository('workspace-also-history');
    const runtime = createRuntime();
    const scan = vi.spyOn(runtime.coordinator, 'run');
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    await host.synchronize({ repositories: [{ localPath: directory, role: 'target' }], scanRoles: ['history'] });
    expect(scan).not.toHaveBeenCalled();
    const result = await host.synchronize({ repositories: [
      { localPath: directory, role: 'target' }, { localPath: directory, role: 'history' },
    ], scanRoles: ['history'], scanNewOnly: true });
    expect(scan).toHaveBeenCalledOnce();
    expect(result.presentation.repositories).toHaveLength(1);
    expect(result.presentation.repositories[0]).toMatchObject({ role: 'target', analysisStatus: 'ready' });
    host.dispose();
  });

  it('publishes completed repositories while a later repository is still scanning', async () => {
    const history = await temporaryRepository('a-history');
    const target = await temporaryRepository('z-target');
    const runtime = createRuntime();
    const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const scanning = new Promise<void>((resolve) => { started = resolve; });
    runtime.coordinator.run = async (request) => {
      if ((await runtime.registry.get(request.repositoryId))?.role === 'target') { started(); await gate; }
      return originalRun(request);
    };
    const onChange = vi.fn();
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, onChange });
    const synchronization = host.synchronize({ repositories: [
      { localPath: history, role: 'history' }, { localPath: target, role: 'target' },
    ] });
    await scanning;
    try {
      const view = await host.presentation();
      expect(view.repositories.find((repository) => repository.role === 'history')?.analysisStatus).toBe('ready');
      // Registration, queue publication, and scan lifecycle transitions remain
      // visible while the long-running target has not finished.
      expect(onChange).toHaveBeenCalledTimes(5);
      expect(view.repositories.find(repository => repository.role === 'target')?.indexing)
        .toMatchObject({ stage: 'queued', position: 2, count: 2 });
    } finally {
      release();
      await synchronization;
      host.dispose();
    }
  });

  it('initializes only newly added roots on settings saves and still refreshes existing roots explicitly', async () => {
    const first = await temporaryRepository('existing-history');
    const second = await temporaryRepository('new-history');
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, identityStore: new MemoryIdentityStore() });
    const repositories = [{ localPath: first, role: 'history' as const }];
    const initial = await host.synchronize({ repositories });
    const original = initial.presentation.repositories[0]!;
    repositories.push({ localPath: second, role: 'history' });
    const added = await host.synchronize({ repositories, scanNewOnly: true });
    expect(added.scannedRepositoryIds).toHaveLength(1);
    expect(added.scannedRepositoryIds).not.toContain(original.repositoryId);
    expect(added.presentation.repositories.find((item) => item.repositoryId === original.repositoryId)?.activeRevision)
      .toBe(original.activeRevision);
    expect((await host.synchronize({ repositories, scanNewOnly: true })).scannedRepositoryIds).toEqual([]);
    expect((await host.synchronize({ repositories, scanRepositoryIds: [original.repositoryId] })).scannedRepositoryIds)
      .toEqual([original.repositoryId]);
    await host.dispose();
  });

  it('forwards analysis controls and progress without refreshing the explorer for every batch', async () => {
    const directory = await temporaryRepository('progress-target');
    const runtime = createRuntime();
    const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
    const scan = vi.spyOn(runtime.coordinator, 'run').mockImplementation(async request => {
      request.onProgress?.({ stage: 'snapshot', completed: 0 });
      for (let completed = 1; completed <= 20; completed++) request.onProgress?.({ stage: 'parse', completed, total: 20 });
      request.onProgress?.({ stage: 'search-projection', completed: 0, total: 10 });
      return originalRun(request);
    });
    const onChange = vi.fn();
    const onProgress = vi.fn();
    const output = { appendLine: vi.fn() };
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, onChange, output });
    const controller = new AbortController();
    const repositories = [{ localPath: directory, displayName: 'progress-target', role: 'target' as const }];
    try {
      await host.synchronize({ repositories, signal: controller.signal, onProgress });
      expect(scan).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, reuseFailedProjection: true }));
      expect(onProgress.mock.calls.map(([progress]) => progress.stage)).toEqual(['snapshot', 'parse', 'parse', 'search-projection']);
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'progress-target', stage: 'parse', completed: 20, total: 20 }));
      // Queue start and cleanup add two lifecycle events, never one per batch.
      expect(onChange).toHaveBeenCalledTimes(5);
      expect((await host.presentation()).repositories[0]?.indexing).toBeUndefined();
      expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('正在生成检索向量'));
      await host.synchronize({ repositories });
      expect(scan).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'incremental', reuseFailedProjection: false }));
      const repositoryId = (await host.presentation()).repositories[0]!.repositoryId;
      await runtime.registry.setAnalysisStatus!(repositoryId, 'degraded');
      await host.synchronize({ repositories });
      expect(scan).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'incremental', reuseFailedProjection: false }));
      await host.synchronize({ repositories, forceFull: true });
      expect(scan).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'full', reuseFailedProjection: false }));
    } finally { host.dispose(); }
  });

  it.each([false, true])('retries a visible failed repository with scanNewOnly (existing revision: %s)', async (existingRevision) => {
    const directory = await temporaryRepository('retry-target');
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    const repositories = [{ localPath: directory, role: 'target' as const }];
    try {
      if (existingRevision) await host.synchronize({ repositories });
      const scan = vi.spyOn(runtime.coordinator, 'run').mockImplementationOnce(async request => {
        await runtime.registry.setAnalysisStatus!(request.repositoryId, 'failed');
        throw new Error('temporary projection timeout');
      });
      const failed = await host.synchronize({ repositories });
      expect(failed.failedRepositoryIds).toHaveLength(1);
      const retried = await host.synchronize({ repositories, scanNewOnly: true });
      expect(retried.scannedRepositoryIds).toEqual(failed.failedRepositoryIds);
      expect(retried.failedRepositoryIds).toEqual([]);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(scan).toHaveBeenLastCalledWith(expect.objectContaining({ reuseFailedProjection: true }));
      expect(retried.presentation.repositories[0]?.analysisStatus).toBe('ready');
    } finally { host.dispose(); }
  });

  it('keeps a committed revision ready and schedules its projects after late cancellation', async () => {
    const root = await temporaryRepository('late-cancel');
    const runtime = createRuntime();
    const controller = new AbortController();
    const run = runtime.coordinator.run.bind(runtime.coordinator);
    vi.spyOn(runtime.coordinator, 'run').mockImplementation(async request => {
      const result = await run(request);
      controller.abort(new DOMException('late cancellation', 'AbortError'));
      return result;
    });
    const project = { repositoryId: 'repo', analysisRevision: 'revision-1', projectId: 'project' };
    runtime.store.listProjects = vi.fn().mockResolvedValue([project]);
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    const schedule = vi.spyOn(host as any, 'scheduleProject').mockImplementation(() => undefined);
    try {
      const result = await host.synchronize({ repositories: [{ localPath: root, role: 'target' }], signal: controller.signal });
      expect(result.failedRepositoryIds).toEqual([]);
      expect(result.scannedRepositoryIds).toHaveLength(1);
      expect((await runtime.registry.get(result.scannedRepositoryIds[0]!))?.analysisStatus).toBe('ready');
      expect(schedule).toHaveBeenCalledWith(project);
    } finally { host.dispose(); }
  });

  it('propagates cancellation and leaves later repositories unscanned', async () => {
    const first = await temporaryRepository('a-cancelled');
    const second = await temporaryRepository('z-pending');
    const runtime = createRuntime();
    const controller = new AbortController();
    const reason = new DOMException('cancel indexing', 'AbortError');
    const scan = vi.spyOn(runtime.coordinator, 'run').mockImplementation(async request => {
      request.onProgress?.({ stage: 'snapshot', completed: 1 });
      controller.abort(reason);
      request.signal?.throwIfAborted();
    });
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
    try {
      await expect(host.synchronize({ repositories: [
        { localPath: first, displayName: 'a-cancelled', role: 'target' },
        { localPath: second, displayName: 'z-pending', role: 'history' },
      ], signal: controller.signal })).rejects.toBe(reason);
      expect(scan).toHaveBeenCalledTimes(1);
      const repositories = (await host.presentation()).repositories;
      expect(repositories.find(repository => repository.displayName === 'a-cancelled')?.analysisStatus).toBe('failed');
      expect(repositories.find(repository => repository.displayName === 'z-pending')?.analysisStatus).toBe('registered');
    } finally { host.dispose(); }
  });

  it('runs target and history roots through one host-owned revision chain without leaking local paths', async () => {
    const history = await temporaryRepository('history');
    const target = await temporaryRepository('target');
    const identityStore = new MemoryIdentityStore();
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
      identityStore,
      storageKind: 'memory',
    });

    const result = await host.synchronize({
      repositories: [
        { localPath: history, role: 'history', displayName: 'C:\\private\\Legacy' },
        { localPath: target, role: 'target', displayName: '/private/Target' },
      ],
    });

    expect(result.failedRepositoryIds).toEqual([]);
    expect(result.scannedRepositoryIds).toHaveLength(2);
    expect(result.presentation).toMatchObject({ status: 'ready', storage: 'memory' });
    expect(result.presentation.message).toContain('非持久');
    expect(result.presentation.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: 'Legacy', role: 'history', activeRevision: expect.any(String) }),
      expect.objectContaining({ displayName: 'Target', role: 'target', activeRevision: expect.any(String) }),
    ]));
    expect(result.presentation.repositories.every((repository) => (
      repository.languages.some((language) => (
        language.languageId === 'typescript' && language.capabilityLevel === 'structural'
      ))
    ))).toBe(true);
    expect(JSON.stringify(result.presentation)).not.toContain(history);
    expect(JSON.stringify(result.presentation)).not.toContain(target);
    expect(JSON.stringify(result.presentation)).not.toContain('private');

    const queryPort = await host.semanticQueryPort();
    const listed = await queryPort.listRepositories();
    expect(listed.repositories).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(history);
    expect(JSON.stringify(listed)).not.toContain(target);
  });

  it('binds a Java compiler-probe snapshot only when its source hashes match the active structural revision', async () => {
    const target = await temporaryRepository('java-binding');
    const runtime = createRuntime({ languageId: 'java' });
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
      identityStore: new MemoryIdentityStore(),
      storageKind: 'memory',
    });

    const indexed = await host.synchronize({
      repositories: [{ localPath: target, role: 'target', displayName: 'Java target' }],
    });
    const repository = indexed.presentation.repositories[0];
    expect(repository?.activeRevision).toBe('revision-1');

    const bound = await host.bindJavaCsharpCompilerProbeEvidence({
      localPath: target,
      analysis: javaCompilerProbeAnalysis(),
    });
    expect(bound).toEqual({
      status: 'bound',
      repositoryId: repository?.repositoryId,
      analysisRevision: 'revision-1',
    });
    expect(runtime.registeredBindings).toEqual([
      expect.objectContaining({
        repositoryId: repository?.repositoryId,
        analysisRevision: 'revision-1',
        analysisHash: 'analysis-1',
      }),
    ]);

    await expect(host.bindJavaCsharpCompilerProbeEvidence({
      localPath: target,
      analysis: javaCompilerProbeAnalysis('different-sha'),
    })).resolves.toMatchObject({ status: 'skipped' });
    expect(runtime.registeredBindings).toHaveLength(1);
  });

  it('marks a formerly current summary stale after activating a newer revision', async () => {
    const target = await temporaryRepository('summary');
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
      identityStore: new MemoryIdentityStore(),
      projectModuleArtifacts: async () => {},
    });

    const initial = await host.synchronize({
      repositories: [{ localPath: target, role: 'target' }],
    });
    const repository = initial.presentation.repositories[0];
    expect(repository?.activeRevision).toBeTruthy();
    const scope = {
      repositoryId: repository!.repositoryId,
      analysisRevision: repository!.activeRevision!,
    };
    const revision = await runtime.store.getRevision(scope);
    expect(revision).not.toBeNull();
    await host.publishModuleSummary({
      ...scope,
      analysisHash: revision!.analysisHash,
      planHash: 'sha256:approved-plan',
      payload: { approved: true },
    });
    expect((await host.presentation()).repositories[0]?.summary.status).toBe('current');

    const refreshed = await host.synchronize({
      repositories: [{ localPath: target, role: 'target' }],
    });
    const refreshedRepository = refreshed.presentation.repositories[0];
    expect(refreshedRepository?.activeRevision).not.toBe(scope.analysisRevision);
    expect(refreshedRepository?.summary).toMatchObject({
      status: 'stale',
      analysisRevision: scope.analysisRevision,
      analysisHash: revision!.analysisHash,
      planHash: 'sha256:approved-plan',
    });

    const selected = await host.selectRevisionForDisplay(scope);
    const selectedRepository = selected.repositories.find((item) => item.repositoryId === scope.repositoryId);
    expect((await runtime.registry.get(scope.repositoryId))?.activeRevision)
      .toBe(refreshedRepository?.activeRevision);
    expect(selectedRepository).toMatchObject({
      activeRevision: refreshedRepository?.activeRevision,
      selectedRevision: scope.analysisRevision,
      summary: {
        status: 'stale',
        analysisRevision: scope.analysisRevision,
      },
    });
    expect(selectedRepository?.revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ analysisRevision: refreshedRepository?.activeRevision, isActive: true, isSelected: false }),
      expect.objectContaining({ analysisRevision: scope.analysisRevision, status: 'superseded', isActive: false, isSelected: true }),
    ]));

    await expect(host.selectRevisionForDisplay({
      repositoryId: scope.repositoryId,
      analysisRevision: 'unknown-revision',
    })).rejects.toThrow(/not available for read-only queries/);
    expect((await runtime.registry.get(scope.repositoryId))?.activeRevision)
      .toBe(refreshedRepository?.activeRevision);
  });

  it('keeps SeekDB configuration in the host environment and validates it before composition', () => {
    expect(codeIntelligenceRuntimeOptionsFromEnvironment({})).toEqual({});
    expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({}, { allowInMemory: false }))
      .toThrow(/must be configured for a production/);
    expect(codeIntelligenceRuntimeOptionsFromEnvironment({
      CODE_INTELLIGENCE_SEEKDB_DATABASE: 'code_intelligence',
      CODE_INTELLIGENCE_SEEKDB_PORT: '2881',
    })).toMatchObject({
      seekdb: {
        host: '127.0.0.1',
        port: 2881,
        database: 'code_intelligence',
      },
    });
    expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({
      CODE_INTELLIGENCE_SEEKDB_DATABASE: 'invalid-name',
    })).toThrow(/SQL identifier/);
  });

  it('preserves model instructions and carries paired local reranker settings to the runtime', () => {
    const environment = { CODE_INTELLIGENCE_SEEKDB_DATABASE: 'module_models',
      CODE_INTELLIGENCE_EMBEDDING_URL: 'http://127.0.0.1:4021/v1/embeddings', CODE_INTELLIGENCE_EMBEDDING_MODEL: 'pinned-e5',
      CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX: 'query: ', CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX: 'passage: ',
      CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS: 'false', CODE_INTELLIGENCE_RERANK_URL: 'http://127.0.0.1:4022/v1/rerank',
      CODE_INTELLIGENCE_RERANK_MODEL: 'pinned-bge' };
    expect(codeIntelligenceRuntimeOptionsFromEnvironment(environment)).toMatchObject({
      seekdb: { embedding: { queryPrefix: 'query: ', documentPrefix: 'passage: ', supportsDimensions: false } },
      moduleReranker: { url: environment.CODE_INTELLIGENCE_RERANK_URL, model: 'pinned-bge', timeoutMs: 4000 },
    });
    expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({ ...environment, CODE_INTELLIGENCE_RERANK_MODEL: '' })).toThrow('both');
    expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({ ...environment, CODE_INTELLIGENCE_EMBEDDING_MODEL: '' })).toThrow('both');
  });

  it('configures database capacity independently of repository fan-out and rejects invalid limits', () => {
    const environment = { CODE_INTELLIGENCE_SEEKDB_DATABASE: 'code_intelligence',
      CODE_INTELLIGENCE_SEEKDB_CONNECTION_LIMIT: '12', CODE_INTELLIGENCE_SEARCH_SQL_CONCURRENCY: '6' };
    expect(codeIntelligenceRuntimeOptionsFromEnvironment(environment)).toMatchObject({
      seekdb: { connectionLimit: 12, searchQueryConcurrency: 6 },
    });
    expect(codeIntelligenceRuntimeOptionsFromEnvironment({ ...environment, CODE_INTELLIGENCE_SEARCH_SQL_CONCURRENCY: '0' }))
      .toMatchObject({ seekdb: { searchQueryConcurrency: 0 } });
    for (const value of ['0', '-1', '1.5', '65', 'invalid']) {
      expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({ ...environment, CODE_INTELLIGENCE_SEEKDB_CONNECTION_LIMIT: value }))
        .toThrow('CONNECTION_LIMIT');
    }
    for (const value of ['-1', '1.5', '33', 'invalid']) {
      expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({ ...environment, CODE_INTELLIGENCE_SEARCH_SQL_CONCURRENCY: value }))
        .toThrow('SQL_CONCURRENCY');
    }
  });
});

it('processes a saved configuration that arrives during a scan, including removals', async () => {
  const first = await temporaryRepository('queued-first');
  const second = await temporaryRepository('queued-second');
  const runtime = createRuntime();
  const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let count = 0;
  runtime.coordinator.run = async (request) => {
    if (++count === 1) { started(); await gate; }
    return originalRun(request);
  };
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const initial = host.synchronize({ repositories: [{ localPath: first, role: 'history' }] });
  await ready;
  const updated = host.synchronize({ repositories: [{ localPath: second, role: 'history' }] });
  release(); await initial;
  const result = await updated;
  expect(result.presentation.repositories).toHaveLength(1);
  expect(result.presentation.repositories[0]?.displayName).toBe(path.basename(second));
  expect(await runtime.registry.list!()).toHaveLength(2);
  expect(count).toBe(2);
});

it('keeps shared repository data while each host presents only its configured repositories', async () => {
  const first = await temporaryRepository('shared-first');
  const second = await temporaryRepository('shared-second');
  const runtime = createRuntime();
  const firstHost = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const secondHost = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });

  const firstResult = await firstHost.synchronize({ repositories: [{ localPath: first, role: 'target' }] });
  const secondResult = await secondHost.synchronize({ repositories: [{ localPath: second, role: 'target' }] });

  expect(firstResult.presentation.repositories.map((repository) => repository.displayName))
    .toEqual([path.basename(first)]);
  expect(secondResult.presentation.repositories.map((repository) => repository.displayName))
    .toEqual([path.basename(second)]);
  expect(await runtime.registry.list!()).toHaveLength(2);
  expect((await firstHost.presentation()).repositories.map((repository) => repository.displayName))
    .toEqual([path.basename(first)]);
});

it('keeps semantic listeners owned by their window and rejects an occupied explicit port', async () => {
  const firstRuntime = createRuntime();
  const secondRuntime = createRuntime();
  await firstRuntime.registry.register({ repositoryId: 'first-window', localPath: await temporaryRepository('first-port'), role: 'history' });
  await secondRuntime.registry.register({ repositoryId: 'second-window', localPath: await temporaryRepository('second-port'), role: 'target' });
  const firstHost = new CodeIntelligenceHost({
    runtimeFactory: async () => firstRuntime,
    semanticQueryServerFactory: semanticQueryTestServer,
  });
  const secondHost = new CodeIntelligenceHost({
    runtimeFactory: async () => secondRuntime,
    semanticQueryServerFactory: semanticQueryTestServer,
  });
  const port = await availablePort();
  const options = { port, bearerToken: 'shared-token' };
  const request = { method: 'POST', headers: { authorization: 'Bearer shared-token' }, body: '{}' };
  try {
    const [firstEndpoint, repeatedEndpoint] = await Promise.all([
      firstHost.startSemanticQueryServer(options), firstHost.startSemanticQueryServer(options),
    ]);
    expect(repeatedEndpoint).toBe(firstEndpoint);
    await expect(secondHost.startSemanticQueryServer(options)).rejects.toMatchObject({ cause: { code: 'EADDRINUSE' } });
    const secondEndpoint = await secondHost.startSemanticQueryServer({ bearerToken: 'shared-token' });
    expect(secondEndpoint).not.toBe(firstEndpoint);
    const secondResponse = await fetch(`${secondEndpoint}/v1/semantic-query/listRepositories`, request);
    expect(await secondResponse.json()).toMatchObject({ repositories: [{ repositoryId: 'second-window' }] });
    secondHost.dispose();
    const firstResponse = await fetch(`${firstEndpoint}/v1/semantic-query/listRepositories`, request);
    expect(await firstResponse.json()).toMatchObject({ repositories: [{ repositoryId: 'first-window' }] });
  } finally {
    firstHost.dispose();
    secondHost.dispose();
  }
});

it('scopes module-first retrieval to this window historical repositories', async () => {
  const history = await temporaryRepository('search-history');
  const target = await temporaryRepository('search-target');
  const runtime = createRuntime();
  const search = vi.fn(async () => []);
  runtime.moduleImplementationSearch = { search };
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  await host.synchronize({
    repositories: [
      { localPath: history, role: 'history' },
      { localPath: target, role: 'target' },
    ],
    scan: false,
  });

  await host.searchHistoricalImplementations({
    target: { id: 'target', name: 'run', kind: 'function', path: 'run.ts', language: 'TypeScript', signature: 'run()' },
    requirement: 'run work',
    topK: 3,
  });

  const historicalIds = (await runtime.registry.list!())
    .filter((repository) => repository.role === 'history')
    .map((repository) => repository.repositoryId);
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ repositoryIds: historicalIds }), undefined);
});

it('pins all nine visible history repositories for module evidence and rejects hidden candidates', async () => {
  const histories = await Promise.all(Array.from({ length: 9 }, (_, i) => temporaryRepository(`evidence-${i}`)));
  const runtime = createRuntime();
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  try {
    await host.synchronize({ repositories: histories.map(localPath => ({ localPath, role: 'history' as const })) });
    const selected = await host.activeScopeForPath(histories[0]!);
    const scopes = await host.historyEvidenceScopes(selected);
    expect(scopes).toHaveLength(9); expect(scopes[0]).toEqual(selected);
    await expect(host.historyEvidenceScopes({ ...selected, repositoryId: 'hidden' })).rejects.toThrow('参考范围');
    await expect(host.historyEvidenceScopes({ ...selected, analysisRevision: 'missing' })).rejects.toThrow('不可查询');
  } finally { host.dispose(); }
});
