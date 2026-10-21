package com.example.assetupgrade.attachment.port;

/**
 * Skeleton seam for UploadStreamPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface UploadStreamPort {
    com.example.assetupgrade.attachment.AttachmentContent open(String uploadId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
