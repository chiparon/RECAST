package com.example.assetupgrade.reconciliation.port;

/**
 * Skeleton seam for ReconciliationLockPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ReconciliationLockPort {
    java.util.concurrent.locks.Lock lock(com.example.assetupgrade.common.TenantId tenantId,
                                         String jobName);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
