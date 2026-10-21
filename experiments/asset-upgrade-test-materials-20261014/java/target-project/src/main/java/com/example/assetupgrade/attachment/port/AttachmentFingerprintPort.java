package com.example.assetupgrade.attachment.port;

/**
 * Skeleton seam for AttachmentFingerprintPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentFingerprintPort {
    String fingerprint(com.example.assetupgrade.attachment.AttachmentContent content);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
