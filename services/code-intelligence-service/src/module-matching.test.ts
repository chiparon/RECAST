import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleTarget, ProjectModuleProposal } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator, projectPlanHash, projectAnalysisObjective } from './index.js';
import { searchModules, type ModuleSearchTiming } from './module-matching.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const target: ModuleTarget = { id: 'target', kind: 'module', name: 'Payment', path: 'Payment.cs', language: 'C#',
  signature: 'SubmitPayment, RecoverPayment', module: { sourceFiles: ['Payment.cs'], coreApis: ['SubmitPayment', 'RecoverPayment'], dependsOn: [] } };

async function setup(extraSources: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'module-matching-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), '{"name":"payment"}');
  await writeFile(path.join(root, 'payment.ts'), 'export function submitPayment() { return true; }');
  await writeFile(path.join(root, 'receipt.ts'), 'export function receipt() { return "accepted"; }');
  await Promise.all(Object.entries(extraSources).map(([file, source]) => writeFile(path.join(root, file), source)));
  const store = new InMemoryIndexStore();
  const runtime = await createCodeIntelligenceRuntime({ store });
  await runtime.registry.register({ repositoryId: 'history', localPath: root, role: 'history', displayName: 'History' });
  const run = await runtime.coordinator.run({ repositoryId: 'history' });
  const index = (await store.getStructuralIndex(run.scope))!;
  const scope = { ...run.scope, projectId: index.projects[0]!.projectId };
  const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => {
    const proposal = { ...run.scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: 'Payment module',
      modules: [{ id: 'payments', name: 'Payment processing', kind: 'feature', description: 'Submit payments and retain receipts',
        language: 'TypeScript', coreApis: ['submitPayment'], sourceFiles: index.files.map((file) => file.relativePath),
        symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] }] };
    return { proposal, evidence: { ...run.scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
  } });
  await analysis.ensure(scope);
  const ready = await analysis.read(scope);
  expect(ready.state, ready.error).toBe('ready');
  return { runtime, store, scope, index };
}

async function competingModules() {
  const { store, scope, index } = await setup(Object.fromEntries([
    ...Array.from({ length: 12 }, (_, i) => [`decoy${i}.ts`, `export function decoy${i}() { return ${i}; }`]),
    ['blank.ts', ' \n\t '],
  ]));
  const base = { kind: 'feature', language: 'TypeScript', description: 'Implementation', coreApis: [], symbolKeys: [],
    dependsOn: [], evidenceIds: [`project:${scope.projectId}`] };
  const proposal: ProjectModuleProposal = { ...scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective,
    summary: 'Competing retrieval signals', modules: [
      { ...base, id: 'parent', name: 'Payment subsystem', nodeKind: 'subsystem', sourceFiles: [],
        refinement: { state: 'split', reason: 'Implementation leaf', decisionSource: 'structural' } },
      ...index.files.map((file) => ({ ...base, id: file.relativePath, name: file.relativePath, nodeKind: 'module' as const,
        parentId: file.relativePath === 'payment.ts' ? 'parent' : null, sourceFiles: [file.relativePath],
        refinement: { state: 'leaf' as const, reason: 'Single responsibility', decisionSource: 'structural' as const } })),
    ] };
  const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => ({ proposal,
    evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } }) });
  await analysis.ensure(scope, true);
  expect((await analysis.read(scope)).state).toBe('ready');
  const summaries = (await store.listSearchDocuments(scope)).filter((doc) => doc.kind === 'summary' &&
    !JSON.parse(doc.text).view && doc.title !== 'blank.ts');
  vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, limit, kind) => {
    if (kind === 'source-fragment') return [{ ...scope, searchDocumentId: 'blank-gap', kind, relativePath: 'blank.ts',
      title: 'Payment health implementation', text: ' \n\t ', contentHash: 'blank',
      retrievalScore: { semantic: 1, lexical: 100, fusion: 2 / 61 } }];
    if (kind !== 'summary') return [];
    return summaries.map((doc, i) => ({ ...doc, retrievalScore: {
      semantic: doc.title === 'receipt.ts' ? 0.99 : doc.title === 'payment.ts' ? 0.6 : 0.98 - i / 1000,
      lexical: doc.title === 'payment.ts' ? 10 : 0,
      fusion: doc.title === 'payment.ts' ? 2 / 61 : 1 / (90 + i),
    } })).slice(0, limit);
  });
  return { store };
}

