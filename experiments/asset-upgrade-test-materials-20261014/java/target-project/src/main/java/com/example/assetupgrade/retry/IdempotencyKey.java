package com.example.assetupgrade.retry;

/**
 * Skeleton seam for IdempotencyKey.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record IdempotencyKey(com.example.assetupgrade.common.TenantId tenantId, String operation, String subjectId) {}
