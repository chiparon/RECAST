package com.example.assetupgrade.observability;

/**
 * Skeleton seam for CorrelationPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface CorrelationPort {
    Object execute(Object input);
}
