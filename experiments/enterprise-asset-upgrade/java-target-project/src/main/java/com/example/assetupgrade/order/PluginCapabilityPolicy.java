package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.port.PluginRegistryPort;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Application-layer decision that resolves a tenant's plugin capability before any inventory or
 * commit side effect is performed.
 *
 * <p>{@link #resolve(TenantId, String, String)} looks the descriptor up through the tenant-scoped
 * {@link PluginRegistryPort} and requires a present, enabled registration whose capabilities grant
 * the requested operation and whose configuration is a JSON-compatible string map. The decision
 * returns a {@link ServiceProblem} (never a provider type) when the plugin may not be invoked.</p>
 */
public final class PluginCapabilityPolicy {

    /** Canonical operation an order submission is translated to at the plugin boundary. */
    public static final String ORDER_SUBMIT_OPERATION = "order-submit";

    private static final Set<String> OPERATION_ALIASES = Set.of(
            "order-submit", "order.submit", "order_submit", "ORDER_SUBMIT",
            "order-submission", "order.submission", "orderSubmission",
            "submit", "submit-order", "create-order", "place-order", "order", "*");

    private final PluginRegistryPort plugins;

    /** Creates a policy with no registry; every capability resolution fails closed. */
    public PluginCapabilityPolicy() {
        this(null);
    }

    /** Creates a policy resolving descriptors through {@code plugins}. */
    public PluginCapabilityPolicy(PluginRegistryPort plugins) {
        this.plugins = plugins;
    }

    /**
     * Resolves the plugin capability for an order submission.
     *
     * @param tenantId  the owning tenant
     * @param pluginId  the requested plugin
     * @param operation the requested operation
     * @return {@code null} when the capability is granted, otherwise the blocking problem
     */
    public ServiceProblem resolve(TenantId tenantId, String pluginId, String operation) {
        if (tenantId == null) {
            return ServiceProblem.of(ProblemCode.INVALID_INPUT, "plugin resolution requires a tenant");
        }
        if (pluginId == null || pluginId.isBlank()) {
            return ServiceProblem.of(ProblemCode.INVALID_INPUT, "pluginId is required");
        }
        String requested = operation == null || operation.isBlank() ? ORDER_SUBMIT_OPERATION : operation;
        if (plugins == null) {
            return ServiceProblem.of(ProblemCode.CONFLICT,
                    "plugin registry is not configured", pluginId);
        }
        PluginDescriptor descriptor;
        try {
            descriptor = plugins.find(tenantId, pluginId).orElse(null);
        } catch (RuntimeException failure) {
            return ServiceProblem.of(ProblemCode.CONFLICT,
                    "plugin registry could not be read: " + describe(failure), pluginId);
        }
        if (descriptor == null) {
            return ServiceProblem.of(ProblemCode.CONFLICT,
                    "plugin is not registered for the tenant", pluginId);
        }
        if (descriptor.tenantId() != null && !descriptor.tenantId().equals(tenantId)) {
            return ServiceProblem.of(ProblemCode.CONFLICT,
                    "plugin is registered for another tenant", pluginId);
        }
        if (!descriptor.enabled()) {
            return ServiceProblem.of(ProblemCode.CONFLICT, "plugin is disabled", pluginId);
        }
        if (!capabilityGranted(descriptor, requested)) {
            return ServiceProblem.of(ProblemCode.CONFLICT,
                    "plugin does not declare the requested capability: " + requested, pluginId);
        }
        return validateConfiguration(descriptor);
    }

    /** @return the blocking problem wrapped in an {@link Optional}, empty when the capability is granted. */
    public Optional<ServiceProblem> validate(TenantId tenantId, String pluginId, String operation) {
        return Optional.ofNullable(resolve(tenantId, pluginId, operation));
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

    /** @return {@code true} when the plugin capability is granted. */
    public boolean isCapable(TenantId tenantId, String pluginId, String operation) {
        return resolve(tenantId, pluginId, operation) == null;
    }

    /** Compatibility seam; accepts a {@link CapabilityRequest} and returns the blocking problem. */
    public Object execute(Object input) {
        if (input instanceof CapabilityRequest request) {
            return resolve(request.tenantId(), request.pluginId(), request.operation());
        }
        throw new IllegalArgumentException("Expected a CapabilityRequest");
    }

    private static boolean capabilityGranted(PluginDescriptor descriptor, String operation) {
        if (descriptor.hasCapability(operation)) {
            return true;
        }
        Set<String> declared = descriptor.capabilities();
        if (declared.isEmpty()) {
            return false;
        }
        if (declared.contains("*")) {
            return true;
        }
        Set<String> accepted = new LinkedHashSet<>(OPERATION_ALIASES);
        accepted.add(ORDER_SUBMIT_OPERATION);
        for (String alias : accepted) {
            if (descriptor.hasCapability(alias)) {
                return true;
            }
        }
        return false;
    }

    private static ServiceProblem validateConfiguration(PluginDescriptor descriptor) {
        for (Map.Entry<String, String> entry : descriptor.configuration().entrySet()) {
            if (entry.getKey() == null || entry.getKey().isBlank()) {
                return ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "plugin configuration has a non-string or blank key", descriptor.pluginId());
            }
        }
        return null;
    }

    private static String describe(RuntimeException failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    /** Request holder accepted by the compatibility seam. */
    public record CapabilityRequest(TenantId tenantId, String pluginId, String operation) {
    }
}
