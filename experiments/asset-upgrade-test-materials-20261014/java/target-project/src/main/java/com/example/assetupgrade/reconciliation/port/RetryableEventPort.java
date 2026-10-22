package com.example.assetupgrade.reconciliation.port;

/**
 * Skeleton seam for RetryableEventPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface RetryableEventPort {
    void markRetryable(com.example.assetupgrade.workflow.EventEnvelope envelope,
                       java.time.Instant nextAttemptAt);
    void close(com.example.assetupgrade.workflow.EventEnvelope envelope);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
