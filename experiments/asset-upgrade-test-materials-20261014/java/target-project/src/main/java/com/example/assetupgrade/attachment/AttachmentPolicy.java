package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentPolicy.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentPolicy { java.util.List<com.example.assetupgrade.common.ServiceProblem> evaluate(AttachmentMetadata metadata, AttachmentContent content); }
