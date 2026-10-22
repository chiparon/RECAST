package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral scheduler settings for the reconciliation job.
 *
 * <p>Translated from the nopCommerce schedule-task configuration into an interval/lease
 * pair. Quartz (or any other trigger) is created by {@code AdapterFactory} from these
 * values.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record SchedulerProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "scheduler";

    /** Whether the scheduler is enabled by default. */
    public static final boolean DEFAULT_ENABLED = true;

    /** Default scheduling interval in seconds. */
    public static final int DEFAULT_INTERVAL_SECONDS = 300;

    /** Default lease time-to-live in seconds. */
    public static final int DEFAULT_LEASE_TTL_SECONDS = 120;

    /** Key for whether the scheduler is enabled. */
    public static final String KEY_ENABLED = "enabled";

    /** Key for the scheduling interval in seconds. */
    public static final String KEY_INTERVAL_SECONDS = "intervalSeconds";

    /** Key for the lease time-to-live in seconds. */
    public static final String KEY_LEASE_TTL_SECONDS = "leaseTtlSeconds";

    public SchedulerProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static SchedulerProperties defaults() {
        return new SchedulerProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static SchedulerProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new SchedulerProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public SchedulerProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new SchedulerProperties(marker, copy);
    }

    /** @return whether the scheduler is enabled. */
    public boolean enabled() {
        return getBoolean(KEY_ENABLED, DEFAULT_ENABLED);
    }

    /** @return the scheduling interval in seconds. */
    public int intervalSeconds() {
        return getInt(KEY_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS);
    }

    /** @return the lease time-to-live in seconds. */
    public int leaseTtlSeconds() {
        return getInt(KEY_LEASE_TTL_SECONDS, DEFAULT_LEASE_TTL_SECONDS);
    }

    /** @return the scheduling interval as a {@link Duration}. */
    public Duration interval() {
        return Duration.ofSeconds(intervalSeconds());
    }

    /** @return the lease time-to-live as a {@link Duration}. */
    public Duration leaseTtl() {
        return Duration.ofSeconds(leaseTtlSeconds());
    }

    /** @return the raw string value for {@code key}, or {@code defaultValue} when absent. */
    public String getString(String key, String defaultValue) {
        String raw = attributes.get(key);
        return raw == null ? defaultValue : raw;
    }

    /** @return the parsed long for {@code key}, or {@code defaultValue} when absent or invalid. */
    public long getLong(String key, long defaultValue) {
        String raw = attributes.get(key);
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException ex) {
            return defaultValue;
        }
    }

    /** @return the parsed int for {@code key}, or {@code defaultValue} when absent or invalid. */
    public int getInt(String key, int defaultValue) {
        long value = getLong(key, defaultValue);
        return value > Integer.MAX_VALUE ? defaultValue : (int) value;
    }

    /** @return the parsed double for {@code key}, or {@code defaultValue} when absent or invalid. */
    public double getDouble(String key, double defaultValue) {
        String raw = attributes.get(key);
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        try {
            return Double.parseDouble(raw.trim());
        } catch (NumberFormatException ex) {
            return defaultValue;
        }
    }

    /** @return the parsed boolean for {@code key}, or {@code defaultValue} when absent or invalid. */
    public boolean getBoolean(String key, boolean defaultValue) {
        String raw = attributes.get(key);
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        String value = raw.trim();
        if (value.equalsIgnoreCase("true") || value.equals("1") || value.equalsIgnoreCase("yes")) {
            return true;
        }
        if (value.equalsIgnoreCase("false") || value.equals("0") || value.equalsIgnoreCase("no")) {
            return false;
        }
        return defaultValue;
    }

    /** @return the parsed duration for {@code key}, or {@code defaultValue} when absent or invalid. */
    public Duration getDuration(String key, Duration defaultValue) {
        String raw = attributes.get(key);
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        String value = raw.trim();
        try {
            if (value.startsWith("P") || value.startsWith("-P")) {
                return Duration.parse(value);
            }
            return Duration.ofMillis(Long.parseLong(value));
        } catch (RuntimeException ex) {
            return defaultValue;
        }
    }

    static String requireIdentifier(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value.trim();
    }

    static void requireKnownMarker(String marker, String expected) {
        if (marker == null || marker.isBlank()) {
            throw new IllegalArgumentException("marker must not be blank");
        }
        if (!expected.equals(marker.trim())) {
            throw new IllegalArgumentException("unknown marker '" + marker + "', expected '" + expected + "'");
        }
    }
}
