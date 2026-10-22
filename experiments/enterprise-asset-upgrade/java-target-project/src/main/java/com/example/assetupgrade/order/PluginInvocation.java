package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One tenant-scoped plugin invocation planned or executed for an order command.
 *
 * <p>The record components {@code pluginId, operation, commandId, tenantId, attributes} are the
 * public contract. {@code attributes} is a JSON-compatible string map carrying the invocation
 * inputs that an adapter forwards to the plugin runtime.</p>
 *
 * @param pluginId   the resolved plugin identity
 * @param operation  the requested plugin operation
 * @param commandId  the originating command identity
 * @param tenantId   the owning tenant
 * @param attributes the invocation attributes
 */
public record PluginInvocation(String pluginId, String operation, String commandId, TenantId tenantId,
                               Map<String, String> attributes) {

    public PluginInvocation {
        attributes = attributes == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(attributes));
    }

    /** @return {@code true} when {@code tenantId} owns this invocation. */
    public boolean belongsTo(TenantId tenantId) {
        return tenantId != null && tenantId.equals(this.tenantId);
    }

    /** Creates an invocation from its parts. */
    public static PluginInvocation of(String pluginId, String operation, String commandId, TenantId tenantId,
                                      Map<String, String> attributes) {
        return new PluginInvocation(pluginId, operation, commandId, tenantId, attributes);
    }
}
