package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;

import java.util.ArrayList;
import java.util.List;

/**
 * Application-layer policy seam that evaluates an attachment against every intake rule.
 *
 * <p>Implementations return the complete list of {@link ServiceProblem}s that block intake;
 * an empty list means the attachment is acceptable. The seam is provider-neutral: file-name
 * safety, media-type compatibility, size limits and content signatures are decided here and
 * never leak into adapters.</p>
 */
public interface AttachmentPolicy {

    /**
     * Evaluates {@code metadata} and {@code content}.
     *
     * @param metadata the normalised attachment description
     * @param content  the payload, or {@code null} when only metadata is available
     * @return the blocking problems, empty when the attachment is acceptable
     */
    List<ServiceProblem> evaluate(AttachmentMetadata metadata, AttachmentContent content);

    /** @return the default policy with a 25 MiB limit and the built-in rule set. */
    static AttachmentPolicy defaults() {
        return new Default();
    }

    /** @return a policy with an explicit maximum content length in bytes. */
    static AttachmentPolicy withMaxBytes(long maxBytes) {
        return new Default(maxBytes);
    }

    /**
     * Default application-layer policy combining file-name safety, media-type compatibility,
     * an optional size ceiling and content-signature verification.
     */
    final class Default implements AttachmentPolicy {

        /** Default maximum accepted attachment size: 25 MiB. */
        public static final long DEFAULT_MAX_BYTES = 25L * 1024L * 1024L;

        private final FilenameSafetyPolicy filenames;
        private final MimeCompatibilityPolicy mime;
        private final ContentSignaturePolicy signatures;
        private final long maxBytes;

        /** Creates a policy with the default size ceiling. */
        public Default() {
            this(DEFAULT_MAX_BYTES);
        }

        /** Creates a policy with an explicit size ceiling; a non-positive value disables the limit. */
        public Default(long maxBytes) {
            this(new FilenameSafetyPolicy(), new MimeCompatibilityPolicy(), new ContentSignaturePolicy(), maxBytes);
        }

        /** Creates a fully configured policy. */
        public Default(FilenameSafetyPolicy filenames, MimeCompatibilityPolicy mime,
                       ContentSignaturePolicy signatures, long maxBytes) {
            this.filenames = filenames == null ? new FilenameSafetyPolicy() : filenames;
            this.mime = mime == null ? new MimeCompatibilityPolicy() : mime;
            this.signatures = signatures == null ? new ContentSignaturePolicy() : signatures;
            this.maxBytes = maxBytes;
        }

        /** @return the configured maximum content length in bytes; non-positive when unbounded. */
        public long maxBytes() {
            return maxBytes;
        }

        @Override
        public List<ServiceProblem> evaluate(AttachmentMetadata metadata, AttachmentContent content) {
            List<ServiceProblem> problems = new ArrayList<>();
            if (metadata == null) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment metadata is required"));
                return List.copyOf(problems);
            }
            problems.addAll(filenames.evaluate(metadata.fileName()));
            problems.addAll(mime.evaluate(metadata));
            ServiceProblem sizeProblem = checkSize(metadata, content);
            if (sizeProblem != null) {
                problems.add(sizeProblem);
            }
            if (content != null) {
                problems.addAll(signatures.evaluate(metadata, content));
            }
            return List.copyOf(problems);
        }

        private ServiceProblem checkSize(AttachmentMetadata metadata, AttachmentContent content) {
            if (maxBytes <= 0) {
                return null;
            }
            long declared = metadata.contentLength();
            if (declared > maxBytes) {
                return ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "attachment exceeds the maximum size of " + maxBytes + " bytes", metadata.attachmentId());
            }
            if (declared <= 0 && content != null) {
                long actual = resolveLength(content);
                if (actual > maxBytes) {
                    return ServiceProblem.of(ProblemCode.INVALID_INPUT,
                            "attachment exceeds the maximum size of " + maxBytes + " bytes", metadata.attachmentId());
                }
            }
            return null;
        }

        private static long resolveLength(AttachmentContent content) {
            long declared = content.length();
            if (declared >= 0) {
                return declared;
            }
            try {
                return content.resolveLength();
            } catch (RuntimeException ex) {
                return -1L;
            }
        }
    }
}
