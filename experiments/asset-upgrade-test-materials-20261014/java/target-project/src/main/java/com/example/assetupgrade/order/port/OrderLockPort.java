package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for OrderLockPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OrderLockPort {
    java.util.concurrent.locks.Lock lock(com.example.assetupgrade.common.TenantId tenantId,
                                         String orderId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
