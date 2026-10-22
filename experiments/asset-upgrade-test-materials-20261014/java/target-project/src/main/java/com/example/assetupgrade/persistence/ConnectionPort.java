package com.example.assetupgrade.persistence;

/**
 * Skeleton seam for ConnectionPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ConnectionPort {
    Object execute(Object input);
}
