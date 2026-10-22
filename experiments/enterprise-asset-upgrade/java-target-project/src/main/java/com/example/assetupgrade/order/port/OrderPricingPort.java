package com.example.assetupgrade.order.port;

import com.example.assetupgrade.order.OrderRequest;

/**
 * Pricing boundary that resolves the total for an order.
 *
 * <p>{@link #totalMinor(OrderRequest)} returns the order total in minor currency units. The
 * application layer falls back to summing the line prices when no pricing provider is configured.
 * No provider type appears here.</p>
 */
public interface OrderPricingPort {

    /** @return the total for {@code order} in minor currency units. */
    long totalMinor(OrderRequest order);

    /** Compatibility seam; the typed method defines the contract. */
    default Object execute(Object input) {
        if (input instanceof OrderRequest order) {
            return totalMinor(order);
        }
        throw new IllegalArgumentException("Expected an OrderRequest");
    }
}
