package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for PaymentPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface PaymentPort {
    void authorize(com.example.assetupgrade.order.OrderRequest order, long totalMinor);
    void reverse(com.example.assetupgrade.order.OrderRequest order);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
