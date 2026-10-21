package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.port.PluginRegistryPort;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Builds the {@link PluginInvocation} for an order command and routes capability lookups through
 * the typed {@link PluginRegistryPort}.
 *
 * <p>The handler performs no capability decision itself and never touches inventory: it only
 * normalises the invocation identity and attributes that {@link PluginCapabilityPolicy} and the
 * lifecycle coordinator use. Provider-specific plugin behavior stays behind adapters.</p>
 */
public final class PluginInvocationHandler {

    /** Canonical plugin operation an order submission is translated to. */
    public static final String OPERATION = PluginCapabilityPolicy.ORDER_SUBMIT_OPERATION;

    private final PluginRegistryPort plugins;

    /** Creates a handler with no registry; descriptor lookups return empty. */
    public PluginInvocationHandler() {
        this(null);
    }

    /** Creates a handler resolving descriptors through {@code plugins}. */
    public PluginInvocationHandler(PluginRegistryPort plugins) {
        this.plugins = plugins;
    }

    /** Builds an invocation from its parts, defaulting a blank operation to {@link #OPERATION}. */
    public PluginInvocation build(String pluginId, String operation, String commandId, TenantId tenantId,
                                  Map<String, String> attributes) {
        Map<String, String> normalized = attributes == null ? new LinkedHashMap<>() : new LinkedHashMap<>(attributes);
        return new PluginInvocation(pluginId,
                operation == null || operation.isBlank() ? OPERATION : operation,
                commandId, tenantId, normalized);
    }

    /** Builds an invocation for a resolved descriptor. */
    public PluginInvocation invocation(PluginDescriptor descriptor, String operation, String commandId,
                                       TenantId tenantId, Map<String, String> attributes) {
        String pluginId = descriptor == null ? null : descriptor.pluginId();
        PluginInvocation invocation = build(pluginId, operation, commandId, tenantId, attributes);
        if (descriptor != null && descriptor.version() != null && !descriptor.version().isBlank()) {
            Map<String, String> enriched = new LinkedHashMap<>(invocation.attributes());
            enriched.putIfAbsent("pluginVersion", descriptor.version());
            return new PluginInvocation(invocation.pluginId(), invocation.operation(), invocation.commandId(),
                    invocation.tenantId(), enriched);
        }
        return invocation;
    }

    /** Builds the canonical order-submission invocation for an order command. */
    public PluginInvocation invocationFor(OrderCommand command, PluginDescriptor descriptor) {
        if (command == null) {
            return build(null, OPERATION, null, null, Map.of());
        }
        TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
        return invocation(descriptor, OPERATION, command.orderId(), tenantId, Map.of());
    }

    /** @return the tenant's descriptor for {@code pluginId}, if present and readable. */
    public Optional<PluginDescriptor> descriptor(TenantId tenantId, String pluginId) {
        if (plugins == null || tenantId == null || pluginId == null || pluginId.isBlank()) {
            return Optional.empty();
        }
        try {
            return plugins.find(tenantId, pluginId);
        } catch (RuntimeException failure) {
            return Optional.empty();
        }
    }

    /** @return the plugin registry port, or {@code null} when none is configured. */
    public PluginRegistryPort registry() {
        return plugins;
    }

    /** Compatibility seam; accepts an {@link OrderCommand} and returns the planned invocation. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) {
            PluginDescriptor descriptor = descriptor(command.tenantId(), command.pluginId()).orElse(null);
            return invocationFor(command, descriptor);
        }
        if (input instanceof PluginInvocation invocation) {
            return invocation;
        }
        throw new IllegalArgumentException("Expected an OrderCommand or PluginInvocation");
    }
}
