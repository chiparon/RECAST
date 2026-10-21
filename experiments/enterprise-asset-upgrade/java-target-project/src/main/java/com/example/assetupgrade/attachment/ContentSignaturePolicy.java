package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;


import java.util.ArrayList;
import java.util.List;


/**
 * Verifies that an attachment's leading bytes are consistent with its declared media type.
 *
 * <p>The policy inspects magic numbers (PNG, JPEG, GIF, PDF, ZIP/RIFF containers and the
 * UTF-8 byte-order mark) and compares the detected family with the caller's declaration. A
 * payload whose declared type is explicit but whose bytes clearly belong to a different
 * family is rejected; an inconclusive payload (for example plain text) is accepted so that
 * a legitimate declaration is never blocked on a missing signature.</p>
 */
public final class ContentSignaturePolicy {

    private static final int PROBE_LENGTH = 16;

    /** Creates a signature policy. */
    public ContentSignaturePolicy() {
    }

    /**
     * Detects the media type family implied by the payload's magic bytes.
     *
     * @return the detected media type, or {@code null} when the bytes are inconclusive
     */
    public String detect(AttachmentContent content) {
        if (content == null) {
            return null;
        }
        byte[] head;
        try {
            head = content.readPrefix(PROBE_LENGTH);
        } catch (RuntimeException ex) {
            return null;
        }
        return detect(head);
    }

    /** @return the media type implied by {@code head}, or {@code null} when inconclusive. */
    public String detect(byte[] head) {
        if (head == null || head.length == 0) {
            return null;
        }
        if (startsWith(head, (byte) 0x89, 'P', 'N', 'G')) {
            return "image/png";
        }
        if (startsWith(head, (byte) 0xFF, (byte) 0xD8, (byte) 0xFF)) {
            return "image/jpeg";
        }
        if (startsWith(head, 'G', 'I', 'F', '8')) {
            return "image/gif";
        }
        if (startsWith(head, '%', 'P', 'D', 'F')) {
            return "application/pdf";
        }
        if (startsWith(head, 'B', 'M')) {
            return "image/bmp";
        }
        if (startsWith(head, 'P', 'K', (byte) 0x03, (byte) 0x04)
                || startsWith(head, 'P', 'K', (byte) 0x05, (byte) 0x06)
                || startsWith(head, 'P', 'K', (byte) 0x07, (byte) 0x08)) {
            return "application/zip";
        }
        if (isRiffWebp(head)) {
            return "image/webp";
        }
        if (isUtf8Bom(head)) {
            return "text/plain";
        }
        if (looksLikeText(head)) {
            return "text/plain";
        }
        return null;
    }

    /**
     * @return {@code true} when the payload is consistent with the declared media type; a
     *         missing declaration or an inconclusive payload is accepted
     */
    public boolean matches(AttachmentMetadata metadata, AttachmentContent content) {
        if (metadata == null) {
            return true;
        }
        AttachmentContentType declared = metadata.declaredContentType();
        if (declared == null || declared.isOctetStream() || declared.isWildcard()) {
            return true;
        }
        String detected = detect(content);
        if (detected == null) {
            return true;
        }
        AttachmentContentType detectedType = new AttachmentContentType(detected);
        if (declared.accepts(detectedType)) {
            return true;
        }
        return isArchiveContainer(declared, detectedType);
    }

    private static boolean isArchiveContainer(AttachmentContentType declared, AttachmentContentType detected) {
        if (!"application/zip".equals(detected.value())) {
            return false;
        }
        String application = declared.value();
        return application.startsWith("application/vnd.")
                || "application/x-zip-compressed".equals(application);
    }

    /** @return the problems that make the payload inconsistent; empty when it matches. */
    public List<ServiceProblem> evaluate(AttachmentMetadata metadata, AttachmentContent content) {
        List<ServiceProblem> problems = new ArrayList<>();
        if (metadata == null) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment metadata is required"));
            return List.copyOf(problems);
        }
        if (!matches(metadata, content)) {
            String detected = detect(content);
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                    "content signature '" + detected + "' does not match declared type '"
                            + metadata.declaredContentType().value() + "'",
                    metadata.attachmentId()));
        }
        return List.copyOf(problems);
    }

    private static boolean startsWith(byte[] data, int... expected) {
        if (data.length < expected.length) {
            return false;
        }
        for (int i = 0; i < expected.length; i++) {
            if ((data[i] & 0xFF) != (expected[i] & 0xFF)) {
                return false;
            }
        }
        return true;
    }

    private static boolean isRiffWebp(byte[] head) {
        if (head.length < 12) {
            return false;
        }
        return asciiEquals(head, 0, "RIFF") && asciiEquals(head, 8, "WEBP");
    }

    private static boolean asciiEquals(byte[] data, int offset, String token) {
        if (data.length < offset + token.length()) {
            return false;
        }
        for (int i = 0; i < token.length(); i++) {
            if ((data[offset + i] & 0xFF) != token.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    private static boolean isUtf8Bom(byte[] head) {
        return startsWith(head, (byte) 0xEF, (byte) 0xBB, (byte) 0xBF);
    }

    private static boolean looksLikeText(byte[] head) {
        boolean sawPrintable = false;
        for (byte b : head) {
            int value = b & 0xFF;
            if (value == 0) {
                return false;
            }
            if (value >= 0x09 && value <= 0x0D || value >= 0x20) {
                sawPrintable = true;
            } else {
                return false;
            }
        }
        return sawPrintable;
    }

    /** Renders the detected signature of {@code content} for diagnostics. */
    public String describe(AttachmentContent content) {
        String detected = detect(content);
        return detected == null ? "unknown" : detected;
    }

    /**
     * Compatibility seam.
     *
     * @param input an {@link AttachmentIntakeCommand}, an {@code AttachmentMetadata[]} pair, or a
     *              raw {@link AttachmentContent}; only the command form can compare a declaration
     *              with its payload
     * @return the {@link ServiceProblem} list, or an empty list when the input cannot be evaluated
     */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return evaluate(command.attachment(), command.content());
        }
        if (input instanceof AttachmentMetadata metadata) {
            return evaluate(metadata, null);
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand");
    }
}
