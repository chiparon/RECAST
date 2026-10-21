package com.example.assetupgrade.routing;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ConflictException;
import com.example.assetupgrade.error.ValidationException;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Resolves a {@link MessageRequest} to exactly one route for a tenant.
 *
 * <p>Resolution is tenant-scoped: only the registry routes of {@code tenantId} are considered, the
 * request marker is matched against the route key, and routes whose endpoint is healthy are
 * preferred. A missing route fails with {@link ValidationException}; ambiguity fails with
 * {@link ConflictException}.</p>
 */
public interface RouteResolver {

    /**
     * @return the single route for {@code request}
     * @throws ValidationException when no route matches
     * @throws ConflictException   when more than one route matches
     */
    RouteDefinition resolve(TenantId tenantId, MessageRequest request);

    /** @return the single route for {@code request}, or empty when none matches. */
    Optional<RouteDefinition> find(TenantId tenantId, MessageRequest request);

    /** Compatibility seam accepting a {@link RouteRequest} holder. */
    default Object execute(Object input) {
        if (input instanceof RouteRequest request) {
            return resolve(request.tenantId(), request.request());
        }
        throw new IllegalArgumentException("Expected RouteResolver.RouteRequest");
    }

    /** @return a resolver over {@code registry} that ignores endpoint health. */
    static RouteResolver over(RouteRegistry registry) {
        return new DefaultRouteResolver(registry, null);
    }

    /** @return a resolver over {@code registry} that prefers healthy endpoints. */
    static RouteResolver over(RouteRegistry registry, EndpointHealthPort health) {
        return new DefaultRouteResolver(registry, health);
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param tenantId the owning tenant
     * @param request  the request to resolve
     */
    record RouteRequest(TenantId tenantId, MessageRequest request) {}

    /** Default tenant-scoped resolution algorithm. */
    final class DefaultRouteResolver implements RouteResolver {

        private final RouteRegistry registry;
        private final EndpointHealthPort health;

        DefaultRouteResolver(RouteRegistry registry, EndpointHealthPort health) {
            this.registry = Objects.requireNonNull(registry, "registry");
            this.health = health;
        }

        @Override
        public RouteDefinition resolve(TenantId tenantId, MessageRequest request) {
            return find(tenantId, request).orElseThrow(() -> new ValidationException(
                    "no route for key " + (request == null ? null : request.routeKey())));
        }

        @Override
        public Optional<RouteDefinition> find(TenantId tenantId, MessageRequest request) {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(request, "request");

            List<RouteDefinition> matches = registry.routesFor(tenantId).stream()
                    .filter(route -> RouteFilter.matchesTenant(route, tenantId))
                    .filter(route -> RouteFilter.matches(route, request))
                    .toList();
            if (matches.isEmpty()) {
                return Optional.empty();
            }

            List<RouteDefinition> healthy = health == null
                    ? List.of()
                    : matches.stream().filter(route -> isHealthy(tenantId, route)).toList();
            List<RouteDefinition> preferred = healthy.isEmpty() ? matches : healthy;
            if (preferred.size() > 1) {
                throw new ConflictException("ambiguous route for key " + request.routeKey());
            }
            return Optional.of(preferred.get(0));
        }

        private boolean isHealthy(TenantId tenantId, RouteDefinition route) {
            try {
                return health.isHealthy(tenantId, route);
            } catch (RuntimeException failure) {
                // A failing probe must never turn a resolvable route into a hard failure.
                return false;
            }
        }
    }
}
