// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ProjectAnalysisScope } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator, projectPlanHash } from '@forexplore/code-intelligence-service';
import { CodeIntelligenceHost } from './code-intelligence-host';
import { buildProjectExplorer } from './project-explorer';

async function setup(projectCount = 1) {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-model-resume-'));
  for (let i = 0; i < projectCount; i++) {
    const directory = path.join(root, `project-${i}`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `project-${i}` }));
    await writeFile(path.join(directory, 'index.ts'), 'export function run() { return 1; }');
  }
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  await runtime.registry.register({ repositoryId: 'target', role: 'target', localPath: root });
  const run = await runtime.coordinator.run({ repositoryId: 'target' });
  const index = (await runtime.store.getStructuralIndex(run.scope))!;
  const scan = vi.spyOn(runtime.coordinator, 'run');
  let hasKey = false;
  const plan = vi.fn(async (scope: ProjectAnalysisScope & { objective: string }) => {
    const evidenceIds = [`project:${scope.projectId}`];
    const proposal = { ...scope, analysisHash: index.analysisHash, objective: scope.objective, summary: 'Core project functionality',
      modules: [{ id: 'core', name: 'Core behavior', kind: 'feature', description: 'Core functionality',
        sourceFiles: index.files.filter(file => file.projectId === scope.projectId).map(file => file.relativePath),
        symbolKeys: [], dependsOn: [], evidenceIds }] };
    return { proposal, evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds } };
  });
  const createHost = (selected?: string) => new CodeIntelligenceHost({ runtimeFactory: async () => runtime,
    planProject: plan, projectAnalysisPort: new ProjectAnalysisCoordinator({ store: runtime.store, plan }),
    modelKeyRefusal: async () => hasKey ? undefined : '请配置 API Key。',
    initialSelectedProjects: selected ? new Map([['target', selected]]) : undefined });
  const host = createHost();
  const repositories = [{ localPath: root, role: 'target' as const }];
  return { root, runtime, index, host, createHost, repositories, plan, scan, configureKey: () => { hasKey = true; },
    dispose: async () => { host.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

it.each(['startup', 'settings'] as const)('resumes an indexed target after a key is configured on %s without scanning again', async mode => {
  const fixture = await setup();
  const { host, repositories, plan, scan, runtime, index, createHost, configureKey, dispose } = fixture;
  try {
    await host.synchronize({ repositories, scan: false });
    await host.waitForProjects();
    expect(plan).not.toHaveBeenCalled();
    expect((await buildProjectExplorer(host)).presentation.target.stats.modules).toBe(0);
    configureKey();
    const options = mode === 'startup' ? { scan: false } : { scanNewOnly: true, scanRoles: ['history' as const] };
    const resumed = await host.synchronize({ repositories, ...options, resumeProjectAnalysis: true });
    await host.waitForProjects();
    expect(resumed.scannedRepositoryIds).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(1);
    const view = (await buildProjectExplorer(host)).presentation.target;
    expect(view.analysis).toMatchObject({ state: 'ready', projection: 'ready', modeling: { strategy: 'agent' } });
    expect(view.tree[0]).toMatchObject({ kind: 'module', name: 'Core behavior' });
    expect(view.stats.modules).toBe(1);
    expect((await runtime.store.listModuleArtifacts(index)).some(artifact => artifact.kind === 'module-summary')).toBe(true);
    // Reopening the extension reuses durable results, even without checking credentials.
    const reopened = createHost();
    try {
      await reopened.synchronize({ repositories, scan: false, resumeProjectAnalysis: true });
      await reopened.waitForProjects();
      expect(plan).toHaveBeenCalledTimes(1);
      expect(scan).not.toHaveBeenCalled();
    } finally { reopened.dispose(); }
  } finally { await dispose(); }
});

it('keeps registration-only refreshes read-only even when a key is available', async () => {
  const { host, repositories, configureKey, plan, scan, dispose } = await setup();
  try {
    configureKey();
    await host.synchronize({ repositories, scan: false });
    await host.waitForProjects();
    expect(plan).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  } finally { await dispose(); }
});

it('a pipeline start creates a missing model and shares concurrent requests without a source rescan', async () => {
  const { host, repositories, index, configureKey, plan, scan, dispose } = await setup();
  try {
    await host.synchronize({ repositories, scan: false });
    const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, projectId: index.projects[0]!.projectId };
    await expect(host.ensureProjectModel(scope)).rejects.toThrow('API Key');
    expect(plan).not.toHaveBeenCalled();
    configureKey();
    const results = await Promise.all([host.ensureProjectModel(scope), host.ensureProjectModel(scope)]);
    expect(results.every(record => record.state === 'ready' && record.projection === 'ready')).toBe(true);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    await expect(host.ensureProjectModel({ ...scope, analysisRevision: 'old-revision' })).rejects.toThrow('版本已更新');
  } finally { await dispose(); }
});

it('cancels a pipeline wait promptly while the shared modelling job can still finish', async () => {
  const { host, repositories, index, configureKey, plan, dispose } = await setup();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = plan.getMockImplementation()!;
  plan.mockImplementation(async scope => { await blocked; return original(scope); });
  try {
    configureKey();
    await host.synchronize({ repositories, scan: false });
    const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, projectId: index.projects[0]!.projectId };
    const controller = new AbortController();
    const waiting = host.ensureProjectModel(scope, controller.signal);
    await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    controller.abort(new Error('用户取消'));
    await expect(waiting).rejects.toThrow('用户取消');
    release();
    expect((await host.ensureProjectModel(scope)).state).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(1);
  } finally { release(); await dispose(); }
});

it('resumes only the chosen target project and waits when the choice is ambiguous', async () => {
  const { host, createHost, repositories, index, configureKey, plan, scan, dispose } = await setup(2);
  try {
    configureKey();
    await host.synchronize({ repositories, scan: false, resumeProjectAnalysis: true });
    await host.waitForProjects();
    expect(plan).not.toHaveBeenCalled();
    const selected = index.projects[1]!.projectId;
    const reopened = createHost(selected);
    try {
      await reopened.synchronize({ repositories, scan: false, resumeProjectAnalysis: true });
      await reopened.waitForProjects();
      expect(plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: selected }));
      expect((await reopened.explorerData())[0]?.analysis?.state).toBe('ready');
      expect(scan).not.toHaveBeenCalled();
    } finally { reopened.dispose(); }
  } finally { await dispose(); }
});
