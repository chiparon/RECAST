package com.example.assetupgrade.persistence;

/**
 * Skeleton seam for MigrationPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface MigrationPort {
    Object execute(Object input);
}
