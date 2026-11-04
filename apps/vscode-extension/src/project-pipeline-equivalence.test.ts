// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SearchCandidate, WorkspaceCompilation, WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';
import { ProjectPipeline, type ProjectPipelinePorts } from './project-pipeline';
import type { ProjectPipelineModule, ProjectPipelineRun, ProjectPipelineStart } from './project-pipeline-types';
import { LegacyProjectPipeline } from './test/fixtures/project-pipeline-legacy';

type Pipeline = Pick<ProjectPipeline, 'start' | 'resume' | 'cancel' | 'idle' | 'current' | 'busy'>;
type PipelineConstructor = new (ports: ProjectPipelinePorts) => Pipeline;
type Disposition = NonNullable<ProjectPipelineModule['moduleVerification']>['disposition'];
type Options = {
  proactiveIntegration?: boolean;
  failedModule?: string;
  disposition?: Disposition;
  validationFailures?: number;
  failPublish?: boolean;
  failSave?: boolean;
  failRestore?: boolean;
  protectedChange?: boolean;
  retainedFailure?: boolean;
  cancelAtInitialize?: boolean;
  prepareFailure?: 'string' | 'frozen-error';
  generateFailure?: 'string' | 'frozen-error';
};

const input: ProjectPipelineStart = { repositoryId: 'repo', projectId: 'project', requirement: '保持租户隔离和幂等上传', topK: 4 };
const compilation: WorkspaceCompilation = { command: { executable: 'compiler', args: ['build'] }, success: true, exitCode: 0, startedAt: '', durationMs: 1, output: 'PASS', diagnostics: [] };
const plan: WorkspaceTranslationPlan = { summary: '实现边界校验', steps: [{ id: 'step', description: '实现模块契约', files: ['base.java'], dependsOn: [] }], mappings: [], dependencies: [] };

function module(id: string, dependsOn: string[] = []): ProjectPipelineModule {
  return { id, name: id, status: 'pending', candidates: [], dependsOn, target: {
    id, kind: 'module', name: id, path: `${id}.java`, language: 'Java', signature: '',
    module: { sourceFiles: [`${id}.java`], coreApis: [], dependsOn },
  } };
}

function candidate(id: string): SearchCandidate {
  return { id: `reference-${id}`, title: id, repository: 'history', license: 'MIT', language: 'Java', kind: 'module',
    path: `${id}.java`, signature: '', summary: 'reference', preview: '// reference', dependencies: [], compatibility: [], risks: [],
    score: { overall: 1, semantic: 1, symbol: 1, contract: 1 } };
}

