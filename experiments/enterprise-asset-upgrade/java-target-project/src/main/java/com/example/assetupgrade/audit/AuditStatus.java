package com.example.assetupgrade.audit;

/**
 * Enumerates the lifecycle statuses an {@link AuditEntry} may carry.
 *
 * <p>The constant set and declaration order are fixed invariants preserved across tenants:
 * {@code RECEIVED}, {@code ACCEPTED}, {@code REJECTED}, {@code QUARANTINED},
 * {@code RETRY_PENDING}, {@code COMPLETED}, {@code DUPLICATE}, {@code ROLLED_BACK} and
 * {@code FAILED}. Do not add, rename or reorder values.</p>
 */
public enum AuditStatus { RECEIVED, ACCEPTED, REJECTED, QUARANTINED, RETRY_PENDING, COMPLETED, DUPLICATE, ROLLED_BACK, FAILED }
