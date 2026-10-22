package com.example.assetupgrade.routing;

import com.example.assetupgrade.common.TenantId;
import java.util.Objects;

/**
 * Stateless route matching predicates. No provider type is referenced.
 */
public final class RouteFilter {

    private RouteFilter() {
    }

    /** @return {@code true} when {@code route}'s key equals {@code request}'s route key. */
    public static boolean matches(RouteDefinition route, MessageRequest request) {
        return route != null
                && request != null
                && Objects.equals(route.routeKey(), request.routeKey());
    }

    /**
     * @return {@code true} when {@code route} belongs to {@code tenantId}; a route with no declared
     *         tenant attribute is tenant-agnostic and matches any tenant.
     */
    public static boolean matchesTenant(RouteDefinition route, TenantId tenantId) {
        if (route == null || tenantId == null) {
            return false;
        }
        String declared = route.tenant();
        return declared == null || declared.equals(tenantId.value());
    }
}
