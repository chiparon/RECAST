package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;

import java.util.ArrayList;
import java.util.List;

/**
 * Validation seam used by the intake boundary to screen metadata and content separately.
 *
 * <p>{@link #validateMetadata(AttachmentMetadata)} reports file-name, media-type and size
 * problems; {@link #validateContentSignature(AttachmentMetadata, AttachmentContent)} reports
 * a mismatch between the payload's magic bytes and the declared media type. Implementations
 * must be deterministic and must never mutate the values they are given.</p>
 */
public interface AttachmentValidator {

    /** @return the metadata-level problems; empty when the metadata is acceptable. */
    List<ServiceProblem> validateMetadata(AttachmentMetadata metadata);

    /** @return the content-signature problems; empty when the payload matches or is inconclusive. */
    List<ServiceProblem> validateContentSignature(AttachmentMetadata metadata, AttachmentContent content);

    /** @return the default validator backed by {@link AttachmentPolicy#defaults()}. */
    static AttachmentValidator defaults() {
        return new Default(AttachmentPolicy.defaults(), new FilenameSafetyPolicy(),
                new MimeCompatibilityPolicy(), new ContentSignaturePolicy(), AttachmentPolicy.Default.DEFAULT_MAX_BYTES);
    }

    /** @return a validator that runs {@code policy} for metadata and for the combined evaluation. */
    static AttachmentValidator of(AttachmentPolicy policy) {
        AttachmentPolicy effective = policy == null ? AttachmentPolicy.defaults() : policy;
        return new AttachmentValidator() {
            @Override
            public List<ServiceProblem> validateMetadata(AttachmentMetadata metadata) {
                return effective.evaluate(metadata, null);
            }

            @Override
            public List<ServiceProblem> validateContentSignature(AttachmentMetadata metadata, AttachmentContent content) {
                return effective.evaluate(metadata, content);
            }
        };
    }

    /**
     * Default validator that applies file-name, media-type and size rules when validating
     * metadata and applies the content-signature rule separately.
     */
    final class Default implements AttachmentValidator {

        private final AttachmentPolicy policy;
        private final FilenameSafetyPolicy filenames;
        private final MimeCompatibilityPolicy mime;
        private final ContentSignaturePolicy signatures;
        private final long maxBytes;

        /** Creates a default validator. */
        public Default() {
            this(AttachmentPolicy.defaults(), new FilenameSafetyPolicy(), new MimeCompatibilityPolicy(),
                    new ContentSignaturePolicy(), AttachmentPolicy.Default.DEFAULT_MAX_BYTES);
        }

        /** Creates a validator from its collaborating policies. */
        public Default(AttachmentPolicy policy, FilenameSafetyPolicy filenames, MimeCompatibilityPolicy mime,
                       ContentSignaturePolicy signatures, long maxBytes) {
            this.policy = policy == null ? AttachmentPolicy.defaults() : policy;
            this.filenames = filenames == null ? new FilenameSafetyPolicy() : filenames;
            this.mime = mime == null ? new MimeCompatibilityPolicy() : mime;
            this.signatures = signatures == null ? new ContentSignaturePolicy() : signatures;
            this.maxBytes = maxBytes;
        }

        @Override
        public List<ServiceProblem> validateMetadata(AttachmentMetadata metadata) {
            if (metadata == null) {
                return List.of(ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment metadata is required"));
            }
            List<ServiceProblem> problems = new ArrayList<>(filenames.evaluate(metadata.fileName()));
            problems.addAll(mime.evaluate(metadata));
            if (maxBytes > 0 && metadata.contentLength() > maxBytes) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "attachment exceeds the maximum size of " + maxBytes + " bytes", metadata.attachmentId()));
            }
            return List.copyOf(problems);
        }

        @Override
        public List<ServiceProblem> validateContentSignature(AttachmentMetadata metadata, AttachmentContent content) {
            if (content == null) {
                return List.of();
            }
            if (metadata == null) {
                return List.of(ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment metadata is required"));
            }
            return signatures.evaluate(metadata, content);
        }

        /** @return the underlying composite policy. */
        public AttachmentPolicy policy() {
            return policy;
        }
    }
}
