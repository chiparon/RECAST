package com.example.assetupgrade.error;

/**
 * Skeleton seam for ConflictException.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public class ConflictException extends RuntimeException {
    public ConflictException(String message) { super(message); }
}
