package com.example.assetupgrade.audit;

/**
 * Skeleton seam for AuditAction.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum AuditAction { ATTACHMENT_INTAKE, ATTACHMENT_QUARANTINE, WORKFLOW_DELIVERY, RECONCILIATION_RUN, ORDER_SUBMISSION, PLUGIN_INVOCATION, SECURITY_DENIAL }
