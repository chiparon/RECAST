package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for ReconciliationService.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ReconciliationService { ReconciliationReport run(ReconciliationCommand command); }
