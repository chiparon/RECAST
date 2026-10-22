package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentIntakeService.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentIntakeService { AttachmentIntakeResult intake(AttachmentIntakeCommand command); AttachmentIntakeResult release(com.example.assetupgrade.common.TenantId tenantId, com.example.assetupgrade.common.ActorId actorId, String attachmentId, com.example.assetupgrade.common.CorrelationId correlationId); }
