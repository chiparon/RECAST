package com.example.assetupgrade.attachment.port;

/**
 * Skeleton seam for AttachmentMetadataStore.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentMetadataStore {
    void record(com.example.assetupgrade.attachment.AttachmentMetadata metadata);
    java.util.Optional<com.example.assetupgrade.attachment.AttachmentMetadata> find(
            com.example.assetupgrade.common.TenantId tenantId, String attachmentId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
