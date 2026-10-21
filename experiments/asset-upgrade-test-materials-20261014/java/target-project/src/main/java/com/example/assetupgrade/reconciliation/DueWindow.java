package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for DueWindow.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record DueWindow(java.time.Instant from, java.time.Instant to, int limit) {}
