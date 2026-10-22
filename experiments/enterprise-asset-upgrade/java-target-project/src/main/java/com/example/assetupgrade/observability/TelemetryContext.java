package com.example.assetupgrade.observability;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable provider-neutral telemetry context carried alongside a business operation.
 *
 * <p>The record components {@code marker} and {@code attributes} are the public shape.
 * The marker classifies the context (for example the current processing stage) while the
 * attribute map retains correlation and tenant identity so that metrics, traces and
 * structured logs can be stitched together.</p>
 */
public record TelemetryContext(String marker, Map<String, String> attributes) {

    /** Marker used when no explicit classification is available. */
    public static final String DEFAULT_MARKER = "telemetry";

    public TelemetryContext {
        marker = marker == null || marker.isBlank() ? DEFAULT_MARKER : marker.trim();
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** Creates an empty context with the default marker. */
    public static TelemetryContext empty() {
        return new TelemetryContext(DEFAULT_MARKER, Map.of());
    }

    /** Creates a context with an explicit marker and attributes. */
    public static TelemetryContext of(String marker, Map<String, String> attributes) {
        return new TelemetryContext(marker, attributes);
    }

    /** Returns a new immutable context with the given attribute added or replaced. */
    public TelemetryContext withAttribute(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new TelemetryContext(marker, copy);
    }
}
