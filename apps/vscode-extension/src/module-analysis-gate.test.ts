// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from '@forexplore/code-intelligence-service';
import { CodeIntelligenceHost } from './code-intelligence-host';

const refusal = '模块解析需要先在设置中配置 DeepSeek 的 API Key。';

/** A target workspace with two projects, so no project is modelled without an explicit choice. */
async function setup(modelKeyRefusal: string | undefined, analysisState: 'missing' | 'ready' = 'missing') {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-model-gate-'));
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const ensure = vi.fn(async () => {});
  const refusals: string[] = [];
  const analysisErrors = vi.fn();
  const host = new CodeIntelligenceHost({
    runtimeFactory: async () => runtime,
    planProject: async () => { throw new Error('The test must not invoke a model.'); },
    modelKeyRefusal: async () => modelKeyRefusal,
    onModelRefusal: (reason) => { refusals.push(reason); },
    onProjectAnalysisError: analysisErrors,
    projectAnalysisPort: { ensure, idle: async () => {}, read: async (scope) => ({ ...scope,
      state: analysisState, projection: analysisState === 'ready' ? 'ready' : 'pending',
      analysisProfile: 'code-understanding/v1', updatedAt: '' }) },
  });
  for (const name of ['first-project', 'second-project']) {
    const directory = path.join(root, name);
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name }));
    await writeFile(path.join(directory, 'index.ts'), 'export function run() { return 1; }');
  }
  const result = await host.synchronize({ repositories: [{ localPath: root, role: 'target' }] });
  const repository = result.presentation.repositories[0]!;
  const selected = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision!,
    projectId: repository.projects[0]!.projectId };
  const dispose = async () => { host.dispose(); await rm(root, { recursive: true, force: true }); };
  return { host, ensure, refusals, selected, dispose, projects: repository.projects, analysisErrors };
}

it('refuses module analysis without a model key while indexing stays usable', async () => {
  const { host, ensure, refusals, selected, dispose, projects, analysisErrors } = await setup(refusal);
  try {
    await host.selectProjectForDisplay(selected);
    await host.waitForProjects();
    expect(ensure).not.toHaveBeenCalled();
    expect(refusals).toEqual([refusal]);
    expect(analysisErrors).toHaveBeenCalledExactlyOnceWith(selected, expect.objectContaining({ message: refusal }));
    // An explicit retry fails loudly instead of being swallowed by the background log.
    await expect(host.retryProject(selected, true)).rejects.toThrow('API Key');
    await host.waitForProjects();
    expect(ensure).not.toHaveBeenCalled();
    // The revision, its projects and symbol search are untouched by the refusal.
    expect(projects).toHaveLength(2);
    expect((await host.explorerData())[0]?.projectId).toBe(selected.projectId);
  } finally { await dispose(); }
});

it('does not refuse an already-modelled project when no key is configured', async () => {
  // A corpus that is already modelled must not report a missing credential: the
  // refusal is about a model call, and no model call is needed here.
  const { host, ensure, refusals, selected, dispose } = await setup(refusal, 'ready');
  try {
    await host.selectProjectForDisplay(selected);
    await host.waitForProjects();
    expect(ensure).not.toHaveBeenCalled();
    expect(refusals).toEqual([]);
  } finally { await dispose(); }
});

it('runs module analysis once the model key is configured', async () => {
  const { host, ensure, refusals, selected, dispose } = await setup(undefined);
  try {
    await host.selectProjectForDisplay(selected);
    await host.waitForProjects();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(selected, false);
    expect(refusals).toEqual([]);
  } finally { await dispose(); }
});
