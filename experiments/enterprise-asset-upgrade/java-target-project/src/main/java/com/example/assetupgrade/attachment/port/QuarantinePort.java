package com.example.assetupgrade.attachment.port;

/**
 * Tenant-scoped boundary holding an attachment back from release.
 *
 * <p>{@link #quarantine} records the reason an attachment is held, while {@link #release}
 * drops the hold for a tenant-owned attachment that has passed a clean scan. Neither
 * operation may affect another tenant's attachment.</p>
 */
public interface QuarantinePort {

    /** Holds {@code metadata} with the supplied {@code reason}. */
    void quarantine(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                    com.example.assetupgrade.attachment.QuarantineReason reason);

    /** Drops the quarantine hold for {@code attachmentId} owned by {@code tenantId}. */
    void release(com.example.assetupgrade.common.TenantId tenantId, String attachmentId);

    /** Compatibility seam; the typed contract is {@link #quarantine}/{@link #release}. */
    default Object execute(Object input) {
        if (input instanceof QuarantineRequest request) {
            quarantine(request.metadata(), request.reason());
            return null;
        }
        if (input instanceof ReleaseRequest request) {
            release(request.tenantId(), request.attachmentId());
            return null;
        }
        throw new IllegalArgumentException("Expected a QuarantineRequest or ReleaseRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record QuarantineRequest(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                             com.example.assetupgrade.attachment.QuarantineReason reason) {
    }

    /** Request holder accepted by the compatibility seam. */
    record ReleaseRequest(com.example.assetupgrade.common.TenantId tenantId, String attachmentId) {
    }
}
