package com.example.assetupgrade.attachment;

import com.example.assetupgrade.attachment.port.AttachmentScanner;

import java.util.Objects;

/**
 * Runs the configured {@link AttachmentScanner} and normalises its outcome.
 *
 * <p>A scanner is treated as fail-closed: a missing port, a {@code null} result or a thrown
 * exception all produce an unclean {@link AttachmentScanResult}, so an attachment can never
 * be released because scanning failed.</p>
 */
public final class AttachmentScanHandler {

    private final AttachmentScanner scanner;

    /** Creates a handler with no scanner; every scan fails closed. */
    public AttachmentScanHandler() {
        this(null);
    }

    /** Creates a handler delegating to {@code scanner}. */
    public AttachmentScanHandler(AttachmentScanner scanner) {
        this.scanner = scanner;
    }

    /** @return the backing scanner, or {@code null} when none is configured. */
    public AttachmentScanner scanner() {
        return scanner;
    }

    /** Runs the scan, converting any failure into an unclean result. */
    public AttachmentScanResult scan(AttachmentMetadata metadata, AttachmentContent content) {
        if (scanner == null) {
            return AttachmentScanResult.failed("none", "no attachment scanner is configured");
        }
        try {
            AttachmentScanResult result = scanner.scan(metadata, content);
            if (result == null) {
                return AttachmentScanResult.failed("unknown", "scanner returned no result");
            }
            return result;
        } catch (RuntimeException ex) {
            String detail = ex.getMessage() == null || ex.getMessage().isBlank()
                    ? ex.getClass().getSimpleName()
                    : ex.getMessage();
            return AttachmentScanResult.failed("error", detail);
        }
    }

    /** @return {@code true} only when {@code result} is present and explicitly clean. */
    public boolean isClean(AttachmentScanResult result) {
        return result != null && result.clean();
    }

    /** @return {@code true} when the scan did not complete or reported the attachment as unsafe. */
    public boolean isBlocked(AttachmentScanResult result) {
        return !isClean(result);
    }

    /** Compatibility seam; accepts an {@link AttachmentIntakeCommand}. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return scan(command.attachment(), command.content());
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand");
    }

    /** Convenience factory for a handler with no scanner. */
    public static AttachmentScanHandler failClosed() {
        return new AttachmentScanHandler(null);
    }

    /** Convenience factory. */
    public static AttachmentScanHandler of(AttachmentScanner scanner) {
        return new AttachmentScanHandler(Objects.requireNonNull(scanner, "scanner"));
    }
}
