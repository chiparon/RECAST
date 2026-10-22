package com.example.assetupgrade.routing;

/**
 * Skeleton seam for ProtocolAdapter.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ProtocolAdapter {
    Object execute(Object input);
}
