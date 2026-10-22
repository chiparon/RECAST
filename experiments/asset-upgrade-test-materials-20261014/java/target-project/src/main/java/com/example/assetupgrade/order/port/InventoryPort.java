package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for InventoryPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface InventoryPort {
    com.example.assetupgrade.order.Reservation reserve(com.example.assetupgrade.order.OrderRequest order);
    void release(com.example.assetupgrade.common.TenantId tenantId, String reservationId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
