package com.example.assetupgrade.reconciliation.port;

/**
 * Skeleton seam for ReconciliationJobPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ReconciliationJobPort {
    com.example.assetupgrade.reconciliation.ReconciliationReport run(
            com.example.assetupgrade.reconciliation.ReconciliationCommand command);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
