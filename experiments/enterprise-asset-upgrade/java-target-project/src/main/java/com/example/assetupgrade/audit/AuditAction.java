package com.example.assetupgrade.audit;

/**
 * Enumerates the auditable business actions recorded across the asset-upgrade modules.
 *
 * <p>The constant set and declaration order are fixed invariants: attachment intake and
 * quarantine, workflow delivery, scheduled reconciliation, order submission, plugin
 * invocation and security denial are the only audit actions the platform recognises.
 * Callers in the attachment, workflow, reconciliation, order and security modules bind
 * directly to these names; do not add, rename or reorder values.</p>
 */
public enum AuditAction { ATTACHMENT_INTAKE, ATTACHMENT_QUARANTINE, WORKFLOW_DELIVERY, RECONCILIATION_RUN, ORDER_SUBMISSION, PLUGIN_INVOCATION, SECURITY_DENIAL }
