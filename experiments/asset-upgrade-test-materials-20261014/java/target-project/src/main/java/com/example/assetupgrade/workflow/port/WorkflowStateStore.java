package com.example.assetupgrade.workflow.port;

/**
 * Skeleton seam for WorkflowStateStore.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface WorkflowStateStore {
    void save(com.example.assetupgrade.workflow.EventEnvelope envelope);
    java.util.Optional<com.example.assetupgrade.workflow.EventEnvelope> find(
            com.example.assetupgrade.common.TenantId tenantId, String eventId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
