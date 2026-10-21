package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral deployment environment settings.
 *
 * <p>Translated from the nopCommerce {@code CommonConfig} environment toggles
 * ({@code DisplayFullErrorStack} and friends) into an explicit, defaulted record. The
 * stub class of the skeleton has been converted into a record so that every configuration
 * section shares the same {@code marker}/{@code attributes} shape.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record EnvironmentProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "environment";

    /** Default environment name. */
    public static final String DEFAULT_NAME = "prod";

    /** Key for the environment name. */
    public static final String KEY_NAME = "name";

    /** Key for whether full error stacks are exposed. */
    public static final String KEY_DISPLAY_FULL_ERROR_STACK = "displayFullErrorStack";

    public EnvironmentProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static EnvironmentProperties defaults() {
        return new EnvironmentProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static EnvironmentProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new EnvironmentProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public EnvironmentProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new EnvironmentProperties(marker, copy);
    }

    /** @return the configured environment name. */
    public String name() {
        return getString(KEY_NAME, DEFAULT_NAME);
    }

    /** @return whether full error stacks may be shown. */
    public boolean displayFullErrorStack() {
        return getBoolean(KEY_DISPLAY_FULL_ERROR_STACK, false);
    }

    /** @return {@code true} when the configured environment is production. */
    public boolean isProduction() {
        return "prod".equalsIgnoreCase(name()) || "production".equalsIgnoreCase(name());
    }

    /** @return {@code true} when the configured environment is development. */
    public boolean isDevelopment() {
        return "dev".equalsIgnoreCase(name()) || "development".equalsIgnoreCase(name());
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
