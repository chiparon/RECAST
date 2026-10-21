package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for OrderEventPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OrderEventPort {
    void publish(com.example.assetupgrade.order.OrderResult result,
                 com.example.assetupgrade.common.CorrelationId correlationId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
