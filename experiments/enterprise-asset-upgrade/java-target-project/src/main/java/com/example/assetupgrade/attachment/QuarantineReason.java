package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Explains why an attachment was placed in (or kept in) quarantine.
 *
 * <p>The constant set and declaration order are part of the public contract and must not
 * change. Each reason maps to the {@link ProblemCode} surfaced to callers.</p>
 */
public enum QuarantineReason {
    TENANT_MISMATCH,
    UNSAFE_NAME,
    SIZE_LIMIT,
    CONTENT_SIGNATURE,
    SCAN_PENDING,
    SCAN_FAILED,
    DUPLICATE_CONTENT,
    STORAGE_ERROR;

    /** @return {@code true} when the reason reflects a client mistake rather than a transient fault. */
    public boolean isInputRelated() {
        switch (this) {
            case TENANT_MISMATCH, UNSAFE_NAME, SIZE_LIMIT, CONTENT_SIGNATURE, DUPLICATE_CONTENT -> {
                return true;
            }
            default -> {
                return false;
            }
        }
    }

    /** @return the problem classification a caller should observe for this reason. */
    public ProblemCode problemCode() {
        return switch (this) {
            case TENANT_MISMATCH -> ProblemCode.TENANT_DENIED;
            case UNSAFE_NAME, SIZE_LIMIT, CONTENT_SIGNATURE, DUPLICATE_CONTENT -> ProblemCode.INVALID_INPUT;
            case SCAN_PENDING, SCAN_FAILED -> ProblemCode.QUARANTINED;
            case STORAGE_ERROR -> ProblemCode.STORAGE_FAILURE;
        };
    }

    /**
     * Maps a set of {@code problems} to the most specific quarantine reason.
     *
     * @return a reason derived from the first matching problem, or {@link #SCAN_PENDING} when
     *         no problem could be classified
     */
    public static QuarantineReason from(Iterable<com.example.assetupgrade.common.ServiceProblem> problems) {
        if (problems != null) {
            for (com.example.assetupgrade.common.ServiceProblem problem : problems) {
                if (problem == null) {
                    continue;
                }
                switch (problem.code()) {
                    case TENANT_DENIED -> {
                        return TENANT_MISMATCH;
                    }
                    case STORAGE_FAILURE -> {
                        return STORAGE_ERROR;
                    }
                    case QUARANTINED -> {
                        return SCAN_FAILED;
                    }
                    case CONFLICT -> {
                        return DUPLICATE_CONTENT;
                    }
                    case INVALID_INPUT -> {
                        return reasonForMessage(problem.message());
                    }
                    default -> {
                        // fall through to the next problem
                    }
                }
            }
        }
        return SCAN_PENDING;
    }

    private static QuarantineReason reasonForMessage(String message) {
        String text = message == null ? "" : message.toLowerCase(java.util.Locale.ROOT);
        if (text.contains("name") || text.contains("filename")) {
            return UNSAFE_NAME;
        }
        if (text.contains("size") || text.contains("large") || text.contains("length") || text.contains("oversiz")) {
            return SIZE_LIMIT;
        }
        if (text.contains("signature") || text.contains("magic") || text.contains("mime") || text.contains("content")) {
            return CONTENT_SIGNATURE;
        }
        return UNSAFE_NAME;
    }
}
