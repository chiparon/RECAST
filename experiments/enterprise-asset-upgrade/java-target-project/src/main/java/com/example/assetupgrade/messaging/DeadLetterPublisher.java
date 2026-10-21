package com.example.assetupgrade.messaging;

/**
 * Tenant-scoped dead-letter seam for exhausted {@link MessageEnvelope messages}.
 *
 * <p>A dead letter is emitted exactly once per exhausted envelope and retains the original tenant,
 * correlation and message identity together with the reason and attempt count. Concrete queue
 * providers stay behind the port.</p>
 */
public interface DeadLetterPublisher {

    /** Publishes {@code envelope} as a dead letter with {@code reason} after {@code attempts} attempts. */
    void publish(MessageEnvelope envelope, String reason, int attempts);

    /** Compatibility seam for early implementations; the typed contract is {@link #publish(MessageEnvelope, String, int)}. */
    default Object execute(Object input) {
        if (input instanceof DeadLetterRequest request) {
            publish(request.envelope(), request.reason(), request.attempts());
            return request.envelope();
        }
        if (input instanceof MessageEnvelope envelope) {
            publish(envelope, "dead-letter", envelope.headers().attempt());
            return envelope;
        }
        throw new IllegalArgumentException("expected a DeadLetterPublisher.DeadLetterRequest or MessageEnvelope");
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param envelope the exhausted envelope
     * @param reason   the dead-letter reason
     * @param attempts the number of attempts made
     */
    record DeadLetterRequest(MessageEnvelope envelope, String reason, int attempts) {}
}
