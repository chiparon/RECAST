package com.example.assetupgrade.error;

/**
 * Skeleton seam for RetryableTransportException.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public class RetryableTransportException extends RuntimeException {
    public RetryableTransportException(String message) { super(message); }
}
