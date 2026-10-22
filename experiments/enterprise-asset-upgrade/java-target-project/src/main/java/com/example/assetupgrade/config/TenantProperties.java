package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral tenant-scoping settings.
 *
 * <p>Translated from the nopCommerce multi-store/tenant settings marker into an explicit
 * default tenant and isolation flag. Tenant isolation is preserved by every port in the
 * module; this record only carries the configuration.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record TenantProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "tenant";

    /** Default tenant used when a command does not resolve one. */
    public static final String DEFAULT_DEFAULT_TENANT = "default";

    /** Key for the default tenant. */
    public static final String KEY_DEFAULT_TENANT = "defaultTenant";

    /** Key for whether tenant isolation is enforced. */
    public static final String KEY_ENFORCE_ISOLATION = "enforceIsolation";

    public TenantProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static TenantProperties defaults() {
        return new TenantProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static TenantProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new TenantProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public TenantProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new TenantProperties(marker, copy);
    }

    /** @return the configured default tenant. */
    public String defaultTenant() {
        return getString(KEY_DEFAULT_TENANT, DEFAULT_DEFAULT_TENANT);
    }

    /** @return the default tenant as a {@link com.example.assetupgrade.common.TenantId}. */
    public com.example.assetupgrade.common.TenantId defaultTenantId() {
        return com.example.assetupgrade.common.TenantId.of(defaultTenant());
    }

    /** @return whether tenant isolation is enforced; enforced by default. */
    public boolean enforceIsolation() {
        return getBoolean(KEY_ENFORCE_ISOLATION, true);
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
