package com.example.assetupgrade.adapters;

import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.HealthStatus;

import java.util.Map;
import java.util.Objects;
import java.util.function.BooleanSupplier;

/**
 * Health probe for the messaging/queue boundary.
 *
 * <p>Reports {@link HealthStatus#up()} only when the queue provider is actually reachable. An
 * unconfigured queue, a disconnected Kafka publisher or the local BullMQ retry fallback all yield
 * {@link HealthStatus#down(String)} with a reason, and {@link #status()} never throws.</p>
 */
public final class QueueHealthCheck implements HealthCheck {

    private final BooleanSupplier availability;
    private final String provider;
    private final String description;

    /** Creates a probe with no queue; it reports down. */
    public QueueHealthCheck() {
        this(() -> false, "kafka", "queue is not configured");
    }

    /** Creates a probe backed by {@code availability}. */
    public QueueHealthCheck(BooleanSupplier availability) {
        this(availability, "kafka", "queue is not reachable");
    }

    /** Creates a probe over a Kafka publisher. */
    public QueueHealthCheck(KafkaMessagePublisher publisher) {
        this(publisher == null ? () -> false : publisher::probe, "kafka",
                publisher == null ? "kafka broker is not configured" : "kafka broker is not connected");
    }

    /** Creates a probe over a BullMQ retry adapter. */
    public QueueHealthCheck(BullMqRetryAdapter retryAdapter) {
        this(retryAdapter == null ? () -> false : retryAdapter::probe, "bullmq",
                "bullmq queue is not configured");
    }

    private QueueHealthCheck(BooleanSupplier availability, String provider, String description) {
        this.availability = availability == null ? () -> false : availability;
        this.provider = provider;
        this.description = description;
    }

    @Override
    public String id() {
        return "queue";
    }

    @Override
    public Map<String, String> metadata() {
        return Map.of("component", "queue", "provider", provider);
    }

    @Override
    public HealthStatus status() {
        try {
            if (availability.getAsBoolean()) {
                return HealthStatus.up(Map.of("provider", provider));
            }
            return HealthStatus.down(Objects.requireNonNullElse(description, "queue is not reachable"));
        } catch (RuntimeException failure) {
            return HealthStatus.down("queue probe failed: " + failure.getMessage());
        }
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
