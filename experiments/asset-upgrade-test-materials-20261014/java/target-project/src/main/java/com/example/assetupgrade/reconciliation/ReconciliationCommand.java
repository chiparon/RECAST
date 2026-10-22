package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for ReconciliationCommand.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record ReconciliationCommand(com.example.assetupgrade.common.CommandMetadata metadata, java.time.Instant now, int limit, String jobName) {}
