import { describe, expect, it } from 'vitest';
import type { ModuleHierarchyDecisionRequest } from '@forexplore/contracts';
import { parseModuleHierarchyDecision, parseModuleHierarchyDecisionRequest } from '../../services/code-intelligence-service/src/module-hierarchy-planner.js';
import { fixedBoundaryPlanner } from './fixed-boundary.js';

const request: ModuleHierarchyDecisionRequest = {
  repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', analysisHash: 'hash',
  nodeId: 'root', name: 'Skeleton', depth: 0, metrics: { fileCount: 2, sourceBytes: 200, symbolCount: 2 },
  candidates: ['service', 'models'].map((id, i) => ({ id, name: id, relativePath: 'src',
    fileCount: 1, sourceBytes: 100, symbolCount: 1, languages: ['python'],
    samplePaths: [`src/${id}.py`], coreApis: [i ? 'Request' : 'execute'], evidenceIds: [`file:${id}`] })),
  dependencies: [{ sourceId: 'service', targetId: 'models', count: 1, evidenceIds: ['dependency:one'] }],
  excerpts: [{ relativePath: 'src/service.py', content: 'def execute(): ...', evidenceId: 'file:service' }],
};

describe('fixed skeleton evaluation boundary', () => {
  it('keeps whole-scope facts and evidence valid at both model and publication boundaries', async () => {
    const before = structuredClone(request);
    const signal = new AbortController().signal;
    const planner = fixedBoundaryPlanner({ async decide(input, receivedSignal) {
      expect(receivedSignal).toBe(signal);
      const bounded = parseModuleHierarchyDecisionRequest(input);
      expect(bounded.candidates).toHaveLength(1);
      expect(bounded.candidates[0]).toMatchObject({ ...request.metrics,
        samplePaths: ['src/service.py', 'src/models.py'], coreApis: ['execute', 'Request'] });
      expect(bounded.dependencies[0]).toMatchObject({ sourceId: bounded.candidates[0]!.id,
        targetId: bounded.candidates[0]!.id, count: 1, evidenceIds: ['dependency:one'] });
      expect(bounded.excerpts).toEqual(request.excerpts);
      return parseModuleHierarchyDecision({ action: 'stop', nodeKind: 'module', name: '业务模块',
        description: '处理请求与数据模型', reason: 'No smaller candidate boundaries', stopReason: 'no-valid-split',
        evidenceIds: ['file:service', 'file:models', 'dependency:one'] }, bounded);
    } });
    const decision = await planner.decide(request, signal);
    expect(parseModuleHierarchyDecision(decision, request).action).toBe('stop');
    expect(request).toEqual(before);
  });

  it('refuses a delegate that tries to change the evaluation unit', async () => {
    const planner = fixedBoundaryPlanner({ async decide() {
      return { action: 'split', nodeKind: 'module', name: 'bad', description: 'bad', reason: 'bad', evidenceIds: ['file:service'], children: [] };
    } });
    await expect(planner.decide(request)).rejects.toThrow('cannot be split');
  });
});
