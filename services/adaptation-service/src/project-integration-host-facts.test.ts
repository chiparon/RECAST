import { describe, expect, it } from 'vitest';
import { compactIntegrationCoverage, encodeIntegrationFacts } from './project-integration-input';
import { decodeIntegrationFacts, prepareIntegrationHostFacts } from './project-integration-host-facts';

describe('Integration Host fact presentation', () => {
  it('reconstructs shared tables and grouped identities without changing observations', () => {
    const functions = Array.from({ length: 18 }, (_, index) => ({ target: { path: 'src/Port.java', name: 'operation' + index,
      signature: 'Port.operation' + index + '()' }, status: 'passed', executed: true, lineCoverage: index / 20 }));
    const failure = { id: 'original-id', runId: 'run-1', testId: 'public-case', status: 'unresolved', message: 'original expectation' };
    const modules = [{ moduleId: 'module-1', verification: { functions, testEvidence: { failures: [failure] } },
      attempts: [{ functions, testEvidence: { failures: [failure] } }] }];
    const encoded = encodeIntegrationFacts(compactIntegrationCoverage(modules));
    expect(decodeIntegrationFacts(JSON.parse(encoded))).toEqual(modules);
    const prepared = prepareIntegrationHostFacts([{ id: 'integration-verification-history', kind: 'summary', content: 'Host facts\n' + encoded }]);
    expect(prepared.failureReview.failureCount).toBe(1);
    expect(prepared.failureReview.failures[0].observations).toHaveLength(2);
    expect(prepared.failureReview.failures[0].originalMessage).toBe('original expectation');
  });
  it('retains historical unresolved facts alongside current explicit resolution and handles small inputs', () => {
    const failure = { id: 'failure-1', testId: 'case-1', message: 'original expectation', status: 'unresolved' };
    const modules = [{ moduleId: 'module-1', testEvidence: { failures: [{ ...failure, status: 'resolved' }] },
      attempts: [{ testEvidence: { failures: [failure] } }] }];
    const prepared = prepareIntegrationHostFacts([{ id: 'integration-verification-history', kind: 'summary', content: 'Host facts\n' + JSON.stringify(modules) }]);
    expect(prepared.modules).toEqual(modules);
    expect(prepared.failureReview.failures[0].observations.map((item: any) => item.status)).toEqual(['resolved', 'unresolved']);
    expect(prepared.failureReview.failures[0].observations[0].pointer).toBe('/modules/0/testEvidence/failures/0');
  });
  it('fails explicitly when retained Host evidence cannot be decoded', () => {
    expect(() => prepareIntegrationHostFacts([{ id: 'integration-verification-history', kind: 'summary', content: 'Missing facts' }])).toThrow();
    expect(() => decodeIntegrationFacts({ format: 'integration-shared-facts-v1', modules: { $ref: 'absent' }, sharedRecords: {} })).toThrow();
  });
});
