package com.example.assetupgrade.persistence;

/**
 * Skeleton seam for OptimisticLockPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OptimisticLockPort {
    Object execute(Object input);
}
