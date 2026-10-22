package com.example.assetupgrade.audit;

/**
 * Skeleton seam for AuditFailurePolicy.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AuditFailurePolicy { boolean completionMayBeReportedWhenAuditFails(AuditEntry attemptedEntry); }
