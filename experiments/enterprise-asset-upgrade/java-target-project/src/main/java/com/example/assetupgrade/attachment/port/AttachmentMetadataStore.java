package com.example.assetupgrade.attachment.port;

/**
 * Append-and-find boundary for attachment metadata.
 *
 * <p>Lookups are tenant-scoped: a store must never return another tenant's attachment. The
 * stored value preserves the attachment's state, scan flag and fingerprint unchanged.</p>
 */
public interface AttachmentMetadataStore {

    /** Records or replaces {@code metadata}. */
    void record(com.example.assetupgrade.attachment.AttachmentMetadata metadata);

    /** @return the metadata for {@code attachmentId} owned by {@code tenantId}, if present. */
    java.util.Optional<com.example.assetupgrade.attachment.AttachmentMetadata> find(
            com.example.assetupgrade.common.TenantId tenantId, String attachmentId);

    /** Compatibility seam; the typed contract is {@link #record}/{@link #find}. */
    default Object execute(Object input) {
        if (input instanceof com.example.assetupgrade.attachment.AttachmentMetadata metadata) {
            record(metadata);
            return null;
        }
        if (input instanceof FindRequest request) {
            return find(request.tenantId(), request.attachmentId());
        }
        throw new IllegalArgumentException("Expected AttachmentMetadata or a FindRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record FindRequest(com.example.assetupgrade.common.TenantId tenantId, String attachmentId) {
    }
}
