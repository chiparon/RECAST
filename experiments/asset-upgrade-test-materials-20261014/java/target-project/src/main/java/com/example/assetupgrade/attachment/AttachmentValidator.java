package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentValidator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentValidator { java.util.List<com.example.assetupgrade.common.ServiceProblem> validateMetadata(AttachmentMetadata metadata); java.util.List<com.example.assetupgrade.common.ServiceProblem> validateContentSignature(AttachmentMetadata metadata, AttachmentContent content); }
