package com.example.assetupgrade.attachment.port;

/**
 * Boundary that materialises the content of a previously staged upload.
 *
 * <p>Implementations must return a fresh, independently readable content view for each
 * {@link #open(String)} call so the intake boundary can fingerprint and scan the same upload.</p>
 */
public interface UploadStreamPort {

    /** Opens the content staged under {@code uploadId}. */
    com.example.assetupgrade.attachment.AttachmentContent open(String uploadId);

    /** Compatibility seam; the typed contract is {@link #open}. */
    default Object execute(Object input) {
        if (input instanceof String uploadId) {
            return open(uploadId);
        }
        throw new IllegalArgumentException("Expected an upload id String");
    }
}
