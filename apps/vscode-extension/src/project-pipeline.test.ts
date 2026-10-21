import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceCompilation, WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';
import { ProjectPipeline, projectPipelineMarkdown, type ProjectPipelinePorts } from './project-pipeline';
import type { ProjectPipelineModule, ProjectPipelineRun, ProjectPipelineStart } from './project-pipeline-types';

const input: ProjectPipelineStart = { repositoryId: 'repo', projectId: 'project', requirement: '实现租户隔离与幂等上传', topK: 4 };
const module = (id: string): ProjectPipelineModule => ({ id, name: id, status: 'pending', candidates: [], dependsOn: [], target: {
  id, kind: 'module', name: id, path: `${id}.java`, language: 'Java', signature: '', module: { sourceFiles: [`${id}.java`], coreApis: [], dependsOn: [] },
} });
const plan: WorkspaceTranslationPlan = { summary: '实现边界校验', steps: [{ id: 'step', description: '实现上传', files: ['upload.java'], dependsOn: [] }], mappings: [{ source: 'upload', targetPath: 'upload.java', targetSymbol: 'upload' }], dependencies: [] };
const compilation: WorkspaceCompilation = { command: { executable: 'compiler', args: [] }, success: true, exitCode: 0, startedAt: '', durationMs: 1, output: 'PASS', diagnostics: [] };
const translated = (module: ProjectPipelineModule): WorkspaceTranslationRun => ({ id: randomUUID(), workspaceRoot: '/output', status: 'completed', acceptance: 'compilation-only',
  request: { spec: input.requirement, sourceLanguage: 'Java', targetLanguage: 'Java', context: [], workspaceFiles: [module.target.path], writeFiles: [module.target.path] },
  createdAt: '', updatedAt: '', completedSteps: [], changes: [{ path: module.target.path, before: '// TODO', after: '// implemented', applied: true }], compilations: [compilation], modelTurns: 4 });
