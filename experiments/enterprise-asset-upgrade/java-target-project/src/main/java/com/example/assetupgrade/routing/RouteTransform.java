package com.example.assetupgrade.routing;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Stateless request transformation. Route-declared attributes are merged over the request attributes
 * to produce the transformed, immutable {@link MessageRequest}. No provider type is referenced.
 */
public final class RouteTransform {

    private RouteTransform() {
    }

    /**
     * Applies {@code route}'s declared transform attributes over {@code request}.
     *
     * @return a new request carrying the merged attributes under the original route key
     */
    public static MessageRequest apply(RouteDefinition route, MessageRequest request) {
        Objects.requireNonNull(route, "route");
        Objects.requireNonNull(request, "request");
        Map<String, String> merged = mergeAttributes(request.attributes(), route.attributes());
        return new MessageRequest(request.routeKey(), merged);
    }

    /**
     * Merges {@code overlay} over {@code base}.
     *
     * @return an unmodifiable map; a {@code null} overlay value removes the corresponding base entry
     */
    public static Map<String, String> mergeAttributes(Map<String, String> base, Map<String, String> overlay) {
        Map<String, String> merged = new LinkedHashMap<>();
        if (base != null) {
            for (Map.Entry<String, String> entry : base.entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null) {
                    merged.put(entry.getKey(), entry.getValue());
                }
            }
        }
        if (overlay != null) {
            for (Map.Entry<String, String> entry : overlay.entrySet()) {
                if (entry.getKey() == null) {
                    continue;
                }
                if (entry.getValue() == null) {
                    merged.remove(entry.getKey());
                } else {
                    merged.put(entry.getKey(), entry.getValue());
                }
            }
        }
        return Collections.unmodifiableMap(merged);
    }
}
