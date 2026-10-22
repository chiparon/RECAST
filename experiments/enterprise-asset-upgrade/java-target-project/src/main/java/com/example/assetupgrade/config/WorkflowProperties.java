package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral workflow delivery settings.
 *
 * <p>Translated from the nopCommerce {@code IConfig} section contract into the approved
 * delivery state, the configured dispatch route and a bounded attempt budget. Camel,
 * Flowable or any other engine choice is only a neutral {@link #engine()} value used by
 * {@code AdapterFactory}; no provider type appears here.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record WorkflowProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "workflow";

    /** The only state from which delivery is allowed. */
    public static final String DEFAULT_APPROVED_STATE = "APPROVED";

    /** Default dispatch route key. */
    public static final String DEFAULT_DISPATCH_ROUTE = "workflow.dispatch";

    /** Default delivery attempt budget. */
    public static final int DEFAULT_MAX_ATTEMPTS = 5;

    /** Default workflow engine selection. */
    public static final String DEFAULT_ENGINE = "camel";

    /** Key for the approved delivery state. */
    public static final String KEY_APPROVED_STATE = "approvedState";

    /** Key for the dispatch route key. */
    public static final String KEY_DISPATCH_ROUTE = "dispatchRoute";

    /** Key for the delivery attempt budget. */
    public static final String KEY_MAX_ATTEMPTS = "maxAttempts";

    /** Key for the workflow engine selection. */
    public static final String KEY_ENGINE = "engine";

    public WorkflowProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static WorkflowProperties defaults() {
        return new WorkflowProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static WorkflowProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new WorkflowProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public WorkflowProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new WorkflowProperties(marker, copy);
    }

    /** @return the state an event must be in before dispatch. */
    public String approvedState() {
        return getString(KEY_APPROVED_STATE, DEFAULT_APPROVED_STATE);
    }

    /** @return the configured dispatch route key. */
    public String dispatchRoute() {
        return getString(KEY_DISPATCH_ROUTE, DEFAULT_DISPATCH_ROUTE);
    }

    /** @return the delivery attempt budget. */
    public int maxAttempts() {
        return getInt(KEY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
    }

    /** @return the workflow engine selection. */
    public String engine() {
        return getString(KEY_ENGINE, DEFAULT_ENGINE);
    }

    /** @return {@code true} when the Flowable engine was selected. */
    public boolean useFlowable() {
        return "flowable".equalsIgnoreCase(engine());
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
