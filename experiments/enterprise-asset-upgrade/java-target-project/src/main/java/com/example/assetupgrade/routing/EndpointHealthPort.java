package com.example.assetupgrade.routing;

import com.example.assetupgrade.common.TenantId;

/**
 * Tenant-scoped endpoint health probe used to prefer healthy routes during resolution.
 *
 * <p>Only the tenant that owns a route may have its health consulted; implementations must never
 * expose another tenant's endpoint state. The generic {@link #execute(Object)} seam is retained for
 * early callers and is not part of the typed contract.</p>
 */
@FunctionalInterface
public interface EndpointHealthPort {

    /** @return {@code true} when {@code route}'s endpoint is healthy for {@code tenantId}. */
    boolean isHealthy(TenantId tenantId, RouteDefinition route);

    /** @return a probe that reports every endpoint healthy. */
    static EndpointHealthPort alwaysHealthy() {
        return (tenantId, route) -> true;
    }

    /** Compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Use isHealthy(TenantId, RouteDefinition)");
    }
}
