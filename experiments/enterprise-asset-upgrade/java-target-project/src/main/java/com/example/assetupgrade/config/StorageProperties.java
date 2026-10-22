package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral object-storage settings.
 *
 * <p>Translated from the nopCommerce media/storage configuration into neutral endpoint,
 * bucket and size ceiling values. S3-style specifics stay inside the storage adapter that
 * {@code AdapterFactory} constructs.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record StorageProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "storage";

    /** Default storage endpoint. */
    public static final String DEFAULT_ENDPOINT = "http://localhost:9000";

    /** Default attachment bucket. */
    public static final String DEFAULT_BUCKET = "attachments";

    /** Default maximum stored object size: 64 MiB (mirrors the storage adapter default). */
    public static final long DEFAULT_MAX_OBJECT_BYTES = 64L * 1024L * 1024L;

    /** Key for the storage endpoint. */
    public static final String KEY_ENDPOINT = "endpoint";

    /** Key for the bucket name. */
    public static final String KEY_BUCKET = "bucket";

    /** Key for the maximum stored object size. */
    public static final String KEY_MAX_OBJECT_BYTES = "maxObjectBytes";

    public StorageProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static StorageProperties defaults() {
        return new StorageProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static StorageProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new StorageProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public StorageProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new StorageProperties(marker, copy);
    }

    /** @return the configured storage endpoint. */
    public String endpoint() {
        return getString(KEY_ENDPOINT, DEFAULT_ENDPOINT);
    }

    /** @return the configured bucket name. */
    public String bucket() {
        return getString(KEY_BUCKET, DEFAULT_BUCKET);
    }

    /** @return the configured maximum stored object size in bytes. */
    public long maxObjectBytes() {
        return getLong(KEY_MAX_OBJECT_BYTES, DEFAULT_MAX_OBJECT_BYTES);
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
