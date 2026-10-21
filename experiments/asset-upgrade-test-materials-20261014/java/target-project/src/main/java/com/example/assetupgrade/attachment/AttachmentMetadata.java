package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentMetadata.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AttachmentMetadata(String attachmentId, com.example.assetupgrade.common.TenantId tenantId, String fileName, AttachmentContentType declaredContentType, long contentLength, String contentHash, AttachmentState state, boolean scanned, java.time.Instant receivedAt) {}
