package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for OrderCommitPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OrderCommitPort {
    void commit(com.example.assetupgrade.order.OrderRequest order,
                com.example.assetupgrade.order.Reservation reservation);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
