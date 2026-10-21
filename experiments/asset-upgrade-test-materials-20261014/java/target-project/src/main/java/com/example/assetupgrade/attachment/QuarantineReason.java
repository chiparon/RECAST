package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for QuarantineReason.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum QuarantineReason { TENANT_MISMATCH, UNSAFE_NAME, SIZE_LIMIT, CONTENT_SIGNATURE, SCAN_PENDING, SCAN_FAILED, DUPLICATE_CONTENT, STORAGE_ERROR }
