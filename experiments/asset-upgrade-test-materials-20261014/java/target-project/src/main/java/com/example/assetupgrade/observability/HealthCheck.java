package com.example.assetupgrade.observability;

/**
 * Skeleton seam for HealthCheck.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface HealthCheck {
    Object execute(Object input);
}
