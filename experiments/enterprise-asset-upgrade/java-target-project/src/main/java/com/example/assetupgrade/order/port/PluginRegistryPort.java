package com.example.assetupgrade.order.port;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.PluginDescriptor;

import java.util.Optional;

/**
 * Tenant-scoped plugin capability registry.
 *
 * <p>{@link #find(TenantId, String)} resolves the descriptor a tenant registered for a plugin;
 * a plugin registered for another tenant must never be returned. No provider type appears here.</p>
 */
public interface PluginRegistryPort {

    /** @return the descriptor for {@code pluginId} owned by {@code tenantId}, if registered. */
    Optional<PluginDescriptor> find(TenantId tenantId, String pluginId);

    /** Compatibility seam; the typed method defines the contract. */
    default Object execute(Object input) {
        if (input instanceof FindRequest request) {
            return find(request.tenantId(), request.pluginId());
        }
        throw new IllegalArgumentException("Expected a FindRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record FindRequest(TenantId tenantId, String pluginId) {
    }
}
