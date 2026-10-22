package com.example.assetupgrade.messaging;

import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.retry.RetryPolicy;

import java.time.Instant;
import java.util.Objects;

/**
 * Tenant-scoped retry contract for {@link MessageEnvelope messages}.
 *
 * <p>Attempt numbers are 1-based and carried by {@link MessageHeaders#attempt()}. The port delegates
 * every attempt, next-attempt and dead-letter decision to a {@link RetryPolicy} rather than
 * re-implementing backoff, and it never mutates another tenant's record: {@link #nextAttemptEnvelope}
 * returns a fresh envelope scoped to the same tenant. Concrete timer/queue providers (for example a
 * BullMQ or Quartz adapter) stay behind the port.</p>
 */
public interface MessageRetryPort {

    /** Attribute recording the scheduled instant of the next attempt. */
    String NEXT_ATTEMPT_AT = "nextAttemptAt";

    /** @return the 1-based attempt already made for {@code envelope}. */
    int attempt(MessageEnvelope envelope);

    /** @return {@code true} when {@code envelope} may be attempted again. */
    boolean shouldRetry(MessageEnvelope envelope);

    /** @return the instant at which the next attempt for {@code envelope} should run, after {@code now}. */
    Instant nextAttempt(MessageEnvelope envelope, Instant now);

    /**
     * @return a copy of {@code envelope} advanced to the next 1-based attempt with
     *         {@code nextAttemptAt} recorded in its headers
     */
    MessageEnvelope nextAttemptEnvelope(MessageEnvelope envelope, Instant nextAttemptAt);

    /** @return the scheduling instant recorded on {@code envelope}, or {@code null} when unset. */
    default Instant scheduledAt(MessageEnvelope envelope) {
        if (envelope == null) {
            return null;
        }
        String recorded = envelope.headers().attribute(NEXT_ATTEMPT_AT);
        return recorded == null || recorded.isBlank() ? null : Instant.parse(recorded);
    }

    /** Compatibility seam for early implementations; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof RetryRequest request) {
            MessageEnvelope envelope = request.envelope();
            if (!shouldRetry(envelope)) {
                return null;
            }
            Instant now = request.now() == null ? Instant.now() : request.now();
            return nextAttemptEnvelope(envelope, nextAttempt(envelope, now));
        }
        if (input instanceof MessageEnvelope envelope) {
            return shouldRetry(envelope);
        }
        throw new IllegalArgumentException("expected a MessageRetryPort.RetryRequest or MessageEnvelope");
    }

    /** @return a retry port governed by {@code policy} using the system clock. */
    static MessageRetryPort over(RetryPolicy policy) {
        return new DefaultMessageRetryPort(policy, TimeProvider.system());
    }

    /** @return a retry port governed by {@code policy} using {@code clock}. */
    static MessageRetryPort over(RetryPolicy policy, TimeProvider clock) {
        return new DefaultMessageRetryPort(policy, clock);
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param envelope the envelope to schedule
     * @param now      the reference instant, or {@code null} for the current time
     */
    record RetryRequest(MessageEnvelope envelope, Instant now) {}

    /** Policy-backed retry port applying 1-based attempt semantics from the envelope headers. */
    final class DefaultMessageRetryPort implements MessageRetryPort {

        private final RetryPolicy policy;
        private final TimeProvider clock;

        public DefaultMessageRetryPort(RetryPolicy policy, TimeProvider clock) {
            this.policy = Objects.requireNonNull(policy, "policy");
            this.clock = Objects.requireNonNull(clock, "clock");
        }

        @Override
        public int attempt(MessageEnvelope envelope) {
            return Objects.requireNonNull(envelope, "envelope").headers().attempt();
        }

        @Override
        public boolean shouldRetry(MessageEnvelope envelope) {
            return policy.canRetry(attempt(envelope));
        }

        @Override
        public Instant nextAttempt(MessageEnvelope envelope, Instant now) {
            Instant reference = now == null ? clock.now() : now;
            return policy.nextAttempt(reference, attempt(envelope));
        }

        @Override
        public MessageEnvelope nextAttemptEnvelope(MessageEnvelope envelope, Instant nextAttemptAt) {
            Objects.requireNonNull(envelope, "envelope");
            Objects.requireNonNull(nextAttemptAt, "nextAttemptAt");
            MessageHeaders advanced = envelope.headers()
                    .withAttempt(envelope.headers().attempt() + 1)
                    .withAttribute(NEXT_ATTEMPT_AT, nextAttemptAt.toString());
            return envelope.withHeaders(advanced);
        }
    }
}
