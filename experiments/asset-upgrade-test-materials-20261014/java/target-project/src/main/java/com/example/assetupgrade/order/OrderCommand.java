package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderCommand.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OrderCommand(com.example.assetupgrade.common.CommandMetadata metadata, OrderRequest order, String pluginId) {}
