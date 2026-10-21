package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
/**
 * Immutable description of an attachment as it flows through intake, quarantine, scan and
 * release.
 *
 * <p>The record components {@code attachmentId, tenantId, fileName, declaredContentType,
 * contentLength, contentHash, state, scanned, receivedAt} are the public contract bound by
 * the intake boundary, the repositories and the policy code. The canonical constructor
 * normalises the identifier and file name, defaults a missing declaration, clamps a
 * negative declared length, and supplies sane defaults for state and receipt time.
 * Functional {@code with*} helpers return updated copies without mutating this value.</p>
 */
public record AttachmentMetadata(
        String attachmentId,
        TenantId tenantId,
        String fileName,
        AttachmentContentType declaredContentType,
        long contentLength,
        String contentHash,
        AttachmentState state,
        boolean scanned,
        Instant receivedAt) {

    public AttachmentMetadata {
        attachmentId = attachmentId == null ? "" : attachmentId.trim();
        fileName = fileName == null ? "" : fileName.trim();
        declaredContentType = declaredContentType == null ? new AttachmentContentType(null) : declaredContentType;
        contentLength = Math.max(contentLength, 0L);
        contentHash = contentHash == null || contentHash.isBlank() ? null : contentHash.trim();
        state = state == null ? AttachmentState.RECEIVED : state;
        receivedAt = receivedAt == null ? Instant.now() : receivedAt;
    }

    /** @return a copy of this metadata in {@code newState}. */
    public AttachmentMetadata withState(AttachmentState newState) {
        return new AttachmentMetadata(attachmentId, tenantId, fileName, declaredContentType,
                contentLength, contentHash, newState, scanned, receivedAt);
    }

    /** @return a copy of this metadata with the scan flag set. */
    public AttachmentMetadata withScanned(boolean scannedNow) {
        return new AttachmentMetadata(attachmentId, tenantId, fileName, declaredContentType,
                contentLength, contentHash, state, scannedNow, receivedAt);
    }

    /** @return a copy of this metadata with a normalised file name. */
    public AttachmentMetadata withFileName(String newFileName) {
        return new AttachmentMetadata(attachmentId, tenantId, newFileName, declaredContentType,
                contentLength, contentHash, state, scanned, receivedAt);
    }

    /** @return a copy of this metadata with the supplied content fingerprint. */
    public AttachmentMetadata withContentHash(String newContentHash) {
        return new AttachmentMetadata(attachmentId, tenantId, fileName, declaredContentType,
                contentLength, newContentHash, state, scanned, receivedAt);
    }

    /** @return a copy of this metadata with an updated declared length. */
    public AttachmentMetadata withContentLength(long newContentLength) {
        return new AttachmentMetadata(attachmentId, tenantId, fileName, declaredContentType,
                newContentLength, contentHash, state, scanned, receivedAt);
    }

    /** @return {@code true} when this metadata belongs to {@code candidate}. */
    public boolean belongsTo(TenantId candidate) {
        return candidate != null && tenantId.equals(candidate);
    }

    /** @return {@code true} when the attachment passed a content scan. */
    public boolean isScanned() {
        return scanned;
    }

    /** @return {@code true} when the attachment has been released to its consumers. */
    public boolean isReleased() {
        return state == AttachmentState.RELEASED;
    }

    /** @return {@code true} when the attachment may be transitioned into {@link AttachmentState#RELEASED}. */
    public boolean isReleasable() {
        return scanned && state != AttachmentState.REJECTED && state != AttachmentState.RELEASED;
    }

    /** @return the normalised, lower-cased file extension without the leading dot, or {@code ""}. */
    public String extension() {
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) {
            return "";
        }
        return fileName.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
    }
}
