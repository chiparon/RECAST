package com.example.assetupgrade.error;

/**
 * Skeleton seam for StorageFailureException.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public class StorageFailureException extends RuntimeException {
    public StorageFailureException(String message) { super(message); }
}
