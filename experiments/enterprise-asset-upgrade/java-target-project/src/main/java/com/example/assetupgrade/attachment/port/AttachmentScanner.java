package com.example.assetupgrade.attachment.port;

/**
 * Scanning boundary that decides whether an attachment payload is safe to release.
 *
 * <p>A scan result is only a pass when its {@code clean} flag is {@code true}. Implementations
 * must never report an unscanned payload as clean.</p>
 */
public interface AttachmentScanner {

    /** Scans {@code content} in the context of {@code metadata}. */
    com.example.assetupgrade.attachment.AttachmentScanResult scan(
            com.example.assetupgrade.attachment.AttachmentMetadata metadata,
            com.example.assetupgrade.attachment.AttachmentContent content);

    /** Compatibility seam; the typed contract is {@link #scan}. */
    default Object execute(Object input) {
        if (input instanceof ScanRequest request) {
            return scan(request.metadata(), request.content());
        }
        throw new IllegalArgumentException("Expected a ScanRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record ScanRequest(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                       com.example.assetupgrade.attachment.AttachmentContent content) {
    }
}
