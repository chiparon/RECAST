package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentIntakeCommand.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AttachmentIntakeCommand(com.example.assetupgrade.common.CommandMetadata metadata, AttachmentMetadata attachment, AttachmentContent content) {}
