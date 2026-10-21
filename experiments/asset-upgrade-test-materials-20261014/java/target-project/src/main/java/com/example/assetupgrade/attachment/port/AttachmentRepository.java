package com.example.assetupgrade.attachment.port;

/**
 * Skeleton seam for AttachmentRepository.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentRepository {
    java.util.Optional<com.example.assetupgrade.attachment.AttachmentMetadata> find(
            com.example.assetupgrade.common.TenantId tenantId, String attachmentId);
    void save(com.example.assetupgrade.attachment.AttachmentMetadata metadata);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