function translated(item: ProjectPipelineModule): WorkspaceTranslationRun {
  return { id: `translation-${item.id}`, workspaceRoot: '/output', status: 'completed', acceptance: 'compilation-only',
    request: { spec: input.requirement, sourceLanguage: 'Java', targetLanguage: 'Java', context: [], workspaceFiles: [item.target.path], writeFiles: [item.target.path] },
    createdAt: '', updatedAt: '', completedSteps: [], changes: [{ path: item.target.path, before: '// TODO', after: '// implemented', applied: true }],
    compilations: [structuredClone(compilation)], modelTurns: 4,
    events: [{ at: '', phase: 'completed', message: `${item.id}: compilation complete` }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(Constructor: PipelineConstructor, options: Options = {}) {
  const calls: unknown[] = [], notifications: ProjectPipelineRun[] = [], saved: ProjectPipelineRun[] = [];
  const initialized = deferred(), cleanup = deferred(), cleanupStarted = deferred();
  let validationCount = 0;
  const record = (...args: unknown[]) => { calls.push(structuredClone(args)); };
  const ports: ProjectPipelinePorts = {
    proactiveIntegration: options.proactiveIntegration,
    prepare: async request => {
      record('prepare', request);
      if (options.prepareFailure === 'string') throw 'prepare transport unavailable';
      if (options.prepareFailure === 'frozen-error') throw Object.freeze(new Error('prepare transport unavailable'));
      return { projectName: 'Gateway', analysisRevision: 'r1', analysisHash: 'index-hash', outputRoot: '/output', baselineCommit: 'baseline',
        configuration: { compileCommand: structuredClone(compilation.command) },
        modules: [module('base'), module('dependent', ['base']), module('independent')] };
    },
    initialize: async (run, signal, log) => {
      record('initialize', run); log('protocol initialized'); initialized.resolve();
      if (options.cancelAtInitialize) await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    restore: async (run, _signal, log) => {
      record('restore', run);
      if (options.failRestore) throw new Error('snapshot modified');
      log('protocol restored without planning');
    },
    checkpoint: async run => {
      record('checkpoint', run.stage, run.status, run.currentModuleId, run.modules.map(item => [item.id, item.status, item.authorizedFiles]));
      return { sourceHash: 'checkpoint-hash', files: Object.fromEntries(run.modules.map(item => [item.target.path, 'file-hash'])), activeModuleId: run.currentModuleId };
    },
    search: async (item, request) => {
      record('search', item, request);
      item.selectedCandidateIds = [`reference-${item.id}`];
      return [candidate(item.id)];
    },
    generate: async (item, run, hooks) => {
      record('generate', item, run);
      if (options.generateFailure === 'string') throw 'generation transport unavailable';
      if (options.generateFailure === 'frozen-error') throw Object.freeze(new Error('generation transport unavailable'));
      // The real backend mutates these fields as well as returning a translation.
      item.authorizedFiles = [item.target.path, 'Contracts.java'];
      await hooks.onCheckpoint?.();
      await hooks.onPlan(structuredClone(plan));
      const result = translated(item);
      hooks.onRun(structuredClone(result));
      hooks.onProgress?.('verifying', `${item.id}: verifier started`);
      item.moduleVerification = { disposition: 'agent-uncertain', mode: 'requirement', attempts: [],
        result: { status: 'failure', reason: 'unresolved-test-failure', functions: [], testEvidence: {
          runs: [], revisions: [], failures: [{ id: `${item.id}-failure`, runId: 'test-run', testId: 'isolation', message: 'requires correction review', versions: [], status: 'unresolved' }],
        } } };
      item.retainedTests = { schemaVersion: 1, id: item.id, directory: `.recast-tests/${item.id}`, framework: 'jest',
        testRoots: ['tests'], testPaths: ['tests/isolation.test.js'], files: [{ path: 'tests/isolation.test.js', sha256: 'test-hash' }], status: 'unverified', command: 'node .recast-tests/run.cjs' };
      await hooks.onCheckpoint?.();
      if (options.failedModule === item.id) return { ...result, status: 'failed', error: `${item.id}: interrupted transport` };
      return result;
    },
    validate: async run => {
      record('validate', run); validationCount += 1;
      const verification = validationCount <= (options.validationFailures ?? 0) ? { ...compilation, success: false, output: 'tenant isolation failed' } : compilation;
      return { compilation: structuredClone(compilation), verification: structuredClone(verification), protectedFilesUnchanged: !options.protectedChange,
        sourceHash: 'source-hash', coverage: null,
        ...(options.retainedFailure ? { retainedTests: { ...compilation, success: false, output: 'retained test failed' }, retainedTestFailures: ['base'] } : {}),
        modules: run.modules.filter(item => !item.taskKind).map(item => ({ id: item.id, verification: {
          disposition: item.id === 'base' ? options.disposition ?? 'verified' : 'verified', mode: 'requirement' as const, attempts: [], sourceHash: 'source-hash',
        } })),
      };
    },
    sourceHash: async run => { record('sourceHash', run); return 'source-hash'; },
    publish: async run => { record('publish', run); if (options.failPublish) throw new Error('git temporarily locked'); return 'output-commit'; },
    save: async run => { saved.push(structuredClone(run)); if (options.failSave) throw new Error('disk full'); },
    changed: run => { notifications.push(structuredClone(run)); },
    finish: async () => {
      record('finish:start'); cleanupStarted.resolve();
      if (options.cancelAtInitialize) await cleanup.promise;
      record('finish:end');
    },
  };
  const pipeline = new Constructor(ports);
  const evidence = () => ({ calls, notifications, saved, current: pipeline.current, busy: pipeline.busy });
  return { pipeline, evidence, initialized, cleanup, cleanupStarted };
}

/** Only nondeterministic clocks and UUIDs are normalized; no business fields are omitted. */
function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string'
    ? item.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => {
      if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
      return ids.get(id)!;
    }).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
    : item));
}

