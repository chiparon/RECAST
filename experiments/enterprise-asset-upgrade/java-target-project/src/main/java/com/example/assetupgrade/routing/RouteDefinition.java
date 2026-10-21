package com.example.assetupgrade.routing;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable, vendor-neutral route declaration.
 *
 * <p>The {@code marker} is the route key; the attributes describe the target, protocol, tenant and
 * transform settings. Attributes are defensively copied and exposed as an unmodifiable map.</p>
 *
 * @param marker     the route key, never {@code null}
 * @param attributes the route settings, never {@code null}
 */
public record RouteDefinition(String marker, Map<String, String> attributes) {

    /** Attribute name holding the endpoint target. */
    public static final String TARGET = "target";

    /** Attribute name holding the transport protocol. */
    public static final String PROTOCOL = "protocol";

    /** Attribute name holding the owning tenant. */
    public static final String TENANT = "tenant";

    public RouteDefinition {
        marker = Objects.requireNonNull(marker, "marker");
        attributes = MessageRequest.immutableCopy(attributes);
    }

    /** @return the route key for this definition. */
    public String routeKey() {
        return marker;
    }

    /** @return the declared endpoint target, or {@code null} when absent. */
    public String target() {
        return attribute(TARGET);
    }

    /** @return the declared transport protocol, or {@code null} when absent. */
    public String protocol() {
        return attribute(PROTOCOL);
    }

    /** @return the declared owning tenant, or {@code null} when absent. */
    public String tenant() {
        return attribute(TENANT);
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
    public RouteDefinition withAttribute(String name, String value) {
        Objects.requireNonNull(name, "name");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        if (value == null) {
            copy.remove(name);
        } else {
            copy.put(name, value);
        }
        return new RouteDefinition(marker, copy);
    }
}
