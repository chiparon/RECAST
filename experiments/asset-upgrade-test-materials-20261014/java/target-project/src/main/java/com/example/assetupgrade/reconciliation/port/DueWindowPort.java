package com.example.assetupgrade.reconciliation.port;

/**
 * Skeleton seam for DueWindowPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface DueWindowPort {
    java.util.List<com.example.assetupgrade.workflow.EventEnvelope> findDue(
            com.example.assetupgrade.common.TenantId tenantId,
            com.example.assetupgrade.reconciliation.DueWindow window);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
