package com.example.assetupgrade.persistence;

/**
 * Skeleton seam for RepositoryException.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public class RepositoryException extends RuntimeException {
    public RepositoryException(String message) { super(message); }
}
