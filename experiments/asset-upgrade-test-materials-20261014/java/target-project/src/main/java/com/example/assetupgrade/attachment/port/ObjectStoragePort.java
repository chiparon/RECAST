package com.example.assetupgrade.attachment.port;

/**
 * Skeleton seam for ObjectStoragePort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ObjectStoragePort {
    void store(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
               com.example.assetupgrade.attachment.AttachmentContent content);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
