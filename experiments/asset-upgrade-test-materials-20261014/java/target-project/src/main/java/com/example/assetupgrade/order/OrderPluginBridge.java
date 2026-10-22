package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderPluginBridge.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OrderPluginBridge { OrderResult submit(OrderCommand command); }