describe('module-to-module matching', () => {
  it('keeps lexical/vector agreement ahead of a higher cosine score and ignores blank evidence', async () => {
    const { store } = await competingModules();
    const results = await searchModules(store, { target: { ...target, module: { ...target.module!, coreApis: [] } },
      requirement: 'payment', topK: 1, repositoryIds: ['history'] });
    expect(results[0]!.sourceModule?.moduleId).toBe('payment.ts');
    expect(results[0]!.score.semantic).toBe(0.6);
    expect(results[0]!.score.overall).toBeCloseTo(0.8);
  });

  it('gives the model both ranking signals, deduplicates parent manifests and bounds the shortlist', async () => {
    const { store } = await competingModules();
    let documents: readonly string[] = [];
    const reranker = { model: 'test-model', rank: async (_query: string, supplied: readonly string[]) => {
      documents = supplied;
      const chosen = supplied.findIndex((doc) => doc.startsWith('payment.ts\n'));
      expect(chosen).toBeGreaterThanOrEqual(0);
      return [chosen, ...supplied.map((_, index) => index).filter((index) => index !== chosen)]
        .map((index, rank) => ({ index, score: 1 - rank / supplied.length }));
    } };
    const results = await searchModules(store, { target: { ...target, module: { ...target.module!, coreApis: [] } },
      requirement: 'payment', topK: 4, repositoryIds: ['history'] }, undefined, reranker);
    expect(results[0]!.sourceModule?.moduleId).toBe('payment.ts');
    expect(documents.some((doc) => doc.startsWith('receipt.ts\n'))).toBe(true);
    expect(documents.filter((doc) => doc.includes('// payment.ts\n'))).toHaveLength(1);
    expect(documents.some((doc) => doc.startsWith('blank.ts\n'))).toBe(false);
    expect(documents.length).toBeLessThanOrEqual(16);
    expect(documents.length).toBeGreaterThan(8);
  });

  it.each([[], [{ index: 0, score: NaN }], [{ index: 3, score: 0.5 }], [{ index: 0, score: 2 }],
    [{ index: 0, score: 0.5 }, { index: 0, score: 0.5 }]].map((ordering) => ({ ordering })))('retains valid candidates on malformed model output $ordering', async ({ ordering }) => {
    const { store } = await setup();
    let timing: Readonly<ModuleSearchTiming> | undefined;
    const results = await searchModules(store, { target, requirement: 'payment', topK: 1, repositoryIds: ['history'] },
      undefined, { model: 'malformed', rank: async () => ordering }, undefined, (value) => { timing = value; });
    expect(results).toHaveLength(1);
    expect(results[0]!.sourceModule?.moduleId).toBe('payments');
    expect(timing).toMatchObject({ outcome: 'success', rerankFallback: true });
    expect(timing!.rerankError).toContain('invalid candidate ordering');
  });

  it('retains partial timings when model reranking fails', async () => {
    const { store } = await setup();
    let timing: Readonly<ModuleSearchTiming> | undefined;
    const reranker = { model: 'failed-model', rank: async () => { throw new Error('model timeout'); } };
    const result = await searchModules(store, { target, requirement: 'payment', topK: 1, repositoryIds: ['history'] },
      undefined, reranker, undefined, (value) => { timing = value; });
    expect(result).toHaveLength(1);
    expect(timing).toMatchObject({ outcome: 'success', rerankFallback: true, rerankCandidateCount: 1, revisionCheckMs: expect.any(Number) });
    expect(timing!.rerankError).toContain('model timeout');
    expect(timing!.recallAndAggregateMs).toBeGreaterThan(0);
    expect(timing!.candidatePrepareMs).toBeGreaterThan(0);
    expect(timing!.rerankMs).toBeGreaterThan(0);
    expect(timing!.totalMs).toBeCloseTo(timing!.queueMs + timing!.recallAndAggregateMs +
      timing!.candidatePrepareMs + timing!.rerankMs + timing!.revisionCheckMs, 5);
  });

  it('records pre-search cancellation without reporting model work or masking the error', async () => {
    const { store } = await setup();
    const observe = vi.fn(() => { throw new Error('diagnostics failed'); });
    await expect(searchModules(store, { target, requirement: 'payment', topK: 1, repositoryIds: ['history'] },
      AbortSignal.abort(new Error('cancelled')), undefined, undefined, observe)).rejects.toThrow('cancelled');
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', failedStage: 'queueMs',
      recallAndAggregateMs: 0, candidatePrepareMs: 0, rerankMs: 0, executionMs: 0 }));
  });

  it('reuses a module result only while every historical revision is unchanged', async () => {
    const { runtime, store } = await setup();
    const recall = vi.spyOn(store, 'searchSearchDocuments');
    const request = { target, requirement: 'payment', topK: 1, repositoryIds: ['history'] };
    const first = await runtime.moduleImplementationSearch.search(request);
    const callsAfterFirst = recall.mock.calls.length;
    const second = await runtime.moduleImplementationSearch.search(request);
    expect(second).toEqual(first);
    expect(recall.mock.calls.length).toBe(callsAfterFirst);
    await store.putRepository({ ...(await store.getRepository('history'))!, activeRevision: 'new-revision' });
    const invalidated = await runtime.moduleImplementationSearch.search(request);
    expect(invalidated).not.toEqual(first);
  });

  it('returns the complete module once across multiple views without hydrating the full index', async () => {
    const { runtime, store, index } = await setup();
    for (const method of ['getStructuralIndex', 'listSearchDocuments', 'listModuleArtifacts', 'listSymbols', 'listFiles'] as const) {
      vi.spyOn(store, method).mockRejectedValue(new Error(`Unbounded access: ${method}`));
    }
    const results = await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'module', title: 'Payment processing', language: 'TypeScript',
      sourceModule: { moduleId: 'payments', sourceFiles: index.files.map((file) => file.relativePath) },
      moduleMatch: { matchedApis: ['SubmitPayment'], missingApis: ['RecoverPayment'], verification: 'interface-only' } });
    expect(results[0]!.preview).toContain('submitPayment');
    expect(results[0]!.preview).toContain('receipt');
  });

  it('does not turn empty recall into an unbounded summary scan', async () => {
    const { runtime, store } = await setup();
    vi.spyOn(store, 'searchSearchDocuments').mockResolvedValue([]);
    const list = vi.spyOn(store, 'listSearchDocuments').mockRejectedValue(new Error('No fallback'));
    expect(await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('retains the entire descendant manifest when matching a parent module', async () => {
    const { runtime, store, scope, index } = await setup();
    const base = { kind: 'feature', description: 'Payment receipt implementation', language: 'TypeScript', symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] };
    const proposal: ProjectModuleProposal = { ...scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: 'Payment hierarchy', modules: [
      { ...base, id: 'parent', name: 'Payment subsystem', nodeKind: 'subsystem', sourceFiles: [], refinement: { state: 'split', reason: 'Separate implementation', decisionSource: 'structural' } },
      { ...base, id: 'leaf', name: 'Payment implementation', parentId: 'parent', nodeKind: 'module', sourceFiles: index.files.map((file) => file.relativePath), refinement: { state: 'leaf', reason: 'Cohesive implementation', decisionSource: 'structural' } },
    ] };
    const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => ({ proposal,
      evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } }) });
    await analysis.ensure(scope, true);
    const ready = await analysis.read(scope);
    expect(ready.state, ready.error).toBe('ready');
    const parentDocuments = (await store.listSearchDocuments(scope)).filter((document) => document.kind === 'summary' && JSON.parse(document.text).moduleId === 'parent');
    vi.spyOn(store, 'searchSearchDocuments').mockResolvedValue(parentDocuments);
    const previews = vi.spyOn(store, 'getSourcePreview');
    const candidates = await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 3, repositoryIds: ['history'] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sourceModule?.sourceFiles).toEqual(index.files.map((file) => file.relativePath));
    expect(candidates[0]!.sourceModule?.moduleId).toBe('parent');
    expect(candidates[0]!.preview).toContain('submitPayment');
    expect(previews).toHaveBeenCalledTimes(3);
    const implementations = await runtime.moduleImplementationSearch.search({ target: { ...target, kind: 'function', name: 'submitPayment', signature: 'submitPayment()' }, requirement: 'payment', topK: 3, repositoryIds: ['history'] });
    expect(implementations.some((candidate) => candidate.title === 'submitPayment' && candidate.sourceModule?.moduleId === 'parent')).toBe(true);
    expect(implementations.every((candidate) => index.files.some((file) => file.relativePath === candidate.path))).toBe(true);
  });

  it('rejects an artifact whose proposal no longer matches its evidence hash', async () => {
    const { runtime, store } = await setup();
    const get = store.getModuleArtifacts.bind(store);
    vi.spyOn(store, 'getModuleArtifacts').mockImplementation(async (scope, ids) => {
      const records = await get(scope, ids);
      return records.map((record) => ({ ...record, planHash: 'tampered' }));
    });
    expect(await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).toEqual([]);
  });

  it('bounds preview reads while retaining the complete source manifest', async () => {
    const { runtime, store } = await setup();
    const preview = vi.spyOn(store, 'getSourcePreview').mockResolvedValue({ text: 'x'.repeat(4_000), truncated: true });
    const result = await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] });
    expect(preview).toHaveBeenCalledTimes(3);
    expect(preview.mock.calls.every(([, , maxChars]) => maxChars === 4_000)).toBe(true);
    expect(result[0]!.moduleMatch?.previewTruncated).toBe(true);
    expect(result[0]!.sourceModule?.sourceFiles).toHaveLength(3);
    expect(result[0]!.preview.length).toBeLessThan(12_200);
  });

  it('honors cancellation before touching the repository', async () => {
    const { runtime, store } = await setup();
    const read = vi.spyOn(store, 'getRepository');
    await expect(runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] },
      AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a revision change during source preview', async () => {
    const { runtime, store } = await setup();
    const read = store.getSourceText.bind(store);
    vi.spyOn(store, 'getSourceText').mockImplementation(async (scope, file) => {
      const repository = (await store.getRepository(scope.repositoryId))!;
      await store.putRepository({ ...repository, activeRevision: 'new-revision' });
      return read(scope, file);
    });
    await expect(runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).rejects.toThrow('revision changed');
  });

  it('excludes target repositories and bounds corpus size', async () => {
    const { runtime, store } = await setup();
    await store.putRepository({ ...(await store.getRepository('history'))!, role: 'target' });
    expect(await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).toEqual([]);
    await expect(runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: Array.from({ length: 33 }, (_, i) => String(i)) })).rejects.toThrow('32');
  });

  it('attributes an implementation fragment to a sibling module whose summary never matched', async () => {
    const { runtime, store, scope, index } = await setup();
    const base = { kind: 'feature', description: 'Helper utilities', language: 'TypeScript', symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] };
    const leaf = { state: 'leaf' as const, reason: 'Cohesive implementation', decisionSource: 'structural' as const };
    // `payments` is recalled by its summary; `helpers` shares the proposal but has
    // no summary field containing `accepted`, so only its code can identify it.
    const proposal: ProjectModuleProposal = { ...scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: 'Upload hierarchy', modules: [
      { ...base, id: 'payments', name: 'Upload payment pipeline', description: 'Upload gateway', nodeKind: 'module', sourceFiles: ['package.json'], refinement: leaf },
      { ...base, id: 'helpers', name: 'Helper utilities', description: 'Helper utilities', nodeKind: 'module', sourceFiles: ['payment.ts', 'receipt.ts'], refinement: leaf },
    ] };
    const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => ({ proposal,
      evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } }) });
    await analysis.ensure(scope, true);
    const ready = await analysis.read(scope);
    expect(ready.state, ready.error).toBe('ready');
    const target: ModuleTarget = { id: 'target', kind: 'module', name: 'Upload', path: 'receipt.ts', language: 'TypeScript',
      signature: 'accepted', documentation: 'accepted', module: { sourceFiles: ['receipt.ts'], coreApis: [], dependsOn: [] } };
    const query = [target.name, target.signature, target.documentation, 'accepted'].join('\n');
    const summaryOnly = await store.searchSearchDocuments!(scope, query, 20, 'summary');
    expect([...new Set(summaryOnly.map((document) => (JSON.parse(document.text) as { moduleId: string }).moduleId))]).toEqual(['payments']);
    const candidates = await runtime.moduleImplementationSearch.search({ target, requirement: 'accepted', topK: 3, repositoryIds: ['history'] });
    expect(candidates.map((candidate) => candidate.sourceModule?.moduleId).sort()).toEqual(['helpers', 'payments']);
    expect(candidates.find((candidate) => candidate.sourceModule?.moduleId === 'helpers')!.sourceModule?.sourceFiles)
      .toEqual(['payment.ts', 'receipt.ts']);
  });
});
