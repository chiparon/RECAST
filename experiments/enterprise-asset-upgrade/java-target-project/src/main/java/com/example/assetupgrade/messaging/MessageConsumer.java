package com.example.assetupgrade.messaging;

import java.util.function.Consumer;

/**
 * Subscribe seam for tenant-aware {@link MessageEnvelope envelopes}.
 *
 * <p>An envelope delivered to {@code handler} retains its tenant and correlation identity
 * unchanged. Provider-specific subscription mechanics live behind the port.</p>
 */
public interface MessageConsumer {

    /** Subscribes {@code handler} to every envelope published on {@code topic}. */
    void subscribe(String topic, Consumer<MessageEnvelope> handler);

    /** Compatibility seam for early implementations; the typed contract is {@link #subscribe(String, Consumer)}. */
    default Object execute(Object input) {
        if (input instanceof SubscribeRequest request) {
            subscribe(request.topic(), request.handler());
            return null;
        }
        throw new IllegalArgumentException("expected a MessageConsumer.SubscribeRequest");
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param topic   the subscribed topic
     * @param handler the delivery handler
     */
    record SubscribeRequest(String topic, Consumer<MessageEnvelope> handler) {}
}
