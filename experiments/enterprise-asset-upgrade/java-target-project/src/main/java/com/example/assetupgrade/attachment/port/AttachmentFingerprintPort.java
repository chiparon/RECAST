package com.example.assetupgrade.attachment.port;

/**
 * Computes a stable content fingerprint used for duplicate detection and audit evidence.
 *
 * <p>A fingerprint must be deterministic for identical bytes and must not leak tenant data.
 * The value is surfaced through {@code AttachmentMetadata.contentHash}.</p>
 */
public interface AttachmentFingerprintPort {

    /** @return a stable fingerprint for {@code content}, or {@code null} when it cannot be computed. */
    String fingerprint(com.example.assetupgrade.attachment.AttachmentContent content);

    /** Compatibility seam; the typed contract is {@link #fingerprint}. */
    default Object execute(Object input) {
        if (input instanceof com.example.assetupgrade.attachment.AttachmentContent content) {
            return fingerprint(content);
        }
        throw new IllegalArgumentException("Expected AttachmentContent");
    }
}
