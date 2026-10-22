package com.example.assetupgrade.common;

/**
 * Skeleton seam for ProblemCode.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum ProblemCode { INVALID_INPUT, TENANT_DENIED, NOT_FOUND, CONFLICT, QUARANTINED, RETRYABLE, RETRY_EXHAUSTED, TRANSPORT_FAILURE, AUDIT_FAILURE, STORAGE_FAILURE }
