package com.example.assetupgrade.routing;

import com.example.assetupgrade.common.TenantId;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tenant-isolated registry of route definitions.
 *
 * <p>A lookup for one tenant must never return another tenant's route. The generic
 * {@link #execute(Object)} seam is retained for early callers; typed methods define the contract.</p>
 */
public interface RouteRegistry {

    /** Registers or replaces {@code definition} for {@code tenantId}. */
    void register(TenantId tenantId, RouteDefinition definition);

    /** @return the route registered under {@code routeKey} for {@code tenantId}, if any. */
    Optional<RouteDefinition> find(TenantId tenantId, String routeKey);

    /** @return all routes registered for {@code tenantId}, never another tenant's. */
    List<RouteDefinition> routesFor(TenantId tenantId);

    /** Compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Use register/find/routesFor");
    }

    /** @return a thread-safe, in-memory, tenant-isolated registry. */
    static RouteRegistry inMemory() {
        return new InMemoryRouteRegistry();
    }

    /** Simple provider-neutral registry used by wiring and tests. */
    final class InMemoryRouteRegistry implements RouteRegistry {

        private final Map<String, Map<String, RouteDefinition>> byTenant = new ConcurrentHashMap<>();

        @Override
        public void register(TenantId tenantId, RouteDefinition definition) {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(definition, "definition");
            byTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>())
                    .put(definition.routeKey(), definition);
        }

        @Override
        public Optional<RouteDefinition> find(TenantId tenantId, String routeKey) {
            Objects.requireNonNull(tenantId, "tenantId");
            if (routeKey == null) {
                return Optional.empty();
            }
            Map<String, RouteDefinition> routes = byTenant.get(tenantId.value());
            return routes == null ? Optional.empty() : Optional.ofNullable(routes.get(routeKey));
        }

        @Override
        public List<RouteDefinition> routesFor(TenantId tenantId) {
            Objects.requireNonNull(tenantId, "tenantId");
            Map<String, RouteDefinition> routes = byTenant.get(tenantId.value());
            return routes == null ? List.of() : List.copyOf(routes.values());
        }
    }
}
