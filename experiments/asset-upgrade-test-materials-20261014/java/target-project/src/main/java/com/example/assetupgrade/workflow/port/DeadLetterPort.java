package com.example.assetupgrade.workflow.port;

/**
 * Skeleton seam for DeadLetterPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface DeadLetterPort {
    void publish(com.example.assetupgrade.workflow.WorkflowEvent event, String reason, int attempts);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
