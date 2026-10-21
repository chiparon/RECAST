package com.example.assetupgrade.persistence;

/**
 * Skeleton seam for TransactionPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface TransactionPort {
    <T> T inTransaction(java.util.function.Supplier<T> operation);
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
