package com.example.assetupgrade.order.port;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.order.OrderResult;

/**
 * Tenant-scoped publication boundary for order lifecycle events.
 *
 * <p>{@link #publish(OrderResult, CorrelationId)} emits the outcome of an order submission,
 * preserving the correlation identity so the event can be joined back to its audit evidence.
 * No provider type appears here.</p>
 */
public interface OrderEventPort {

    /** Publishes {@code result} carrying {@code correlationId}. */
    void publish(OrderResult result, CorrelationId correlationId);

    /** Compatibility seam; the typed method defines the contract. */
    default Object execute(Object input) {
        if (input instanceof PublishRequest request) {
            publish(request.result(), request.correlationId());
            return null;
        }
        throw new IllegalArgumentException("Expected a PublishRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record PublishRequest(OrderResult result, CorrelationId correlationId) {
    }
}
