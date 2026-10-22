package com.example.assetupgrade.messaging;

/**
 * Publish seam for tenant-aware {@link MessageEnvelope envelopes}.
 *
 * <p>A transport failure must surface as
 * {@link com.example.assetupgrade.error.RetryableTransportException} so callers can apply the retry
 * policy; an envelope is never silently dropped. Concrete queue providers (for example a Kafka or
 * BullMQ adapter) implement this port and must keep their vendor types out of the port.</p>
 */
public interface MessagePublisher {

    /** Publishes {@code envelope} to its resolved topic. */
    void publish(MessageEnvelope envelope);

    /** Compatibility seam for early implementations; the typed contract is {@link #publish(MessageEnvelope)}. */
    default Object execute(Object input) {
        if (input instanceof MessageEnvelope envelope) {
            publish(envelope);
            return envelope;
        }
        throw new IllegalArgumentException("expected a MessageEnvelope but got "
                + (input == null ? "null" : input.getClass().getName()));
    }
}
