package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowDeliveryCoordinator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public final class WorkflowDeliveryCoordinator implements WorkflowDeliveryService {
    private final com.example.assetupgrade.security.TenantAuthorizer authorizer;
    private final com.example.assetupgrade.workflow.port.WorkflowDispatcher dispatcher;
    private final com.example.assetupgrade.workflow.port.EventEnvelopeRepository envelopes;
    private final com.example.assetupgrade.workflow.port.DeliveryAttemptRepository attempts;
    private final com.example.assetupgrade.audit.AuditPort audit;
    private final com.example.assetupgrade.retry.IdempotencyPort idempotency;
    private final com.example.assetupgrade.retry.RetryPolicy retryPolicy;
    private final com.example.assetupgrade.workflow.port.DeadLetterPort deadLetters;

    public WorkflowDeliveryCoordinator() {
        this(null, null, null, null, null, null, null, null);
    }

    public WorkflowDeliveryCoordinator(
            com.example.assetupgrade.security.TenantAuthorizer authorizer,
            com.example.assetupgrade.workflow.port.WorkflowDispatcher dispatcher,
            com.example.assetupgrade.workflow.port.EventEnvelopeRepository envelopes,
            com.example.assetupgrade.workflow.port.DeliveryAttemptRepository attempts,
            com.example.assetupgrade.audit.AuditPort audit,
            com.example.assetupgrade.retry.IdempotencyPort idempotency,
            com.example.assetupgrade.retry.RetryPolicy retryPolicy,
            com.example.assetupgrade.workflow.port.DeadLetterPort deadLetters) {
        this.authorizer = authorizer;
        this.dispatcher = dispatcher;
        this.envelopes = envelopes;
        this.attempts = attempts;
        this.audit = audit;
        this.idempotency = idempotency;
        this.retryPolicy = retryPolicy;
        this.deadLetters = deadLetters;
    }

    @Override
    public WorkflowDeliveryResult deliver(WorkflowDeliveryCommand command) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof WorkflowDeliveryCommand command) return deliver(command);
        throw new IllegalArgumentException("Expected WorkflowDeliveryCommand");
    }
}
