package com.example.assetupgrade.routing;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable, vendor-neutral message to be routed.
 *
 * <p>The {@code marker} is the route key used for matching; {@code attributes} carry the payload
 * metadata exchanged with a {@link RouteDefinition}. Attributes are defensively copied and exposed
 * as an unmodifiable map.</p>
 *
 * @param marker     the route key, never {@code null}
 * @param attributes the request metadata, never {@code null}
 */
public record MessageRequest(String marker, Map<String, String> attributes) {

    public MessageRequest {
        marker = Objects.requireNonNull(marker, "marker");
        attributes = immutableCopy(attributes);
    }

    static Map<String, String> immutableCopy(Map<String, String> source) {
        if (source == null || source.isEmpty()) {
            return Map.of();
        }
        Map<String, String> copy = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                copy.put(entry.getKey(), entry.getValue());
            }
        }
        return Collections.unmodifiableMap(copy);
    }

    /** @return the route key for this request. */
    public String routeKey() {
        return marker;
    }

    /** @return the value of {@code name}, or {@code null} when absent. */
    public String attribute(String name) {
        return name == null ? null : attributes.get(name);
    }

    /** @return {@code true} when {@code name} is present. */
    public boolean hasAttribute(String name) {
        return name != null && attributes.containsKey(name);
    }

    /** @return a copy with {@code name} set to {@code value}, or removed when {@code value} is null. */
    public MessageRequest withAttribute(String name, String value) {
        Objects.requireNonNull(name, "name");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        if (value == null) {
            copy.remove(name);
        } else {
            copy.put(name, value);
        }
        return new MessageRequest(marker, copy);
    }

    /** @return a copy with every overlay entry applied over this request's attributes. */
    public MessageRequest withAttributes(Map<String, String> overlay) {
        return new MessageRequest(marker, RouteTransform.mergeAttributes(attributes, overlay));
    }
}
