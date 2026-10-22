package com.example.assetupgrade.audit;

/**
 * Skeleton seam for AuditQuery.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AuditQuery(com.example.assetupgrade.common.TenantId tenantId, String subjectId, java.time.Instant from, java.time.Instant to, int limit, String cursor) {}
