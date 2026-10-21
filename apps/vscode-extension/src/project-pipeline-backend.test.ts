// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyGlobalProtocol, type SearchCandidate, type WorkspaceHistoryView, type WorkspaceTranslationRun } from '@forexplore/contracts';
import { ProjectPipelineBackend, type CodexRuntime } from './project-pipeline-backend';
import type { ProjectPipelineModule, ProjectPipelineRun } from './project-pipeline-types';
import type { PipelineModuleVerification } from './project-module-verifier';

vi.mock('./local-fetch', () => ({ localFetch: vi.fn(async (_url, init) => {
  const request = JSON.parse(init.body);
  expect(request.selectReferences).toBe(true);
  return new Response(JSON.stringify({ order: ['c1', 'c0'], selection: { selected: [
    { id: 'c1', reason: 'core behavior', evidence: 'entry', incrementalValue: 'primary' },
    { id: 'c0', reason: 'boundary policy', evidence: 'limit', incrementalValue: 'complement' },
  ], missingResponsibilities: [] } }));
}) }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const verified = (): PipelineModuleVerification => ({ disposition: 'verified', mode: 'requirement', attempts: [], result: { status: 'success', functions: [] } });
async function fixture({ isolatedHome = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-backend-')); roots.push(root);
  const outputRoot = path.join(root, 'project'); await mkdir(outputRoot); await mkdir(path.join(outputRoot, 'src'));
  await writeFile(path.join(outputRoot, 'src/Main.java'), 'public class Main { public int value() { return 0; } }');
  await writeFile(path.join(outputRoot, 'src/MainTest.java'), 'class MainTest {}');
  const module: ProjectPipelineModule = { id: 'main', name: 'Main', dependsOn: [], status: 'running', candidates: [],
    target: { id: 'main', name: 'Main', kind: 'module', language: 'Java', path: 'src/Main.java', signature: 'value()',
      module: { sourceFiles: ['src/Main.java'], coreApis: ['Main.value'], dependsOn: [] } } };
  const run: ProjectPipelineRun = { id: '11111111-2222-3333-4444-555555555555', repositoryId: 'target', projectId: 'project',
    projectName: 'Example', analysisRevision: 'r1', requirement: 'value must return 42', stage: 'modeling', status: 'running',
    createdAt: '', updatedAt: '', modules: [module], events: [], outputRoot, acceptance: 'unverified', reportAvailable: false };
  let current: WorkspaceTranslationRun;
  const runtime: CodexRuntime = {
    start: vi.fn(request => (current = { id: 'module-run', request, workspaceRoot: outputRoot, status: 'completed', acceptance: 'compilation-only',
      createdAt: '', updatedAt: '', completedSteps: [], modelTurns: 1, changes: [{ path: 'src/Main.java', before: '', after: 'implemented', applied: true }],
      compilations: [{ command: { executable: 'test', args: [] }, startedAt: '', durationMs: 1, exitCode: 0, success: true, output: '', diagnostics: [] }] })),
    get: vi.fn(() => current), repairAfterVerification: vi.fn(() => current), cancel: vi.fn(async () => current), shutdown: vi.fn(async () => {}),
  };
  const drivers = { runtime: vi.fn((_options: { codexHome: string; environment: NodeJS.ProcessEnv }) => runtime), plan: vi.fn(async (_input: unknown) => ({ protocol: emptyGlobalProtocol() })), verify: vi.fn(async (_input: Parameters<typeof import('./project-module-verifier').verifyPipelineModule>[0]) => verified()) };
  const search = vi.fn(async (_request, _signal, _reranker) => [] as SearchCandidate[]);
  const history = vi.fn(async (_input: unknown): Promise<WorkspaceHistoryView> => { throw new Error('unexpected history'); });
  const backend = new ProjectPipelineBackend({ codeIntelligence: { searchHistoricalImplementations: search, createHistoryModulesView: history },
    endpoint: () => 'http://localhost:8788', ensureStarted: async () => {}, model: async () => ({ apiKey: 'test-key', model: 'enterprise-model', apiBase: 'https://example.test/v1' }),
    compileCommand: () => ({ executable: process.execPath, args: ['--check'] }), protectedFiles: () => [], ...(isolatedHome ? {} : { codexHome: root }),
  }, drivers);
  const controller = new AbortController(), hooks = { signal: controller.signal, onPlan: vi.fn(async () => undefined), onRun: vi.fn(), onProgress: vi.fn() };
  return { root, run, module, runtime, drivers, search, history, backend, controller, hooks };
}

it('forwards the IDE model credential to Codex without persisting it in the generated configuration', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  const f = await fixture({ isolatedHome: true });
  let codexHome: string | undefined;
  try {
    await f.backend.prepare(f.run, f.controller.signal, () => {});
    await f.backend.generate(f.module, f.run, f.hooks);
    const options = f.drivers.runtime.mock.calls[0]![0];
    codexHome = options.codexHome;
    expect(options.environment).toMatchObject({ DEEPSEEK_API_KEY: 'test-key', ELECTRON_RUN_AS_NODE: '1' });
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(config).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(config).toContain('model = "enterprise-model"');
    expect(config).not.toContain('test-key');
  } finally {
    await f.backend.close();
    vi.unstubAllEnvs();
  }
  await expect(readFile(path.join(codexHome!, 'config.toml'))).rejects.toThrow();
});

it('passes public requirements and protocol to Codex, repairs production defects with the same Translator, then proactively integrates', async () => {
  const f = await fixture();
  f.drivers.verify.mockResolvedValueOnce({ disposition: 'production-defect', mode: 'requirement', attempts: [],
    result: { status: 'failure', reason: 'test-failed', issue: { kind: 'translation', description: 'expected 42, got 0' }, functions: [] } });
  try {
    await f.backend.prepare(f.run, f.controller.signal, () => {});
    expect(f.drivers.plan.mock.calls[0]![0]).toMatchObject({ requirement: f.run.requirement, taskIdentity: f.run.id });
    await f.backend.generate(f.module, f.run, f.hooks);
    expect(f.runtime.start).toHaveBeenCalledWith(expect.objectContaining({ translationMode: 'direct-translator', moduleProtocol: expect.any(Object), spec: expect.stringContaining(f.run.requirement) }));
    expect(f.runtime.repairAfterVerification).toHaveBeenCalledWith('module-run', expect.objectContaining({ attempt: 1, issue: expect.objectContaining({ kind: 'translation' }) }));
    expect(f.module.moduleVerification?.disposition).toBe('verified');
    const verificationRoot = f.drivers.verify.mock.calls[0]![0].root;
    expect(verificationRoot).not.toBe(f.run.outputRoot);
    await writeFile(path.join(verificationRoot, 'generated.test.js'), 'verifier-owned test');
    await expect(readFile(path.join(f.run.outputRoot!, 'generated.test.js'))).rejects.toThrow();
    await writeFile(path.join(f.run.outputRoot!, 'src/Main.java'), 'public class Main { public int value() { return 42; } }');
    const integration = { ...f.module, id: 'pipeline-integration', taskKind: 'project-integration' as const };
    await f.backend.generate(integration, f.run, f.hooks);
    expect(f.runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({ taskKind: 'project-integration', globalProtocol: expect.any(Object), spec: expect.stringContaining(f.run.requirement) }));
    expect((f.runtime.start as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].writeFiles).not.toContain('src/MainTest.java');
    const final = await f.backend.verifyFinal(f.run, 'final-bytes', f.controller.signal, () => {});
    expect(final[0]?.moduleVerification?.sourceHash).toBe('final-bytes');
    expect(f.drivers.verify.mock.calls.at(-1)![0].root).toBe(verificationRoot);
    expect(await readFile(path.join(verificationRoot, 'src/Main.java'), 'utf8')).toContain('return 42');
    expect(await readFile(path.join(verificationRoot, 'generated.test.js'), 'utf8')).toContain('verifier-owned');
    expect(f.drivers.verify).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(f.root, 'global-protocol.json'), 'utf8')).not.toContain('test-key');
  } finally { await f.backend.close(); }
});

