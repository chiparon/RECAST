package com.example.assetupgrade.common;

/**
 * Skeleton seam for CommandMetadata.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record CommandMetadata(TenantId tenantId, ActorId actorId, CorrelationId correlationId, java.time.Instant receivedAt) {}
