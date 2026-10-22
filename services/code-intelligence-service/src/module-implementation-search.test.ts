import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectAnalysisResult, ProjectAnalysisScope, StructuralIndex } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from './index.js';
import { ProjectAnalysisCoordinator, projectAnalysisObjective, projectPlanHash } from './project-analysis.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function result(index: StructuralIndex, scope: ProjectAnalysisScope): ProjectAnalysisResult {
  const files = index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath);
  const symbols = index.symbols.filter((symbol) => symbol.projectId === scope.projectId);
  const proposal = {
    ...scope,
    analysisHash: index.analysisHash,
    objective: projectAnalysisObjective,
    summary: 'Payment processing modules',
    unassignedFiles: [],
    modules: [{
      id: 'payments',
      kind: 'feature',
      name: 'Payment processing',
      description: 'Submits and confirms customer payments.',
      purpose: 'Handle payment submission',
      coreApis: ['submitPayment'],
      sourceFiles: files,
      symbolKeys: symbols.map((symbol) => symbol.symbolKey),
      dependsOn: [],
      evidenceIds: [`project:${scope.projectId}`],
    }],
  };
  return {
    proposal,
    evidence: {
      ...scope,
      analysisHash: index.analysisHash,
      planHash: projectPlanHash(proposal),
      evidenceIds: [`project:${scope.projectId}`],
    },
  };
}

describe('module implementation search', () => {
  it('annotates a recalled symbol with its reviewed module instead of gating on it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forexplore-module-search-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'package.json'), '{"name":"payments"}');
    await writeFile(path.join(root, 'src/payment.ts'), [
      'export class PaymentService {',
      '  submitPayment(amount: number) { return amount > 0; }',
      '}',
    ].join('\n'));

    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await runtime.registry.register({
      repositoryId: 'history-payments',
      displayName: 'payments-history',
      localPath: root,
      role: 'history',
    });
    const run = await runtime.coordinator.run({ repositoryId: 'history-payments' });
    const index = (await runtime.store.getStructuralIndex(run.scope))!;
    const project = index.projects[0]!;
    const scope = { ...run.scope, projectId: project.projectId };
    const analysis = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async () => result(index, scope) });
    await analysis.ensure(scope);

    const candidates = await runtime.moduleImplementationSearch.search({
      target: {
        id: 'target-submit',
        name: 'submitPayment',
        kind: 'function',
        path: 'src/PaymentService.cs',
        language: 'C#',
        signature: 'bool SubmitPayment(decimal amount)',
      },
      requirement: 'submit and confirm a payment',
      topK: 3,
      repositoryIds: ['history-payments'],
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repository: 'payments-history',
        title: expect.stringContaining('submitPayment'),
        preview: expect.stringContaining('submitPayment'),
        sourceModule: expect.objectContaining({ moduleId: 'payments', name: 'Payment processing' }),
      }),
    ]));
    expect(candidates.every((candidate) => candidate.sourceModule?.analysisRevision === run.scope.analysisRevision)).toBe(true);
  });

  it('ranks symbols flat: a module that loses the module race no longer hides its symbols', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forexplore-flat-search-'));
    roots.push(root);
    await writeFile(path.join(root, 'package.json'), '{"name":"flat"}');
    // `zqMarker` appears in no summary field: not in a module name, a description,
    // a core API, a file path, or a hex id.
    await writeFile(path.join(root, 'compute.ts'), [
      "export function computeThing() { return 'zqMarker'; }",
      "export function computeThingTwo() { return 'zqMarker'; }",
      "export function computeThingThree() { return 'zqMarker'; }",
      '',
    ].join('\n'));
    // Six modules that outrank `helpers` on every module-level signal: they match
    // the requirement, and their core APIs match the target signature.
    const rivals = Array.from({ length: 6 }, (_, index) => `m${index + 1}`);
    for (const [index, id] of rivals.entries()) {
      await writeFile(path.join(root, `${id}.ts`), `export function paymentApi${index + 1}() { return ${index + 1}; }\n`);
    }

    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await runtime.registry.register({ repositoryId: 'history-flat', displayName: 'flat-history', localPath: root, role: 'history' });
    const run = await runtime.coordinator.run({ repositoryId: 'history-flat' });
    const index = (await runtime.store.getStructuralIndex(run.scope))!;
    const scope = { ...run.scope, projectId: index.projects[0]!.projectId };
    const base = { kind: 'feature', description: '', language: 'TypeScript', symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] };
    const proposal = {
      ...scope,
      analysisHash: index.analysisHash,
      objective: projectAnalysisObjective,
      summary: 'Flat symbol hierarchy',
      unassignedFiles: [],
      modules: [
        ...rivals.map((id) => ({ ...base, id, name: `Payment processor ${id}`, description: 'Submits customer payments',
          coreApis: ['computeThing'], sourceFiles: [`${id}.ts`] })),
        { ...base, id: 'helpers', name: 'Helper utilities', description: 'Helper utilities', coreApis: [],
          sourceFiles: ['compute.ts', 'package.json'] },
      ],
    };
    const analysis = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async () => ({ proposal,
      evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } }) });
    await analysis.ensure(scope, true);
    const ready = await analysis.read(scope);
    expect(ready.state, ready.error).toBe('ready');

    const target = { id: 'target-compute', name: 'computeThing', kind: 'function' as const, path: 'compute.ts', language: 'TypeScript' as const, signature: 'computeThing()' };
    const query = [target.name, target.signature, '', 'payment zqMarker'].join('\n');
    const summaries = await runtime.store.searchSearchDocuments!(scope, query, 20, 'summary');
    // The identity view also carries the implementation file name, so the
    // helper module is now a valid summary hit alongside the six rivals.
    expect([...new Set(summaries.map((document) => (JSON.parse(document.text) as { moduleId: string }).moduleId))].sort()).toEqual(['helpers', ...rivals].sort());

    const candidates = await runtime.moduleImplementationSearch.search({ target, requirement: 'payment zqMarker', topK: 3, repositoryIds: ['history-flat'] });
    const compute = candidates.find((candidate) => candidate.title === 'computeThing');
    expect(compute).toBeDefined();
    expect(compute!.path).toBe('compute.ts');
    // The module is still reported - as an annotation, not as a gate.
    expect(compute!.sourceModule).toMatchObject({ moduleId: 'helpers', name: 'Helper utilities', sourceFiles: ['compute.ts', 'package.json'] });
    // Two candidates per file: the sibling overloads cannot fill the page.
    expect(candidates.filter((candidate) => candidate.path === 'compute.ts')).toHaveLength(2);
    // The summary channel still works: a recalled module contributes its symbols.
    expect(candidates.some((candidate) => rivals.includes(candidate.sourceModule?.moduleId ?? ''))).toBe(true);
  });

  it('rejects searches without an explicitly scoped historical corpus', async () => {
    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await expect(runtime.moduleImplementationSearch.search({
      target: { id: 'target', name: 'run', kind: 'function', path: 'run.ts', language: 'TypeScript', signature: 'run()' },
      requirement: '',
      topK: 1,
      repositoryIds: [],
    })).rejects.toThrow(/参考工程/);
  });
});
