package com.example.assetupgrade.attachment.port;

/**
 * Tenant-scoped boundary for persisting an attachment's bytes.
 *
 * <p>Content is written under the tenant-qualified key derived from
 * {@code metadata.tenantId()} and {@code metadata.attachmentId()}; the port must never write
 * across tenants.</p>
 */
public interface ObjectStoragePort {

    /** Stores {@code content} for {@code metadata}. */
    void store(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
               com.example.assetupgrade.attachment.AttachmentContent content);

    /** Compatibility seam; the typed contract is {@link #store}. */
    default Object execute(Object input) {
        if (input instanceof StoreRequest request) {
            store(request.metadata(), request.content());
            return null;
        }
        throw new IllegalArgumentException("Expected a StoreRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record StoreRequest(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                        com.example.assetupgrade.attachment.AttachmentContent content) {
    }
}
