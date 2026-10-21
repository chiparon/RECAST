package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentIntakeResult.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AttachmentIntakeResult(boolean accepted, AttachmentState state, String fingerprint, java.util.List<com.example.assetupgrade.common.ServiceProblem> problems) {}
