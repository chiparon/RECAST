package com.example.assetupgrade.order;

/**
 * Skeleton seam for PluginDescriptor.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record PluginDescriptor(String pluginId, com.example.assetupgrade.common.TenantId tenantId, String version, java.util.Set<String> capabilities, boolean enabled, java.util.Map<String,String> configuration) {}
