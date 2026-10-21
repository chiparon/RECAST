package com.example.assetupgrade.adapters;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.messaging.MessageEnvelope;
import com.example.assetupgrade.messaging.MessageHeaders;
import com.example.assetupgrade.messaging.MessageRetryPort;
import com.example.assetupgrade.retry.ExponentialRetryPolicy;
import com.example.assetupgrade.retry.RetryPolicy;
import com.example.assetupgrade.retry.RetryPolicyOptions;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * BullMQ-shaped retry adapter implementing {@link MessageRetryPort}.
 *
 * <p>Attempt numbers are 1-based and carried by the envelope headers; every backoff, retry and
 * dead-letter decision delegates to the injected {@link RetryPolicy} rather than being
 * re-implemented here. {@link #nextAttemptEnvelope(MessageEnvelope, Instant)} returns a fresh
 * envelope scoped to the same tenant with {@code attempt + 1} and the scheduled instant recorded
 * under {@link MessageRetryPort#NEXT_ATTEMPT_AT}, so a retry can never leak into another tenant.</p>
 *
 * <p>No external queue is on the classpath: {@link #schedule(MessageEnvelope)} enqueues into an
 * explicit in-process schedule so a delayed attempt is observable, but it is never reported as a
 * completed delivery.</p>
 */
public final class BullMqRetryAdapter implements MessageRetryPort {

    private static final RetryPolicyOptions DEFAULT_OPTIONS = new RetryPolicyOptions(
            3, Duration.ofSeconds(1), Duration.ofMinutes(1), 2.0d, false);

    private final RetryPolicy policy;
    private final TimeProvider clock;
    private final Map<String, List<MessageEnvelope>> scheduleByTenant = new ConcurrentHashMap<>();

    /** Creates an adapter with bounded exponential backoff (3 attempts) and the system clock. */
    public BullMqRetryAdapter() {
        this(new ExponentialRetryPolicy(DEFAULT_OPTIONS), TimeProvider.system());
    }

    /** Creates an adapter governed by {@code policy} using the system clock. */
    public BullMqRetryAdapter(RetryPolicy policy) {
        this(policy, TimeProvider.system());
    }

    /** Creates an adapter governed by {@code policy} using {@code clock}. */
    public BullMqRetryAdapter(RetryPolicy policy, TimeProvider clock) {
        this.policy = policy == null ? new ExponentialRetryPolicy(DEFAULT_OPTIONS) : policy;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** @return an adapter with the default bounded exponential backoff. */
    public static BullMqRetryAdapter local() {
        return new BullMqRetryAdapter();
    }

    /** @return the injected retry policy. */
    public RetryPolicy policy() {
        return policy;
    }

    /** @return {@code false}: no external BullMQ queue is configured. */
    public boolean isQueueConfigured() {
        return false;
    }

    /** @return {@code true} when the queue is reachable; always {@code false} without a broker. */
    public boolean probe() {
        return isQueueConfigured();
    }

    @Override
    public int attempt(MessageEnvelope envelope) {
        return Objects.requireNonNull(envelope, "envelope").headers().attempt();
    }

    @Override
    public boolean shouldRetry(MessageEnvelope envelope) {
        int attempt = attempt(envelope);
        return policy.canRetry(attempt) && !policy.shouldDeadLetter(attempt);
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

    /**
     * Enqueues {@code envelope} into the in-process schedule when a further attempt is allowed.
     *
     * @return the advanced envelope that was scheduled, or empty when the retry budget is exhausted
     */
    public Optional<MessageEnvelope> schedule(MessageEnvelope envelope) {
        Objects.requireNonNull(envelope, "envelope");
        if (!shouldRetry(envelope)) {
            return Optional.empty();
        }
        TenantId tenantId = envelope.tenantId();
        if (tenantId == null) {
            throw new ValidationException("envelope tenant is required to schedule a retry");
        }
        Instant scheduledAt = nextAttempt(envelope, clock.now());
        MessageEnvelope advanced = nextAttemptEnvelope(envelope, scheduledAt);
        scheduleByTenant.computeIfAbsent(tenantId.value(), key -> new ArrayList<>()).add(advanced);
        return Optional.of(advanced);
    }

    /** @return the retries scheduled for {@code tenantId}, in scheduling order. */
    public List<MessageEnvelope> scheduled(TenantId tenantId) {
        if (tenantId == null) {
            return List.of();
        }
        List<MessageEnvelope> scheduled = scheduleByTenant.get(tenantId.value());
        return scheduled == null ? List.of() : List.copyOf(scheduled);
    }

    /** @return the number of retries scheduled for {@code tenantId}. */
    public int scheduledCount(TenantId tenantId) {
        if (tenantId == null) {
            return 0;
        }
        List<MessageEnvelope> scheduled = scheduleByTenant.get(tenantId.value());
        return scheduled == null ? 0 : scheduled.size();
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof RetryRequest request) {
            MessageEnvelope envelope = request.envelope();
            if (!shouldRetry(envelope)) {
                return null;
            }
            Instant now = request.now() == null ? clock.now() : request.now();
            return nextAttemptEnvelope(envelope, nextAttempt(envelope, now));
        }
        if (input instanceof MessageEnvelope envelope) {
            return schedule(envelope).orElse(null);
        }
        throw new IllegalArgumentException("expected a MessageRetryPort.RetryRequest or MessageEnvelope");
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
