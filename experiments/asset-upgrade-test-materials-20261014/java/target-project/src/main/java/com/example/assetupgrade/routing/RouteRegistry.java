package com.example.assetupgrade.routing;

/**
 * Skeleton seam for RouteRegistry.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface RouteRegistry {
    Object execute(Object input);
}