it('keeps request-scoped automatic multi-reference selections and refuses a silent ranking fallback', async () => {
  const f = await fixture();
  const candidates = [{ id: 'second' }, { id: 'first' }] as SearchCandidate[];
  f.search.mockImplementationOnce(async (_request, signal, reranker) => {
    await reranker.rank('requirement', ['first', 'second'], signal); return candidates;
  });
  const input = { repositoryId: 'target', projectId: 'project', requirement: 'public need', topK: 1 };
  expect(await f.backend.search(f.module, input, f.controller.signal)).toEqual(candidates);
  expect(f.module.selectedCandidateIds).toEqual(['second', 'first']);
  expect(f.module.referenceSelection?.selected).toHaveLength(2);
  f.search.mockResolvedValueOnce(candidates);
  await expect(f.backend.search(f.module, input, f.controller.signal)).rejects.toThrow('自动参考选择');
});

it('restores protocol metadata without rerunning the Integration Plan agent and persists scope before starting Codex', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'global-protocol.json'), JSON.stringify({ ...emptyGlobalProtocol(), invariants: [
    { id: 'existing-rule', rule: 'value must be 42', source: 'requirement', status: 'fixed', scope: ['main'] },
  ] }));
  try {
    await f.backend.prepare(f.run, f.controller.signal, () => {}, true);
    expect(f.drivers.plan).not.toHaveBeenCalled();
    let scopeRecorded = false;
    const start = f.runtime.start;
    f.runtime.start = request => { expect(scopeRecorded).toBe(true); return start(request); };
    await f.backend.generate(f.module, f.run, { ...f.hooks, onCheckpoint: async () => {
      expect(f.module.authorizedFiles).toEqual(['src/Main.java']); scopeRecorded = true;
    } });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ moduleProtocol: expect.objectContaining({ invariants: [expect.objectContaining({ rule: 'value must be 42' })] }) }));
  } finally { await f.backend.close(); }
});

