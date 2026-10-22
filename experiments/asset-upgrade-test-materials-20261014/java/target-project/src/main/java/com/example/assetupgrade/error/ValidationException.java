package com.example.assetupgrade.error;

/**
 * Skeleton seam for ValidationException.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public class ValidationException extends RuntimeException {
    public ValidationException(String message) { super(message); }
}
