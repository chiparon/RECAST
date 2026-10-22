package com.example.assetupgrade.order;

/**
 * Skeleton seam for PluginInvocation.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record PluginInvocation(String pluginId, String operation, String commandId, com.example.assetupgrade.common.TenantId tenantId, java.util.Map<String,String> attributes) {}
