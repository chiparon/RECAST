package com.example.assetupgrade.reconciliation.port;

/**
 * Skeleton seam for CheckpointPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface CheckpointPort {
    java.util.Optional<com.example.assetupgrade.reconciliation.Checkpoint> get(
            com.example.assetupgrade.common.TenantId tenantId, String jobName);
    void put(com.example.assetupgrade.common.TenantId tenantId,
             com.example.assetupgrade.reconciliation.Checkpoint checkpoint);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
