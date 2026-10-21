package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for ReconciliationReport.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record ReconciliationReport(int examined, int retried, int succeeded, int failed, java.util.List<String> eventIds, String checkpoint) {}
