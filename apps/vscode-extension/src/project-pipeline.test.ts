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
