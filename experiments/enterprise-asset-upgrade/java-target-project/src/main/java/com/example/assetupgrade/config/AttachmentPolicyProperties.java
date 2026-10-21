package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral attachment-intake policy settings.
 *
 * <p>Translated from the nopCommerce grouped settings section returned by
 * {@code IConfig}/{@code AppSettings.Get}. The record keeps the established skeleton shape
 * ({@code marker}, {@code attributes}) while exposing explicit public defaults and
 * convenience accessors so callers never need to know the raw key names. No provider or IO
 * type appears here: adapter construction reads these values through {@code AdapterFactory}.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record AttachmentPolicyProperties(String marker, Map<String, String> attributes) {

    /** Section marker, mirroring the nopCommerce {@code IConfig.Name}. */
    public static final String MARKER = "attachment";

    /** Maximum accepted attachment size in bytes: 25 MiB. */
    public static final long DEFAULT_MAX_BYTES = 25L * 1024L * 1024L;

    /** Key for the maximum accepted attachment size. */
    public static final String KEY_MAX_BYTES = "maxBytes";

    /** Key for the comma-separated allow-list of media types. */
    public static final String KEY_ALLOWED_MIME_TYPES = "allowedMimeTypes";

    /** Key for whether a matching content signature is required. */
    public static final String KEY_REQUIRE_SIGNATURE = "requireSignature";

    /** Key for the quarantine storage bucket. */
    public static final String KEY_QUARANTINE_BUCKET = "quarantineBucket";

    /** Default allow-list of media types accepted by the intake boundary. */
    public static final List<String> DEFAULT_ALLOWED_MIME_TYPES = List.of(
            "image/png", "image/jpeg", "image/gif", "application/pdf", "text/plain");

    /** Default quarantine bucket name. */
    public static final String DEFAULT_QUARANTINE_BUCKET = "quarantine";

    public AttachmentPolicyProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static AttachmentPolicyProperties defaults() {
        return new AttachmentPolicyProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static AttachmentPolicyProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new AttachmentPolicyProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public AttachmentPolicyProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new AttachmentPolicyProperties(marker, copy);
    }

    /** @return the configured maximum accepted size in bytes. */
    public long maxBytes() {
        return getLong(KEY_MAX_BYTES, DEFAULT_MAX_BYTES);
    }

    /** @return the configured media-type allow-list. */
    public List<String> allowedMimeTypes() {
        String raw = attributes.get(KEY_ALLOWED_MIME_TYPES);
        if (raw == null || raw.isBlank()) {
            return DEFAULT_ALLOWED_MIME_TYPES;
        }
        return java.util.Arrays.stream(raw.split(","))
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .toList();
    }

    /** @return whether a matching content signature is required. */
    public boolean requireSignature() {
        return getBoolean(KEY_REQUIRE_SIGNATURE, true);
    }

    /** @return the quarantine bucket name. */
    public String quarantineBucket() {
        return getString(KEY_QUARANTINE_BUCKET, DEFAULT_QUARANTINE_BUCKET);
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
