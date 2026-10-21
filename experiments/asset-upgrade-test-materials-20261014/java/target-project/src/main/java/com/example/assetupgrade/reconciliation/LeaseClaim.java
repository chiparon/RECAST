package com.example.assetupgrade.reconciliation;

/**
 * Skeleton seam for LeaseClaim.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record LeaseClaim(String key, com.example.assetupgrade.common.TenantId tenantId, java.time.Instant expiresAt, String owner) {}
