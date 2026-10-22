import { describe, it, expect } from 'vitest';
import { scoreCase, summarize } from './scoring.js';
const gold = { repositoryId: 'r', revision: 'v', projectId: 'p', moduleId: 'm' };
const match = { sourceModule: { ...gold, analysisRevision: 'v' } };
describe('held-out module scoring', () => {
  it('distinguishes recall from a reranking miss', () => {
    expect(scoreCase({ gold }, [match], [])).toMatchObject({ goldRecalledBeforeRerank: true, exactHitAt4: false, mrrAt4: 0 });
  });
  it('uses repository, revision, project and module together', () => {
    const wrong = { sourceModule: { ...gold, projectId: 'other' } };
    expect(scoreCase({ gold }, [wrong], [wrong]).exactHitAt4).toBe(false);
  });
  it('scores ranking and equivalent answers independently', () => {
    const alternative = { ...gold, moduleId: 'other' };
    expect(scoreCase({ gold, equivalentAnswers: [alternative] }, [], [{ sourceModule: alternative }, match])).toMatchObject({ exactRankAt4: 2, mrrAt4: 0.5, exactHitAt1: false, equivalentHitAt4: true });
  });
  it('does not hide failures by shrinking the denominator', () => {
    const metric = scoreCase({ gold }, [match], [match]);
    const summary = summarize([{ status: 'success', metrics: metric }, { status: 'error' }, { status: 'rerank-fallback', metrics: metric }], 3);
    expect(summary.hitAt4).toBeCloseTo(1 / 3);
    expect(summary.errors).toBe(1); expect(summary.rerankFallbacks).toBe(1);
  });
});
