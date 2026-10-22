package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Checks that a declared media type is compatible with the attachment's file extension.
 *
 * <p>The policy uses a small, provider-neutral extension-to-media-type table. A name with
 * no extension, or an extension that is not in the table, is treated as compatible so that
 * a legitimate but unusual file is never blocked purely by its name; a well-known extension
 * paired with a mismatched declaration is rejected.</p>
 */
public final class MimeCompatibilityPolicy {

    /** The media type used to represent an untyped declaration. */
    public static final String OCTET_STREAM = AttachmentContentType.OCTET_STREAM;

    private static final Map<String, String> EXTENSION_TYPES = Map.ofEntries(
            Map.entry("png", "image/png"),
            Map.entry("jpg", "image/jpeg"),
            Map.entry("jpeg", "image/jpeg"),
            Map.entry("gif", "image/gif"),
            Map.entry("bmp", "image/bmp"),
            Map.entry("webp", "image/webp"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("pdf", "application/pdf"),
            Map.entry("zip", "application/zip"),
            Map.entry("gz", "application/gzip"),
            Map.entry("json", "application/json"),
            Map.entry("xml", "application/xml"),
            Map.entry("txt", "text/plain"),
            Map.entry("csv", "text/csv"),
            Map.entry("md", "text/markdown"),
            Map.entry("html", "text/html"),
            Map.entry("htm", "text/html"),
            Map.entry("doc", "application/msword"),
            Map.entry("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Map.entry("xls", "application/vnd.ms-excel"),
            Map.entry("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            Map.entry("ppt", "application/vnd.ms-powerpoint"),
            Map.entry("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Map.entry("mp3", "audio/mpeg"),
            Map.entry("mp4", "video/mp4"),
            Map.entry("wav", "audio/wav"));

    /** Creates a compatibility policy backed by the built-in extension table. */
    public MimeCompatibilityPolicy() {
    }

    /** @return the media type expected for {@code extension}, or {@code null} when unknown. */
    public String expectedType(String extension) {
        if (extension == null) {
            return null;
        }
        String key = extension.trim().toLowerCase(Locale.ROOT);
        if (key.startsWith(".")) {
            key = key.substring(1);
        }
        return EXTENSION_TYPES.get(key);
    }

    /**
     * @return {@code true} when the declared media type is compatible with the file name;
     *         a missing declaration, a missing extension or an unknown extension all pass
     */
    public boolean isCompatible(AttachmentMetadata metadata) {
        if (metadata == null) {
            return false;
        }
        AttachmentContentType declared = metadata.declaredContentType();
        if (declared == null || declared.isOctetStream() || declared.isWildcard()) {
            return true;
        }
        String expected = expectedType(metadata.extension());
        if (expected == null) {
            return true;
        }
        return declared.accepts(new AttachmentContentType(expected))
                || new AttachmentContentType(expected).accepts(declared)
                || sameFamily(declared.value(), expected);
    }

    private static boolean sameFamily(String declared, String expected) {
        int declaredSlash = declared.indexOf('/');
        int expectedSlash = expected.indexOf('/');
        if (declaredSlash < 0 || expectedSlash < 0) {
            return false;
        }
        return declared.substring(0, declaredSlash).equals(expected.substring(0, expectedSlash));
    }

    /** @return the problems that make the declaration incompatible; empty when compatible. */
    public List<ServiceProblem> evaluate(AttachmentMetadata metadata) {
        List<ServiceProblem> problems = new ArrayList<>();
        if (metadata == null) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment metadata is required"));
            return List.copyOf(problems);
        }
        if (!isCompatible(metadata)) {
            String expected = expectedType(metadata.extension());
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                    "declared type '" + metadata.declaredContentType().value()
                            + "' is not compatible with extension '" + metadata.extension()
                            + "' (expected '" + expected + "')",
                    metadata.attachmentId()));
        }
        return List.copyOf(problems);
    }

    /**
     * Compatibility seam.
     *
     * @param input an {@link AttachmentMetadata} whose declaration is checked
     * @return the {@link ServiceProblem} list for the supplied metadata
     */
    public Object execute(Object input) {
        if (input instanceof AttachmentMetadata metadata) {
            return evaluate(metadata);
        }
        if (input == null) {
            return evaluate(null);
        }
        throw new IllegalArgumentException("Expected AttachmentMetadata");
    }
}
