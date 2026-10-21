package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for OrderRepository.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OrderRepository {
    java.util.Optional<com.example.assetupgrade.order.OrderSnapshot> find(
            com.example.assetupgrade.common.TenantId tenantId, String orderId);
    void save(com.example.assetupgrade.order.OrderSnapshot snapshot);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
