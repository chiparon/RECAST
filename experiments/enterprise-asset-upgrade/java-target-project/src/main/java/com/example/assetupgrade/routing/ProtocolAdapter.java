package com.example.assetupgrade.routing;

import java.util.Objects;
import java.util.function.BiFunction;

/**
 * Converts a resolved {@link MessageRequest} into a target-protocol payload.
 *
 * <p>Implementations are provider adapters (for example Camel, Kafka or HTTP) and must stay outside
 * the routing model. The generic {@link #execute(Object)} seam accepts an {@link AdaptRequest} holder
 * and is retained for early callers.</p>
 */
public interface ProtocolAdapter {

    /** @return the transport protocol this adapter produces, for example {@code "json"} or {@code "http"}. */
    String protocol();

    /** @return the target-protocol payload for {@code request} routed through {@code route}. */
    Object adapt(RouteDefinition route, MessageRequest request);

    /** @return {@code true} when this adapter produces the protocol declared by {@code route}. */
    default boolean supports(RouteDefinition route) {
        return route != null && Objects.equals(protocol(), route.protocol());
    }

    /** Compatibility seam accepting an {@link AdaptRequest} holder. */
    default Object execute(Object input) {
        if (input instanceof AdaptRequest request) {
            return adapt(request.route(), request.request());
        }
        throw new IllegalArgumentException("Expected ProtocolAdapter.AdaptRequest");
    }

    /** @return an adapter that delegates {@link #adapt} to {@code delegate}. */
    static ProtocolAdapter of(String protocol, BiFunction<RouteDefinition, MessageRequest, Object> delegate) {
        Objects.requireNonNull(protocol, "protocol");
        Objects.requireNonNull(delegate, "delegate");
        return new ProtocolAdapter() {
            @Override
            public String protocol() {
                return protocol;
            }

            @Override
            public Object adapt(RouteDefinition route, MessageRequest request) {
                return delegate.apply(route, request);
            }
        };
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param route   the resolved route
     * @param request the request to adapt
     */
    record AdaptRequest(RouteDefinition route, MessageRequest request) {}
}
