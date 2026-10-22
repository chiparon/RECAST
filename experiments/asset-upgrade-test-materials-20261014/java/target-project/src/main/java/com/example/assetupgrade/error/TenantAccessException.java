package com.example.assetupgrade.error;

/**
 * Skeleton seam for TenantAccessException.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public class TenantAccessException extends RuntimeException {
    public TenantAccessException(String message) { super(message); }
}
