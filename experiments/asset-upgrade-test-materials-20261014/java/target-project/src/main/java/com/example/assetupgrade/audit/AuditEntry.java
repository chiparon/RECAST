package com.example.assetupgrade.audit;

/**
 * Skeleton seam for AuditEntry.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AuditEntry(com.example.assetupgrade.common.TenantId tenantId, String subjectId, AuditAction action, AuditStatus status, com.example.assetupgrade.common.CorrelationId correlationId, java.time.Instant occurredAt, java.util.Map<String,String> details) {}
