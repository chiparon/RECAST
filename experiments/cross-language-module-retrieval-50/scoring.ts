export interface ModuleIdentity { repositoryId: string; revision?: string; analysisRevision?: string; projectId?: string; moduleId: string }
export interface ScoredCandidate { sourceModule?: ModuleIdentity }
export const identityKey = (m: ModuleIdentity) => JSON.stringify([m.repositoryId, m.analysisRevision ?? m.revision, m.projectId ?? null, m.moduleId]);
export function scoreCase(answer: { gold: ModuleIdentity; equivalentAnswers?: ModuleIdentity[] }, before: readonly ScoredCandidate[], after: readonly ScoredCandidate[]) {
  const gold = identityKey(answer.gold);
  const keys = after.map(c => c.sourceModule ? identityKey(c.sourceModule) : '');
  const rank = keys.indexOf(gold) + 1;
  const relevant = new Set([gold, ...(answer.equivalentAnswers ?? []).map(identityKey)]);
  return { goldRecalledBeforeRerank: before.some(c => c.sourceModule && identityKey(c.sourceModule) === gold),
    exactRankAt4: rank || null, exactHitAt1: rank === 1, exactHitAt4: rank > 0 && rank <= 4,
    mrrAt4: rank > 0 && rank <= 4 ? 1 / rank : 0, equivalentHitAt4: keys.slice(0, 4).some(key => relevant.has(key)) };
}
export function summarize(rows: any[], expected: number) {
  const successful = rows.filter(r => r.status === 'success');
  const score = (key: string) => rows.reduce((sum, r) => sum + (r.status === 'success' ? Number(r.metrics?.[key] ?? 0) : 0), 0) / expected;
  return { expected, observed: rows.length, completed: successful.length,
    errors: rows.filter(r => r.status === 'error').length, rerankFallbacks: rows.filter(r => r.status === 'rerank-fallback').length,
    denominator: 'All requested case-rounds; errors/fallbacks receive zero in primary metrics',
    recallBeforeRerank: rows.reduce((sum, r) => sum + Number(r.metrics?.goldRecalledBeforeRerank ?? 0), 0) / expected,
    hitAt1: score('exactHitAt1'), hitAt4: score('exactHitAt4'), mrrAt4: score('mrrAt4'), equivalentHitAt4: score('equivalentHitAt4'),
    complete: rows.length === expected };
}