async function execute(Constructor: PipelineConstructor, options: Options = {}) {
  const run = fixture(Constructor, options); run.pipeline.start(input); await run.pipeline.idle(); return run;
}

describe('LangGraph project orchestration preserves the legacy behavior', () => {
  it.each([
    ['normal serial generation and proactive Integration', { proactiveIntegration: true }],
    ['two failed final validations followed by Integration repairs', { validationFailures: 2 }],
    ['the existing Integration repair limit', { validationFailures: 3 }],
    ['uncertain behavior delivered as compilation-only', { disposition: 'agent-uncertain' }],
    ['test environment gaps delivered as compilation-only', { disposition: 'test-environment' }],
    ['production defects blocking delivery', { disposition: 'production-defect' }],
    ['protected file changes blocking delivery immediately', { protectedChange: true }],
    ['retained test failures blocking delivery immediately', { retainedFailure: true }],
    ['an intermediate module failure', { failedModule: 'dependent' }],
    ['run persistence failure', { failSave: true }],
    ['a port throwing a string', { prepareFailure: 'string' }],
    ['a port throwing a frozen Error', { prepareFailure: 'frozen-error' }],
    ['a graph-executed generation port throwing a string', { generateFailure: 'string' }],
    ['a graph-executed generation port throwing a frozen Error', { generateFailure: 'frozen-error' }],
  ] as const)('matches calls, progress, saved evidence and result for %s', async (_name, options) => {
    const legacy = await execute(LegacyProjectPipeline, options), current = await execute(ProjectPipeline, options);
    expect(normalize(current.evidence())).toEqual(normalize(legacy.evidence()));
  });

  it.each([
    ['failed module', { failedModule: 'dependent' }, 'dependent'],
    ['failed dependency invalidating completed downstream modules', { disposition: 'production-defect' }, 'base'],
    ['failed Integration', { proactiveIntegration: true, failedModule: 'pipeline-integration' }, undefined],
    ['failed publish requiring fresh final validation', { proactiveIntegration: true, failPublish: true }, undefined],
  ] as const)('resumes the %s with equivalent invalidation and evidence', async (_name, options, moduleId) => {
    const results = [];
    for (const Constructor of [LegacyProjectPipeline, ProjectPipeline]) {
      const first = await execute(Constructor, options);
      // Simulate the JSON persistence boundary, not a shared live object.
      const previous = JSON.parse(JSON.stringify(first.pipeline.current)) as ProjectPipelineRun;
      const resumed = fixture(Constructor, { proactiveIntegration: (options as Options).proactiveIntegration });
      resumed.pipeline.resume(previous, moduleId); await resumed.pipeline.idle();
      results.push({ first: first.evidence(), resumed: resumed.evidence() });
    }
    expect(normalize(results[1])).toEqual(normalize(results[0]));
  });

  it('retains cleanup ordering and busy state during cancellation', async () => {
    const results = [];
    for (const Constructor of [LegacyProjectPipeline, ProjectPipeline]) {
      const run = fixture(Constructor, { cancelAtInitialize: true }); run.pipeline.start(input);
      await run.initialized.promise; run.pipeline.cancel(run.pipeline.current!.id); await run.cleanupStarted.promise;
      expect(run.pipeline.busy).toBe(true); expect(() => run.pipeline.start(input)).toThrow('已有项目流水线');
      const whileCleaning = run.pipeline.current;
      run.cleanup.resolve(); await run.pipeline.idle();
      results.push({ whileCleaning, ...run.evidence() });
    }
    expect(normalize(results[1])).toEqual(normalize(results[0]));
  });

  it('leaves a rejected recovery checkpoint untouched', async () => {
    const failed = await execute(LegacyProjectPipeline, { failedModule: 'dependent' });
    const results = [];
    for (const Constructor of [LegacyProjectPipeline, ProjectPipeline]) {
      const run = fixture(Constructor, { failRestore: true });
      run.pipeline.resume(JSON.parse(JSON.stringify(failed.pipeline.current))); await run.pipeline.idle();
      results.push(run.evidence());
      expect(run.evidence().calls.some(call => Array.isArray(call) && call[0] === 'checkpoint')).toBe(false);
    }
    expect(normalize(results[1])).toEqual(normalize(results[0]));
  });

  it('keeps mutable backend fields and progress callbacks while the graph node is running', async () => {
    const run = await execute(ProjectPipeline);
    const base = run.pipeline.current!.modules[0]!;
    expect(base).toMatchObject({
      selectedCandidateIds: ['reference-base'], authorizedFiles: ['base.java', 'Contracts.java'],
      moduleVerification: { disposition: 'agent-uncertain', result: { reason: 'unresolved-test-failure' } },
      retainedTests: { id: 'base', testPaths: ['tests/isolation.test.js'], status: 'unverified' },
    });
    expect(run.evidence().notifications.some(snapshot => snapshot.stage === 'verifying' && snapshot.modules[0]?.status === 'running')).toBe(true);
    expect(run.evidence().saved.some(snapshot => snapshot.modules[0]?.status === 'running' && snapshot.modules[0]?.retainedTests?.id === 'base')).toBe(true);
  });

  it('executes 80 serial modules without imposing the framework default graph step limit', async () => {
    const generated: string[] = [], units = Array.from({ length: 80 }, (_, index) => module(`module-${index}`));
    const pipeline = new ProjectPipeline({
      prepare: async () => ({ projectName: 'ManyModules', analysisRevision: 'r1', analysisHash: 'index-hash', outputRoot: '/output', baselineCommit: 'baseline', modules: units }),
      search: async () => [],
      generate: async item => { generated.push(item.id); return translated(item); },
      validate: async () => ({ compilation, protectedFilesUnchanged: true, sourceHash: 'source-hash', coverage: null }),
      sourceHash: async () => 'source-hash', publish: async () => 'output-commit', save: async () => {}, changed: () => {},
    });
    pipeline.start(input); await pipeline.idle();
    expect(generated).toEqual(units.map(item => item.id));
    expect(pipeline.current).toMatchObject({ status: 'completed', acceptance: 'compilation-only', commit: 'output-commit' });
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('supports old/new engines reading each other\'s %s records without private graph fields', async status => {
    const legacy = await execute(LegacyProjectPipeline, { failedModule: 'dependent', proactiveIntegration: true });
    const current = await execute(ProjectPipeline, { failedModule: 'dependent', proactiveIntegration: true });
    const results = [];
    // Cross-version recovery includes retained tests, an applied file and in-flight checkpoint metadata.
    for (const [previous, Constructor] of [[legacy.pipeline.current!, ProjectPipeline], [current.pipeline.current!, LegacyProjectPipeline]] as const) {
      const stored = JSON.parse(JSON.stringify(previous)) as ProjectPipelineRun; stored.status = status;
      const resumed = fixture(Constructor, { proactiveIntegration: true });
      resumed.pipeline.resume(stored); await resumed.pipeline.idle();
      results.push(resumed.evidence()); expect(resumed.pipeline.current?.status).toBe('completed');
    }
    expect(normalize(results[0])).toEqual(normalize(results[1]));
  });
});
