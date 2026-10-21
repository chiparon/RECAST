package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for Checkpoint.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record Checkpoint(String jobName, String lastEventId, java.time.Instant observedAt, int processed) {}
