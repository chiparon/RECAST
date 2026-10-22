package com.example.assetupgrade.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Typed, provider-neutral messaging settings.
 *
 * <p>Translated from the nopCommerce distributed-cache transport section into neutral topic
 * and broker coordinates. The Kafka/BullMQ specifics stay in the messaging adapters created
 * by {@code AdapterFactory}.</p>
 *
 * @param marker     the settings section marker; must be {@value #MARKER}
 * @param attributes the raw, immutable key/value settings for this section
 */
public record MessagingProperties(String marker, Map<String, String> attributes) {

    /** Section marker. */
    public static final String MARKER = "messaging";

    /** Default broker bootstrap servers. */
    public static final String DEFAULT_BOOTSTRAP_SERVERS = "localhost:9092";

    /** Default workflow event topic. */
    public static final String DEFAULT_WORKFLOW_TOPIC = "workflow.events";

    /** Default dead-letter topic. */
    public static final String DEFAULT_DEAD_LETTER_TOPIC = "workflow.dlq";

    /** Key for the broker bootstrap servers. */
    public static final String KEY_BOOTSTRAP_SERVERS = "bootstrapServers";

    /** Key for the workflow event topic. */
    public static final String KEY_WORKFLOW_TOPIC = "workflowTopic";

    /** Key for the dead-letter topic. */
    public static final String KEY_DEAD_LETTER_TOPIC = "deadLetterTopic";

    /** Key for whether messaging is enabled. */
    public static final String KEY_ENABLED = "enabled";

    public MessagingProperties {
        marker = requireIdentifier(marker, "marker");
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the settings with every declared default and no overrides. */
    public static MessagingProperties defaults() {
        return new MessagingProperties(MARKER, Map.of());
    }

    /** Creates a section instance, rejecting a blank or unknown marker. */
    public static MessagingProperties of(String marker, Map<String, String> attributes) {
        requireKnownMarker(marker, MARKER);
        return new MessagingProperties(marker, attributes);
    }

    /** @return a copy with {@code key} set to {@code value}. */
    public MessagingProperties with(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new MessagingProperties(marker, copy);
    }

    /** @return the configured broker bootstrap servers. */
    public String bootstrapServers() {
        return getString(KEY_BOOTSTRAP_SERVERS, DEFAULT_BOOTSTRAP_SERVERS);
    }

    /** @return the configured workflow event topic. */
    public String workflowTopic() {
        return getString(KEY_WORKFLOW_TOPIC, DEFAULT_WORKFLOW_TOPIC);
    }

    /** @return the configured dead-letter topic. */
    public String deadLetterTopic() {
        return getString(KEY_DEAD_LETTER_TOPIC, DEFAULT_DEAD_LETTER_TOPIC);
    }

    /** @return whether messaging is enabled; enabled by default. */
    public boolean enabled() {
        return getBoolean(KEY_ENABLED, true);
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
