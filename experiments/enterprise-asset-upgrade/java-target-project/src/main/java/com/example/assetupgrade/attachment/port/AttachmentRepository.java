package com.example.assetupgrade.attachment.port;

/**
 * Tenant-scoped persistence boundary for attachment metadata.
 *
 * <p>{@link #find} must only return an attachment owned by {@code tenantId} and must never
 * expose another tenant's record; {@link #save} persists the current lifecycle state.</p>
 */
public interface AttachmentRepository {

    /** @return the metadata for {@code attachmentId} owned by {@code tenantId}, if present. */
    java.util.Optional<com.example.assetupgrade.attachment.AttachmentMetadata> find(
            com.example.assetupgrade.common.TenantId tenantId, String attachmentId);

    /** Persists {@code metadata}, replacing any prior state for the same tenant and id. */
    void save(com.example.assetupgrade.attachment.AttachmentMetadata metadata);

    /** Compatibility seam; the typed contract is {@link #save}/{@link #find}. */
    default Object execute(Object input) {
        if (input instanceof com.example.assetupgrade.attachment.AttachmentMetadata metadata) {
            save(metadata);
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
