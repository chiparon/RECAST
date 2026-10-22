package com.example.assetupgrade.attachment.port;

/**
 * Tenant-scoped boundary for removing a stored attachment's bytes.
 *
 * <p>An implementation must only ever remove objects belonging to the supplied tenant and
 * must never expose another tenant's storage key.</p>
 */
public interface AttachmentCleanupPort {

    /** Removes the stored content for {@code attachmentId} owned by {@code tenantId}. */
    void remove(com.example.assetupgrade.common.TenantId tenantId, String attachmentId);

    /** Compatibility seam; the typed contract is {@link #remove(com.example.assetupgrade.common.TenantId, String)}. */
    default Object execute(Object input) {
        if (input instanceof CleanupRequest request) {
            remove(request.tenantId(), request.attachmentId());
            return null;
        }
        throw new IllegalArgumentException("Expected a CleanupRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record CleanupRequest(com.example.assetupgrade.common.TenantId tenantId, String attachmentId) {
    }
}
