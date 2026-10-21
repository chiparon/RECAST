package com.example.assetupgrade.routing;

/**
 * Skeleton seam for EndpointHealthPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface EndpointHealthPort {
    Object execute(Object input);
}
