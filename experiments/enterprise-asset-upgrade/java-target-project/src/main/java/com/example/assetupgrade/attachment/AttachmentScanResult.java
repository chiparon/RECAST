package com.example.assetupgrade.attachment;


/**
 * Outcome of scanning an attachment for malicious or unexpected content.
 *
 * <p>The record components {@code clean, scannerName, signature, detail} are the public
 * contract. A result is only ever treated as a pass when {@link #clean()} is
 * {@code true}; an absent result, a scanner exception or an explicitly unclean verdict all
 * block release.</p>
 */
public record AttachmentScanResult(boolean clean, String scannerName, String signature, String detail) {

    public AttachmentScanResult {
        scannerName = scannerName == null || scannerName.isBlank() ? "unknown" : scannerName.trim();
        signature = signature == null || signature.isBlank() ? null : signature.trim();
        detail = detail == null ? "" : detail;
    }

    /** Creates a clean result. */
    public static AttachmentScanResult clean(String scannerName, String signature) {
        return new AttachmentScanResult(true, scannerName, signature, "");
    }

    /** Creates a clean result with no reported signature. */
    public static AttachmentScanResult clean(String scannerName) {
        return clean(scannerName, null);
    }

    /** Creates an unclean (blocked) result. */
    public static AttachmentScanResult infected(String scannerName, String signature, String detail) {
        return new AttachmentScanResult(false, scannerName, signature, detail);
    }

    /** Creates a failing result describing why the scan could not complete. */
    public static AttachmentScanResult failed(String scannerName, String detail) {
        return new AttachmentScanResult(false, scannerName, null, detail);
    }

    /** @return {@code true} when the attachment passed the scan. */
    public boolean isClean() {
        return clean;
    }

    /** @return {@code true} when the attachment did not pass the scan. */
    public boolean isBlocked() {
        return !clean;
    }

    /** @return a short, human-readable summary of the verdict. */
    public String summary() {
        return clean
                ? "clean"
                : "blocked by " + scannerName + (detail.isEmpty() ? "" : ": " + detail);
    }
}
