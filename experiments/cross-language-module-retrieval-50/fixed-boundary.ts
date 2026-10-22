import type { ModuleHierarchyDecisionRequest, ModuleHierarchyPlanner } from '@forexplore/contracts';

export const boundaryPolicy = 'one-complete-skeleton-per-module/v1';

/** Experiment-only boundary: describe the complete scope, without inventing smaller evaluation units. */
export function fixedBoundaryPlanner(delegate: ModuleHierarchyPlanner): ModuleHierarchyPlanner {
  return {
    async decide(request, signal) {
      const groupId = 'fixed-evaluation-unit';
      const unique = (values: string[], limit: number) => [...new Set(values)].slice(0, limit);
      const bounded: ModuleHierarchyDecisionRequest = {
        ...request,
        candidates: [{
          id: groupId, name: request.name.slice(0, 160), relativePath: '', ...request.metrics,
          languages: unique(request.candidates.flatMap(c => c.languages), 32),
          samplePaths: unique(request.candidates.flatMap(c => c.samplePaths), 12),
          coreApis: unique(request.candidates.flatMap(c => c.coreApis), 24),
          evidenceIds: unique(request.candidates.flatMap(c => c.evidenceIds), 64),
        }],
        // Preserve dependency evidence, now internal to the indivisible evaluation unit.
        dependencies: request.dependencies.map(edge => ({ ...edge, sourceId: groupId, targetId: groupId })),
      };
      const decision = await delegate.decide(bounded, signal);
      if (decision.action !== 'stop') throw new Error('Fixed evaluation boundary cannot be split');
      return { ...decision, nodeKind: 'module', stopReason: 'no-valid-split',
        reason: `Evaluation boundary is fixed to the complete skeleton. ${decision.reason}` };
    },
  };
}
