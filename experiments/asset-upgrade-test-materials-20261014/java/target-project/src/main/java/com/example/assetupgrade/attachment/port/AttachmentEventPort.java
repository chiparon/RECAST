package com.example.assetupgrade.attachment.port;

/**
 * Skeleton seam for AttachmentEventPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentEventPort {
    void publish(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                 com.example.assetupgrade.common.CorrelationId correlationId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
