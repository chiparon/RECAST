import { describe, expect, it } from 'vitest';
import { orderByResponsibilityCoverage, type RetrievalRerankInput } from './retrieval-rerank';

const input: RetrievalRerankInput = { requirement: 'Process documents, deliver jobs and reconcile state',
  candidates: ['jobs', 'jobs-helper', 'jobs-parent', 'jobs-interface', 'documents', 'state', 'unrelated'].map(id =>
    ({ id, name: id, relativePath: '', granularity: 'module' })) };
const evidence = { responsibilities: ['job delivery', 'document intake', 'state reconciliation'], candidates: [
  { id: 'jobs', score: 0.98, covers: [0] },
  { id: 'jobs-helper', score: 0.97, covers: [0] },
  { id: 'jobs-parent', score: 0.96, covers: [0] },
  { id: 'jobs-interface', score: 0.95, covers: [0] },
  { id: 'documents', score: 0.8, covers: [1] },
  { id: 'state', score: 0.75, covers: [2] },
  { id: 'unrelated', score: 0.2, covers: [] },
] };

describe('bounded complementary reference ranking', () => {
  it('keeps strong references for independent duties ahead of repeated job evidence', () => {
    const ordered = orderByResponsibilityCoverage(input, evidence);
    expect(ordered.slice(0, 4)).toEqual(['jobs', 'documents', 'state', 'jobs-helper']);
    expect(new Set(ordered)).toEqual(new Set(input.candidates.map(candidate => candidate.id)));
  });

  it('does not force diversity for one responsibility or promote weak unrelated evidence', () => {
    const single = { responsibilities: ['jobs'], candidates: evidence.candidates.map(candidate => ({ ...candidate,
      covers: candidate.id.startsWith('jobs') ? [0] : candidate.id === 'unrelated' ? [0] : [] })) };
    expect(orderByResponsibilityCoverage(input, single).slice(0, 4))
      .toEqual(['jobs', 'jobs-helper', 'jobs-parent', 'jobs-interface']);
    const weak = { ...evidence, candidates: evidence.candidates.map(candidate => ({ ...candidate,
      score: candidate.id === 'documents' ? 0.3 : candidate.score })) };
    expect(orderByResponsibilityCoverage(input, weak).slice(0, 4)).not.toContain('documents');
  });

  it.each([
    { ...evidence, candidates: evidence.candidates.slice(1) },
    { ...evidence, candidates: evidence.candidates.map(candidate => ({ ...candidate, id: 'invented' })) },
    { ...evidence, candidates: evidence.candidates.map(candidate => ({ ...candidate, covers: [3] })) },
    { ...evidence, candidates: evidence.candidates.map(candidate => ({ ...candidate, score: Number.NaN })) },
    { ...evidence, responsibilities: [] },
  ])('rejects incomplete or invented ranking evidence', value => {
    expect(() => orderByResponsibilityCoverage(input, value)).toThrow();
  });
});
