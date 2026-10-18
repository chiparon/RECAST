import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceCompilation, WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';
import { ProjectPipeline, projectPipelineMarkdown, type ProjectPipelinePorts } from './project-pipeline';
import type { ProjectPipelineModule, ProjectPipelineRun, ProjectPipelineStart } from './project-pipeline-types';

const input: ProjectPipelineStart = { repositoryId: 'repo', projectId: 'project', requirement: '实现租户隔离与幂等上传', mode: 'automatic', topK: 4 };
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
  it('automatically executes every module then verifies and publishes one project with honest trace evidence', async () => {
    const { pipeline, ports } = fixture(); pipeline.start(input); await pipeline.idle();
    expect(pipeline.current).toMatchObject({ status: 'completed', acceptance: 'behavior-verified', reportAvailable: true, commit: 'output-commit' });
    expect(pipeline.current!.modules.map(item => item.status)).toEqual(['completed', 'completed']);
    expect(ports.generate).toHaveBeenCalledTimes(2); expect(ports.publish).toHaveBeenCalledTimes(1);
    expect(pipeline.current!.decisions.map(item => item.kind)).toEqual(['model', 'candidate', 'plan', 'candidate', 'plan', 'acceptance']);
    expect(pipeline.current!.decisions.every(item => item.decision === 'automatic')).toBe(true);
    expect(projectPipelineMarkdown(pipeline.current!)).toContain('覆盖率：未采集');
  });
  it('waits at all four review kinds and binds each human decision to its exact current evidence', async () => {
    const { pipeline, ports } = fixture(); pipeline.start({ ...input, mode: 'assisted' });
    for (const kind of ['model', 'candidate', 'plan', 'candidate', 'plan', 'acceptance']) {
      await until(() => pipeline.current?.status === 'waiting-review');
      const state = pipeline.current!; expect(state.review!.kind).toBe(kind);
      expect(() => pipeline.decide(state.id, { reviewId: state.review!.id, evidenceHash: 'wrong', decision: 'approve', notes: '' })).toThrow('证据已变化');
      expect(ports.publish).not.toHaveBeenCalled();
      pipeline.decide(state.id, { reviewId: state.review!.id, evidenceHash: state.review!.evidenceHash, decision: 'approve', candidateId: null, notes: '保持接口不变' });
      await until(() => pipeline.current?.review?.id !== state.review!.id);
    }
    await pipeline.idle(); expect(pipeline.current!.status).toBe('completed');
    expect(pipeline.current!.decisions.every(item => item.decision === 'approved')).toBe(true);
  });
  it.each(['cancel', 'reject'])('stops without publishing when a review is %s', async action => {
    const { pipeline, ports } = fixture(); pipeline.start({ ...input, mode: 'assisted' }); await until(() => pipeline.current?.status === 'waiting-review');
    const state = pipeline.current!;
    if (action === 'cancel') pipeline.cancel(state.id);
    else pipeline.decide(state.id, { reviewId: state.review!.id, evidenceHash: state.review!.evidenceHash, decision: 'reject', notes: '模块范围需要调整' });
    await pipeline.idle(); expect(pipeline.current!.status).toBe(action === 'cancel' ? 'cancelled' : 'rejected');
    expect(pipeline.current!.reportAvailable).toBe(true); expect(ports.generate).not.toHaveBeenCalled(); expect(ports.publish).not.toHaveBeenCalled();
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
    const first = fixture({ sourceHash: async () => 'changed-after-review' }); first.pipeline.start(input); await first.pipeline.idle();
    expect(first.pipeline.current!.status).toBe('failed'); expect(first.ports.publish).not.toHaveBeenCalled();
    const second = fixture({ validate: async () => ({ compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null }) });
    second.pipeline.start(input); await second.pipeline.idle(); expect(second.pipeline.current).toMatchObject({ status: 'completed', acceptance: 'compilation-only' });
  });
  it('fails closed when run evidence cannot be saved', async () => {
    const { pipeline, ports } = fixture({ save: async () => { throw new Error('disk full'); } }); pipeline.start(input); await pipeline.idle();
    expect(pipeline.current).toMatchObject({ status: 'failed', reportAvailable: false }); expect(ports.publish).not.toHaveBeenCalled();
  });
});
