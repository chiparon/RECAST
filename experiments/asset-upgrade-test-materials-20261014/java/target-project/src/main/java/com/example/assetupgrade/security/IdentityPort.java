package com.example.assetupgrade.security;

/**
 * Skeleton seam for IdentityPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface IdentityPort { TenantScope resolveScope(com.example.assetupgrade.common.TenantId tenantId, com.example.assetupgrade.common.ActorId actorId, com.example.assetupgrade.common.CorrelationId correlationId); }
