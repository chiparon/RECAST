package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Normalises and screens attachment file names.
 *
 * <p>The policy removes directory components and traversal segments, strips control
 * characters, enforces a maximum length and, when configured, restricts the file
 * extension. {@link #normalize(String)} produces the storage-safe name while
 * {@link #evaluate(String)} reports the problems that must quarantine a name. Screening is
 * performed on the raw caller-supplied name before normalisation so that a traversal
 * attempt is reported rather than silently repaired.</p>
 */
public final class FilenameSafetyPolicy {

    /** Default maximum accepted file-name length. */
    public static final int DEFAULT_MAX_LENGTH = 255;

    private static final Set<String> RESERVED_NAMES = Set.of(
            "con", "prn", "aux", "nul",
            "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
            "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9");

    private final int maxLength;
    private final Set<String> allowedExtensions;

    /** Creates a policy with the default length limit that accepts any extension. */
    public FilenameSafetyPolicy() {
        this(DEFAULT_MAX_LENGTH, Set.of());
    }

    /** Creates a policy with an explicit length limit that accepts any extension. */
    public FilenameSafetyPolicy(int maxLength) {
        this(maxLength, Set.of());
    }

    /**
     * Creates a policy.
     *
     * @param maxLength         the maximum accepted name length; a non-positive value falls back to
     *                          {@link #DEFAULT_MAX_LENGTH}
     * @param allowedExtensions an optional allow-list of lower-case extensions without the dot; an
     *                          empty set accepts every extension
     */
    public FilenameSafetyPolicy(int maxLength, Set<String> allowedExtensions) {
        this.maxLength = maxLength > 0 ? maxLength : DEFAULT_MAX_LENGTH;
        this.allowedExtensions = normalizeExtensions(allowedExtensions);
    }

    private static Set<String> normalizeExtensions(Set<String> extensions) {
        if (extensions == null || extensions.isEmpty()) {
            return Set.of();
        }
        Set<String> normalized = new LinkedHashSet<>();
        for (String extension : extensions) {
            if (extension == null) {
                continue;
            }
            String trimmed = extension.trim().toLowerCase(Locale.ROOT);
            if (trimmed.startsWith(".")) {
                trimmed = trimmed.substring(1);
            }
            if (!trimmed.isEmpty()) {
                normalized.add(trimmed);
            }
        }
        return Set.copyOf(normalized);
    }

    /** @return the configured maximum name length. */
    public int maxLength() {
        return maxLength;
    }

    /** @return the configured extension allow-list, empty when every extension is accepted. */
    public Set<String> allowedExtensions() {
        return allowedExtensions;
    }

    /**
     * Produces a storage-safe rendering of {@code rawFileName}: the last path segment,
     * without control characters or traversal segments, truncated to the configured length.
     *
     * @return the normalised name; an empty string when nothing usable remains
     */
    public String normalize(String rawFileName) {
        if (rawFileName == null) {
            return "";
        }
        String candidate = rawFileName.replace('\\', '/').trim();
        int lastSlash = candidate.lastIndexOf('/');
        if (lastSlash >= 0) {
            candidate = candidate.substring(lastSlash + 1);
        }
        StringBuilder cleaned = new StringBuilder(candidate.length());
        for (int i = 0; i < candidate.length(); i++) {
            char c = candidate.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                continue;
            }
            cleaned.append(c);
        }
        String result = cleaned.toString().trim();
        if (result.equals(".") || result.equals("..")) {
            return "";
        }
        while (result.startsWith(".")) {
            result = result.substring(1);
        }
        if (result.contains("..")) {
            result = result.replace("..", "").trim();
        }
        if (result.length() > maxLength) {
            result = truncate(result, maxLength);
        }
        return result;
    }

    private static String truncate(String value, int limit) {
        int dot = value.lastIndexOf('.');
        if (dot > 0 && value.length() - dot <= 12) {
            String extension = value.substring(dot);
            int keep = Math.max(1, limit - extension.length());
            return value.substring(0, Math.min(keep, dot)) + extension;
        }
        return value.substring(0, limit);
    }

    /** @return {@code true} when {@code fileName} is a usable, safe name. */
    public boolean isSafe(String fileName) {
        return evaluate(fileName).isEmpty();
    }

    /** @return the problems that make {@code fileName} unsafe; empty when it is acceptable. */
    public List<ServiceProblem> evaluate(String fileName) {
        List<ServiceProblem> problems = new ArrayList<>();
        if (fileName == null || fileName.isBlank()) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name is required"));
            return List.copyOf(problems);
        }
        String trimmed = fileName.trim();
        if (trimmed.length() > maxLength) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                    "file name exceeds the maximum length of " + maxLength));
        }
        if (trimmed.indexOf('\u0000') >= 0) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name contains a NUL byte"));
        }
        if (containsControlCharacters(trimmed)) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name contains control characters"));
        }
        String asPath = trimmed.replace('\\', '/');
        if (asPath.contains("/")) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name must not contain directory components"));
        }
        if (asPath.contains("..")) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name must not contain parent traversal"));
        }
        if (asPath.equals(".") || asPath.equals("..") || asPath.isBlank()) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name is not a usable name"));
        }
        String base = baseName(asPath);
        int dot = base.lastIndexOf('.');
        String stem = dot > 0 ? base.substring(0, dot) : base;
        if (RESERVED_NAMES.contains(stem.toLowerCase(Locale.ROOT))) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "file name is a reserved device name"));
        }
        if (!allowedExtensions.isEmpty()) {
            String extension = dot >= 0 ? base.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
            if (!allowedExtensions.contains(extension)) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "file extension '" + extension + "' is not permitted"));
            }
        }
        return List.copyOf(problems);
    }

    private static String baseName(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }

    private static boolean containsControlCharacters(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                return true;
            }
        }
        return false;
    }

    /**
     * Compatibility seam.
     *
     * @param input a {@link String} file name or an {@link AttachmentMetadata} whose file name is
     *              screened
     * @return the {@link ServiceProblem} list for the supplied name
     */
    public Object execute(Object input) {
        if (input instanceof AttachmentMetadata metadata) {
            return evaluate(metadata.fileName());
        }
        if (input instanceof String name) {
            return evaluate(name);
        }
        if (input == null) {
            return evaluate(null);
        }
        throw new IllegalArgumentException("Expected a file name String or AttachmentMetadata");
    }
}
