package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for ReconciliationOrchestrator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public final class ReconciliationOrchestrator implements ReconciliationService {
    private final com.example.assetupgrade.security.TenantAuthorizer authorizer;
    private final com.example.assetupgrade.reconciliation.port.DueWindowPort dueWindow;
    private final com.example.assetupgrade.reconciliation.port.RetryableEventPort retryableEvents;
    private final com.example.assetupgrade.reconciliation.port.LeasePort leases;
    private final com.example.assetupgrade.reconciliation.port.CheckpointPort checkpoints;
    private final com.example.assetupgrade.audit.AuditPort audit;
    private final com.example.assetupgrade.workflow.WorkflowDeliveryService workflow;

    public ReconciliationOrchestrator() {
        this(null, null, null, null, null, null, null);
    }

    public ReconciliationOrchestrator(
            com.example.assetupgrade.security.TenantAuthorizer authorizer,
            com.example.assetupgrade.reconciliation.port.DueWindowPort dueWindow,
            com.example.assetupgrade.reconciliation.port.RetryableEventPort retryableEvents,
            com.example.assetupgrade.reconciliation.port.LeasePort leases,
            com.example.assetupgrade.reconciliation.port.CheckpointPort checkpoints,
            com.example.assetupgrade.audit.AuditPort audit,
            com.example.assetupgrade.workflow.WorkflowDeliveryService workflow) {
        this.authorizer = authorizer;
        this.dueWindow = dueWindow;
        this.retryableEvents = retryableEvents;
        this.leases = leases;
        this.checkpoints = checkpoints;
        this.audit = audit;
        this.workflow = workflow;
    }

    @Override
    public ReconciliationReport run(ReconciliationCommand command) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof ReconciliationCommand command) return run(command);
        throw new IllegalArgumentException("Expected ReconciliationCommand");
    }
}
