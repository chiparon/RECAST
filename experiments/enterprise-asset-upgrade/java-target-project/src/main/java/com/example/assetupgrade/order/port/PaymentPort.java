package com.example.assetupgrade.order.port;

import com.example.assetupgrade.order.OrderRequest;

/**
 * Payment authorization boundary for orders.
 *
 * <p>{@link #authorize(OrderRequest, long)} authorizes the priced total and
 * {@link #reverse(OrderRequest)} compensates an authorization when a commit or audit step fails.
 * {@code reverse} must be idempotent. No provider type appears here.</p>
 */
public interface PaymentPort {

    /** Authorizes {@code totalMinor} for {@code order}. */
    void authorize(OrderRequest order, long totalMinor);

    /** Compensates a previously authorized payment for {@code order}. */
    void reverse(OrderRequest order);

    /** Compatibility seam; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof AuthorizeRequest request) {
            authorize(request.order(), request.totalMinor());
            return null;
        }
        if (input instanceof ReverseRequest request) {
            reverse(request.order());
            return null;
        }
        throw new IllegalArgumentException("Expected an AuthorizeRequest or ReverseRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record AuthorizeRequest(OrderRequest order, long totalMinor) {
    }

    /** Request holder accepted by the compatibility seam. */
    record ReverseRequest(OrderRequest order) {
    }
}
