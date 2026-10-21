package com.example.assetupgrade.audit;

/**
 * Skeleton seam for AuditStatus.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum AuditStatus { RECEIVED, ACCEPTED, REJECTED, QUARANTINED, RETRY_PENDING, COMPLETED, DUPLICATE, ROLLED_BACK, FAILED }
