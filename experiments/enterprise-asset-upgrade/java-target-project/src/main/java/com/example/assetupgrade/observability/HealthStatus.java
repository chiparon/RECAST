package com.example.assetupgrade.observability;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable verdict reported by a {@link HealthCheck} or health aggregator.
 *
 * <p>The record components {@code marker} and {@code attributes} are the public shape,
 * translated from the Camel health {@code ContextHealthCheck} UP/DOWN result and its
 * detail map. The marker uses the conventional {@link #UP}/{@link #DOWN}/{@link #UNKNOWN}
 * vocabulary, compared case-insensitively, while attributes carry provider-neutral detail
 * such as the failing check identifier or reason.</p>
 */
public record HealthStatus(String marker, Map<String, String> attributes) {

    /** Conventional healthy marker. */
    public static final String UP = "UP";

    /** Conventional unhealthy marker. */
    public static final String DOWN = "DOWN";

    /** Marker used when a check could not produce a verdict. */
    public static final String UNKNOWN = "UNKNOWN";

    public HealthStatus {
        marker = normalizeMarker(marker);
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    private static String normalizeMarker(String raw) {
        if (raw == null) {
            return UNKNOWN;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? UNKNOWN : trimmed;
    }

    /** Creates a healthy status with no attributes. */
    public static HealthStatus up() {
        return new HealthStatus(UP, Map.of());
    }

    /** Creates a healthy status carrying the supplied attributes. */
    public static HealthStatus up(Map<String, String> attributes) {
        return new HealthStatus(UP, attributes);
    }

    /** Creates an unhealthy status with the supplied reason. */
    public static HealthStatus down(String reason) {
        Map<String, String> attributes = new LinkedHashMap<>();
        if (reason != null && !reason.isBlank()) {
            attributes.put("reason", reason);
        }
        return new HealthStatus(DOWN, attributes);
    }

    /** Creates a status with an explicit marker and attributes. */
    public static HealthStatus of(String marker, Map<String, String> attributes) {
        return new HealthStatus(marker, attributes);
    }

    /** @return {@code true} when this status is the conventional healthy marker. */
    public boolean isUp() {
        return UP.equalsIgnoreCase(marker);
    }

    /** @return {@code true} when this status is the conventional unhealthy marker. */
    public boolean isDown() {
        return DOWN.equalsIgnoreCase(marker);
    }

    /** @return {@code true} when this status is neither clearly up nor down. */
    public boolean isUnknown() {
        return !isUp() && !isDown();
    }

    /** Returns a new immutable status with the given attribute added or replaced. */
    public HealthStatus withAttribute(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new HealthStatus(marker, copy);
    }

    /** Ranks markers from best to worst so that aggregations can pick the worst verdict. */
    public int severity() {
        if (isUp()) {
            return 0;
        }
        if (isDown()) {
            return 2;
        }
        return 1;
    }

    /** @return {@code true} when this status is strictly worse than {@code other}. */
    public boolean isWorseThan(HealthStatus other) {
        return other != null && severity() > other.severity();
    }

    /** @return the worst of the two statuses, preferring {@code a} on ties. */
    public static HealthStatus worst(HealthStatus a, HealthStatus b) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        return b.isWorseThan(a) ? b : a;
    }

    /** @return the worst status of the collection, or {@link #down(String)} when empty. */
    public static HealthStatus worst(Collection<HealthStatus> statuses) {
        if (statuses == null || statuses.isEmpty()) {
            return new HealthStatus(DOWN, Map.of());
        }
        HealthStatus worst = null;
        for (HealthStatus status : statuses) {
            worst = worst(worst, status);
        }
        return worst;
    }
}
