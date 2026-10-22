package com.example.assetupgrade.reconciliation.port;

/**
 * Skeleton seam for LeasePort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface LeasePort {
    java.util.Optional<com.example.assetupgrade.reconciliation.LeaseClaim> tryClaim(
            com.example.assetupgrade.common.TenantId tenantId, String key,
            java.time.Duration duration);
    void release(com.example.assetupgrade.reconciliation.LeaseClaim claim);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
