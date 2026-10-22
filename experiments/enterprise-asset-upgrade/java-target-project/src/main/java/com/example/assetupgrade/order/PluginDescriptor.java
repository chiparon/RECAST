package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Tenant-scoped registration record describing an order plugin and the capabilities it grants.
 *
 * <p>The record components {@code pluginId, tenantId, version, capabilities, enabled,
 * configuration} are the public contract. {@code capabilities} and {@code configuration} are
 * defensively copied into immutable collections; the configuration remains a string-keyed,
 * string-valued map so it is JSON compatible by construction.</p>
 *
 * @param pluginId      the plugin identity
 * @param tenantId      the owning tenant
 * @param version       the registered plugin version
 * @param capabilities  the operations the plugin declares it can perform
 * @param enabled       whether the plugin is currently enabled for the tenant
 * @param configuration the plugin configuration, a JSON-compatible string map
 */
public record PluginDescriptor(String pluginId, TenantId tenantId, String version, Set<String> capabilities,
                               boolean enabled, Map<String, String> configuration) {

    public PluginDescriptor {
        capabilities = capabilities == null
                ? Set.of()
                : Collections.unmodifiableSet(new LinkedHashSet<>(capabilities));
        configuration = configuration == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(configuration));
    }

    /** @return {@code true} when the plugin declares {@code operation} as a capability. */
    public boolean hasCapability(String operation) {
        return operation != null && !operation.isBlank() && capabilities.contains(operation);
    }

    /** @return {@code true} when {@code tenantId} owns this plugin registration. */
    public boolean belongsTo(TenantId tenantId) {
        return tenantId != null && tenantId.equals(this.tenantId);
    }

    /** @return {@code true} when the plugin is enabled and has an identity. */
    public boolean isUsable() {
        return enabled && pluginId != null && !pluginId.isBlank();
    }

    /** @return {@code true} when the plugin declares at least one capability. */
    public boolean hasCapabilities() {
        return !capabilities.isEmpty();
    }

    /** Creates a descriptor from its parts. */
    public static PluginDescriptor of(String pluginId, TenantId tenantId, String version, Set<String> capabilities,
                                      boolean enabled, Map<String, String> configuration) {
        return new PluginDescriptor(pluginId, tenantId, version, capabilities, enabled, configuration);
    }
}