it('rebuilds a completed module history view at its pinned revision when final verification resumes after restart', async () => {
  const f = await fixture();
  const historyRoot = path.join(f.root, 'restored-history'); await mkdir(historyRoot);
  const view: WorkspaceHistoryView = { root: historyRoot, files: ['Legacy.java'], repositoryId: 'history', analysisRevision: 'pinned-r1', projectId: 'legacy', moduleId: 'legacy', manifestHash: 'hash' };
  f.history.mockResolvedValue(view);
  f.module.status = 'completed'; f.module.selectedCandidateIds = ['candidate'];
  f.module.candidates = [{ id: 'candidate', language: 'Java', path: 'Legacy.java', sourceModule: {
    repositoryId: view.repositoryId, analysisRevision: view.analysisRevision, projectId: view.projectId, moduleId: view.moduleId, name: 'Legacy', sourceFiles: view.files,
  } }] as SearchCandidate[];
  try {
    await f.backend.prepare(f.run, f.controller.signal, () => {}, true);
    await f.backend.verifyFinal(f.run, 'final-hash', f.controller.signal, () => {});
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.history).toHaveBeenCalledWith(expect.objectContaining({ candidates: [expect.objectContaining({ analysisRevision: 'pinned-r1', moduleId: 'legacy' })] }));
    expect(f.drivers.verify).toHaveBeenCalledWith(expect.objectContaining({ historyView: view }));
  } finally { await f.backend.close(); }
});

it('retains immutable failing-test artifacts across cleanup and restores them into a new verifier clone', async () => {
  const f = await fixture(); let oldRoot = '';
  f.drivers.verify.mockImplementationOnce(async input => {
    oldRoot = input.root;
    const evidence = path.join(input.root, '.forexplore', 'translation-verifier-evidence');
    await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'original.txt'), 'immutable original assertion');
    return verified();
  });
  try {
    await f.backend.prepare(f.run, f.controller.signal, () => {});
    await f.backend.generate(f.module, f.run, f.hooks);
    await f.backend.close();
    await expect(readFile(path.join(oldRoot, '.forexplore/translation-verifier-evidence/original.txt'))).rejects.toThrow();
    await f.backend.prepare(f.run, f.controller.signal, () => {}, true);
    f.drivers.verify.mockImplementationOnce(async input => {
      expect(input.root).not.toBe(oldRoot);
      expect(await readFile(path.join(input.root, '.forexplore/translation-verifier-evidence/original.txt'), 'utf8')).toBe('immutable original assertion');
      return verified();
    });
    await f.backend.verifyFinal(f.run, 'new-source-hash', f.controller.signal, () => {});
  } finally { await f.backend.close(); }
});

it('does not send environment failures to the Translator and propagates cancellation through the verifier', async () => {
  const f = await fixture();
  f.drivers.verify.mockResolvedValueOnce({ disposition: 'test-environment', mode: 'requirement', attempts: [],
    result: { status: 'failure', reason: 'test-environment-failure', issue: { kind: 'environment', description: 'SDK unavailable' }, functions: [] } });
  try {
    await f.backend.prepare(f.run, f.controller.signal, () => {});
    await f.backend.generate(f.module, f.run, f.hooks);
    expect(f.runtime.repairAfterVerification).not.toHaveBeenCalled();
    f.drivers.verify.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as { signal: AbortSignal };
      f.controller.abort(new Error('cancelled by user')); input.signal.throwIfAborted(); return verified();
    });
    await expect(f.backend.generate(f.module, f.run, f.hooks)).rejects.toThrow('cancelled by user');
    expect(f.runtime.cancel).toHaveBeenCalledWith('module-run');
    expect(f.runtime.shutdown).toHaveBeenCalledTimes(2);
  } finally { await f.backend.close(); }
});
