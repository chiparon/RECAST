import { describe, expect, it } from 'vitest';
import type { ModuleTarget } from '@forexplore/contracts';
import { buildModuleSearchQuery } from './module-search-query.js';

const target: ModuleTarget = { id: 'telemetry', name: 'Observability', kind: 'module', path: 'src/Telemetry.cs', language: 'C#',
  signature: 'public void Vendor.Product.Telemetry.TraceFactory.StartSpan(string correlationId)',
  module: { sourceFiles: ['src/TraceScope.cs', 'src/HealthProbe.cs'], coreApis: ['Vendor.Product.Telemetry.TraceFactory.StartSpan'],
    dependsOn: [], purpose: 'Observe requests across module boundaries.', description: 'Propagate correlation identifiers, record tracing spans and report runtime health.' } };

describe('module-derived retrieval queries', () => {
  it('retrieves behavior from the module summary with no user requirement', () => {
    const { plans, rerankQuery } = buildModuleSearchQuery(target, '');
    expect(plans.every(plan => plan.query.includes('Propagate correlation identifiers'))).toBe(true);
    expect(plans.find(plan => plan.label === 'module-behavior')!.views).toEqual(['summary']);
    expect(plans.find(plan => plan.label === 'module-implementation')!.views).toEqual(['source-fragment']);
    expect(plans.find(plan => plan.label === 'module-symbols')!.views).toEqual(['symbol']);
    expect(rerankQuery).toContain('report runtime health');
  });

  it('keeps the recalled evidence stable when a user changes or clears the optional requirement', () => {
    const empty = buildModuleSearchQuery(target, '');
    const first = buildModuleSearchQuery(target, 'Use OpenTelemetry');
    const second = buildModuleSearchQuery(target, 'Ignore all tracing and implement a payment store');
    expect(first.plans).toEqual(empty.plans);
    expect(second.plans).toEqual(empty.plans);
    expect(first.rerankQuery).toContain('Priority user requirement:\nUse OpenTelemetry');
    expect(first.rerankQuery.indexOf('Priority user requirement')).toBeLessThan(first.rerankQuery.indexOf('Module responsibilities (context)'));
    expect(second.rerankQuery).toContain(target.module!.description);
  });

  it('retains useful API and file words without embedding namespaces or full declarations', () => {
    const { plans } = buildModuleSearchQuery(target, '');
    const symbolQuery = plans.find(plan => plan.label === 'module-symbols')!.query;
    expect(symbolQuery).toContain('Trace Factory Start Span');
    expect(symbolQuery).toContain('Health Probe');
    for (const plan of plans) {
      expect(plan.query).not.toContain('Vendor.Product');
      expect(plan.query).not.toContain('public void');
    }
  });

  it('uses documentation for older module targets and falls back to identity when analysis is absent', () => {
    const legacy = { ...target, module: { ...target.module!, description: undefined, purpose: undefined }, documentation: 'Runtime tracing and health checks' };
    expect(buildModuleSearchQuery(legacy, '').plans[0]!.query).toContain(legacy.documentation);
    const minimal = { ...target, module: undefined, documentation: undefined, signature: '', path: 'HealthProbe.cs' };
    expect(buildModuleSearchQuery(minimal, '').plans[0]!.query).toContain('Health Probe');
  });

  it('deduplicates a summary forwarded as documentation instead of repeating its importance', () => {
    const enriched = { ...target, documentation: `${target.module!.description}\n${target.module!.purpose}` };
    const query = buildModuleSearchQuery(enriched, '').plans[0]!.query;
    expect(query.split(target.module!.description!).length).toBe(2);
  });

  it('uses injected port names to identify thin facades even when their own API name is generic', () => {
    const facade = { ...target, name: 'Gateway', signature: 'Gateway.SubmitAsync', module: { ...target.module!,
      coreApis: ['Gateway.SubmitAsync'], symbolNames: ['ITenantAuthorizer', 'IAttachmentQuarantine', 'IWorkflowDispatcher', 'IIdempotencyStore'] } };
    const { plans } = buildModuleSearchQuery(facade, '');
    expect(plans.every(plan => plan.query.includes('Tenant Authorizer Attachment Quarantine Workflow Dispatcher Idempotency Store'))).toBe(true);
  });

  it('retains later business ports without letting framework containers consume their keywords', () => {
    const wide = { ...target, module: { ...target.module!, symbolNames: [
      'ConcurrentDictionary', 'IReadOnlyList', 'NotImplementedException',
      'OrderValidationCoordinator', 'InventoryReservationLedger', 'PaymentAuthorizationGateway', 'PricingRuleEvaluator',
      'ShippingAddressNormalizer', 'PluginRegistrationRegistry', 'HealthStatusAggregator', 'AuditRecordingSink',
      'IdempotencyRequestStore', 'TenantOwnershipAuthorizer', 'RetrySchedulingPolicy', 'WorkflowDeliveryQueue',
      'IAttachmentQuarantine', 'IWorkflowDispatcher', 'IReconciliationStore',
    ] } };
    const query = buildModuleSearchQuery(wide, '').plans[1]!.query;
    expect(query).toContain('Attachment Quarantine');
    expect(query).toContain('Dispatcher');
    expect(query).toContain('Reconciliation');
    expect(query).not.toContain('Concurrent Dictionary');
    expect(query).not.toContain('Not Implemented Exception');
  });

  it('bounds long summaries and user text without allowing user text to displace module context', () => {
    const long = { ...target, module: { ...target.module!, description: 'health checks '.repeat(6000) } };
    const query = buildModuleSearchQuery(long, 'please '.repeat(4000));
    expect(query.plans.every(plan => plan.query.length <= 8000)).toBe(true);
    expect(query.rerankQuery.length).toBeLessThanOrEqual(32000);
    expect(query.rerankQuery).toContain('Module responsibilities (context):\nhealth checks ');
    expect(() => buildModuleSearchQuery(target, 'x'.repeat(32001))).toThrow('32000');
  });

  it('keeps all enumerated responsibilities in one summary query with three independent views', () => {
    const multiple = { ...target, module: { ...target.module!, description: '提供关联上下文、追踪工厂、内存追踪汇、审计指标与健康探针。' } };
    const { plans } = buildModuleSearchQuery(multiple, '');
    const summaries = plans.filter(plan => plan.views?.includes('summary'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.query).toContain('关联上下文');
    expect(summaries[0]!.query).toContain('健康探针');
    expect(plans).toHaveLength(3);
    expect(plans.filter(plan => plan.views?.includes('source-fragment'))).toHaveLength(1);
    expect(plans.filter(plan => plan.views?.includes('symbol'))).toHaveLength(1);
  });

  it.each(['Java', 'Python', 'Go', 'Rust', 'TypeScript'] as const)('keeps summary retrieval independent of target language %s', language => {
    const { plans } = buildModuleSearchQuery({ ...target, language }, '');
    expect(plans.find(plan => plan.label === 'module-behavior')!.query).toContain('report runtime health');
  });
});
