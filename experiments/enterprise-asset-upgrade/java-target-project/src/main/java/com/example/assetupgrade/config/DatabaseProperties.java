package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral relational database settings.
 *
 * <p>Translated from the nopCommerce data configuration section with explicitly declared
 * public defaults. Only neutral values live here; the concrete JDBC/DataSource wiring is
 * created by {@code AdapterFactory}.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record DatabaseProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "database";

    /** Default JDBC URL of the local PostgreSQL instance. */
    public static final String DEFAULT_JDBC_URL = "jdbc:postgresql://localhost:5432/assetupgrade";

    /** Default connection-pool size. */
    public static final int DEFAULT_POOL_SIZE = 10;

    /** Default connection timeout in seconds. */
    public static final int DEFAULT_CONNECTION_TIMEOUT_SECONDS = 30;

    /** Key for the JDBC URL. */
    public static final String KEY_JDBC_URL = "jdbcUrl";

    /** Key for the connection-pool size. */
    public static final String KEY_POOL_SIZE = "poolSize";

    /** Key for the connection timeout in seconds. */
    public static final String KEY_CONNECTION_TIMEOUT_SECONDS = "connectionTimeoutSeconds";

    public DatabaseProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static DatabaseProperties defaults() {
        return new DatabaseProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static DatabaseProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new DatabaseProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public DatabaseProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new DatabaseProperties(marker, copy);
    }

    /** @return the configured JDBC URL. */
    public String jdbcUrl() {
        return getString(KEY_JDBC_URL, DEFAULT_JDBC_URL);
    }

    /** @return the configured connection-pool size. */
    public int poolSize() {
        return getInt(KEY_POOL_SIZE, DEFAULT_POOL_SIZE);
    }

    /** @return the configured connection timeout in seconds. */
    public int connectionTimeoutSeconds() {
        return getInt(KEY_CONNECTION_TIMEOUT_SECONDS, DEFAULT_CONNECTION_TIMEOUT_SECONDS);
    }

    /** @return the configured connection timeout as a {@link Duration}. */
    public Duration connectionTimeout() {
        return Duration.ofSeconds(connectionTimeoutSeconds());
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