function fixture(overrides: Partial<ProjectPipelinePorts> = {}) {
  const ports: ProjectPipelinePorts = {
    prepare: vi.fn(async () => ({ projectName: 'Gateway', analysisRevision: 'r1', analysisHash: 'index-hash', outputRoot: '/output', baselineCommit: 'baseline', modules: [module('upload'), module('orders')] })),
    search: vi.fn(async () => []), generate: vi.fn(async (item, _run, hooks) => { await hooks.onPlan(plan); return translated(item); }),
    validate: vi.fn(async () => ({ compilation, verification: compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null })),
    sourceHash: vi.fn(async () => 'source-hash'), publish: vi.fn(async () => 'output-commit'), save: vi.fn(async () => {}), changed: vi.fn(), ...overrides,
  };
  return { ports, pipeline: new ProjectPipeline(ports) };
}
async function until(check: () => boolean) { for (let index = 0; index < 200; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('State did not arrive'); }

describe('host-owned project pipeline', () => {
  it('resumes a persisted failure with a new runner, skipping completed modules and keeping original input and attempt evidence', async () => {
    const first = fixture({ generate: async item => item.id === 'orders' ? { ...translated(item), status: 'failed', error: 'interrupted transport' } : translated(item) });
    first.pipeline.start(input); await first.pipeline.idle();
    const failed = first.pipeline.current!;
    expect(failed.modules.map(item => item.status)).toEqual(['completed', 'failed']);
    const restore = vi.fn(async () => {}), second = fixture({ restore });
    second.pipeline.resume(failed, 'orders'); await second.pipeline.idle();
    expect(second.ports.prepare).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(failed, expect.any(AbortSignal), expect.any(Function));
    expect((second.ports.generate as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].id)).toEqual(['orders']);
    expect(second.ports.search).toHaveBeenCalledWith(expect.any(Object), input, expect.any(AbortSignal));
    expect(second.pipeline.current).toMatchObject({ id: failed.id, outputRoot: failed.outputRoot, status: 'completed', resumeCount: 1 });
    expect(second.pipeline.current!.modules[1]!.attemptHistory?.[0]?.translation?.error).toBe('interrupted transport');
    expect(second.ports.validate).toHaveBeenCalledOnce(); expect(second.ports.publish).toHaveBeenCalledOnce();
  });
  it('invalidates completed dependents of a retried defect without regenerating unrelated branches', async () => {
    const units = ['base', 'dependent', 'independent'].map(module); units[1]!.dependsOn = ['base'];
    const first = fixture({ prepare: async () => ({ projectName: 'Gateway', analysisRevision: 'r1', analysisHash: 'hash', outputRoot: '/output', baselineCommit: 'baseline', modules: units }),
      validate: async () => ({ compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null,
        modules: units.map(item => ({ id: item.id, verification: { disposition: item.id === 'base' ? 'production-defect' : 'verified', mode: 'requirement', attempts: [] } })) }),
    });
    first.pipeline.start(input); await first.pipeline.idle();
    const second = fixture(); second.pipeline.resume(first.pipeline.current!, 'base'); await second.pipeline.idle();
    expect((second.ports.generate as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].id)).toEqual(['base', 'dependent']);
    expect(second.pipeline.current!.modules.find(item => item.id === 'independent')!.attemptHistory).toBeUndefined();
  });
  it('keeps historical verification failures available to the verifier when restarting a failed module', async () => {
    const first = fixture({ generate: async item => {
      item.moduleVerification = { disposition: 'agent-uncertain', mode: 'requirement', attempts: [], result: { status: 'failure', reason: 'unresolved-test-failure', functions: [] } };
      return { ...translated(item), status: 'failed' };
    } });
    first.pipeline.start(input); await first.pipeline.idle();
    const second = fixture(); second.pipeline.resume(first.pipeline.current!); await second.pipeline.idle();
    expect((second.ports.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0].moduleVerification?.result?.reason).toBe('unresolved-test-failure');
  });
  it('resumes a failed Integration without rerunning completed production modules or creating a duplicate Integration', async () => {
    const first = fixture({ proactiveIntegration: true, generate: async item => item.taskKind ? { ...translated(item), status: 'failed', error: 'integration timed out' } : translated(item) });
    first.pipeline.start(input); await first.pipeline.idle();
    const second = fixture({ proactiveIntegration: true }); second.pipeline.resume(first.pipeline.current!); await second.pipeline.idle();
    expect((second.ports.generate as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].id)).toEqual(['pipeline-integration']);
    expect(second.pipeline.current!.modules.filter(item => item.id === 'pipeline-integration')).toHaveLength(1);
  });
  it('retries final validation directly and never reuses old green results after a failed publish', async () => {
    const first = fixture({ proactiveIntegration: true, publish: async () => { throw new Error('git temporarily locked'); } });
    first.pipeline.start(input); await first.pipeline.idle();
    const second = fixture({ proactiveIntegration: true }); second.pipeline.resume(first.pipeline.current!); await second.pipeline.idle();
    expect(second.ports.generate).not.toHaveBeenCalled(); expect(second.ports.validate).toHaveBeenCalledOnce();
    expect(second.pipeline.current!.status).toBe('completed');
  });
  it('refuses invalid module targets and concurrent resumes, and does not refresh a rejected checkpoint', async () => {
    const first = fixture({ generate: async item => ({ ...translated(item), status: 'failed' }) }); first.pipeline.start(input); await first.pipeline.idle();
    const second = fixture({ restore: async () => { throw new Error('snapshot modified'); }, checkpoint: vi.fn() });
    expect(() => second.pipeline.resume(first.pipeline.current!, 'unknown')).toThrow('只能重试');
    second.pipeline.resume(first.pipeline.current!);
    expect(() => second.pipeline.resume(first.pipeline.current!)).toThrow('已有项目流水线');
    await second.pipeline.idle();
    expect(second.ports.generate).not.toHaveBeenCalled(); expect(second.ports.checkpoint).not.toHaveBeenCalled();
    expect(second.pipeline.current).toMatchObject({ status: 'failed', error: 'snapshot modified' });
  });
  it('runs the backend initialization and proactive Integration before validating the final bytes', async () => {
    const order: string[] = [];
    const { pipeline, ports } = fixture({ proactiveIntegration: true,
      initialize: async () => { order.push('protocol'); },
      generate: async item => { order.push(item.taskKind ?? item.id); return translated(item); },
      validate: async () => { order.push('final-verifier'); return { compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null,
        modules: ['upload', 'orders'].map(id => ({ id, verification: { disposition: 'verified', mode: 'requirement', attempts: [], sourceHash: 'source-hash' } })) }; },
      finish: async () => { order.push('cleanup'); },
    });
    pipeline.start(input); await pipeline.idle();
    expect(order).toEqual(['protocol', 'upload', 'orders', 'project-integration', 'final-verifier', 'cleanup']);
    expect(pipeline.current).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
    expect(ports.publish).toHaveBeenCalledOnce();
  });
  it.each(['agent-uncertain', 'test-environment', 'production-defect'] as const)('does not conceal %s behind passing compilation or fixed tests', async disposition => {
    const { pipeline, ports } = fixture({ validate: async () => ({ compilation, verification: compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null,
      modules: [{ id: 'upload', verification: { disposition, mode: 'requirement', attempts: [] } }] }) });
    pipeline.start(input); await pipeline.idle();
    expect(pipeline.current!.acceptance).not.toBe('behavior-verified');
    if (disposition === 'production-defect') { expect(pipeline.current!.status).toBe('failed'); expect(ports.publish).not.toHaveBeenCalled(); }
    else expect(pipeline.current).toMatchObject({ status: 'completed', acceptance: 'compilation-only' });
  });
  it('keeps the host busy until cancellation cleanup completes and retains a report', async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const finish = vi.fn(() => cleanup);
    const { pipeline, ports } = fixture({ initialize: async (_run, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), finish });
    pipeline.start(input); await until(() => Boolean(pipeline.current?.outputRoot));
    pipeline.cancel(pipeline.current!.id); await until(() => finish.mock.calls.length > 0);
    expect(pipeline.busy).toBe(true); expect(() => pipeline.start(input)).toThrow('已有项目流水线');
    release(); await pipeline.idle(); expect(pipeline.busy).toBe(false);
    expect(pipeline.current).toMatchObject({ status: 'cancelled', reportAvailable: true }); expect(ports.publish).not.toHaveBeenCalled();
  });
  it('automatically executes every module then verifies and publishes one project with honest trace evidence', async () => {
    const { pipeline, ports } = fixture(); pipeline.start(input); await pipeline.idle();
    expect(pipeline.current).toMatchObject({ status: 'completed', acceptance: 'behavior-verified', reportAvailable: true, commit: 'output-commit' });
    expect(pipeline.current!.modules.map(item => item.status)).toEqual(['completed', 'completed']);
    expect(ports.generate).toHaveBeenCalledTimes(2); expect(ports.publish).toHaveBeenCalledTimes(1);
    expect(projectPipelineMarkdown(pipeline.current!)).toContain('覆盖率：未采集');
  });
  it('repairs a failed full-project test and reruns acceptance before publishing', async () => {
    const validate = vi.fn().mockResolvedValueOnce({ compilation, verification: { ...compilation, success: false, output: 'tenant isolation failed' }, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null })
      .mockResolvedValue({ compilation, verification: compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null });
    const { pipeline, ports } = fixture({ validate }); pipeline.start(input); await pipeline.idle();
    expect(pipeline.current!.status).toBe('completed'); expect(validate).toHaveBeenCalledTimes(2); expect(ports.generate).toHaveBeenCalledTimes(3);
    expect(pipeline.current!.modules.at(-1)?.id).toBe('pipeline-integration-repair-1');
    expect(pipeline.current!.validationHistory?.map(item => item.verification?.success)).toEqual([false, true]);
    expect((ports.generate as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1].requirement).toContain('tenant isolation failed');
  });
  it('never publishes changed acceptance files or fabricates business verification without tests', async () => {
    const first = fixture({ sourceHash: async () => 'changed-after-validation' }); first.pipeline.start(input); await first.pipeline.idle();
    expect(first.pipeline.current!.status).toBe('failed'); expect(first.ports.publish).not.toHaveBeenCalled();
    const second = fixture({ validate: async () => ({ compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null }) });
    second.pipeline.start(input); await second.pipeline.idle(); expect(second.pipeline.current).toMatchObject({ status: 'completed', acceptance: 'compilation-only' });
  });
  it('fails closed when run evidence cannot be saved', async () => {
    const { pipeline, ports } = fixture({ save: async () => { throw new Error('disk full'); } }); pipeline.start(input); await pipeline.idle();
    expect(pipeline.current).toMatchObject({ status: 'failed', reportAvailable: false }); expect(ports.publish).not.toHaveBeenCalled();
  });
});
