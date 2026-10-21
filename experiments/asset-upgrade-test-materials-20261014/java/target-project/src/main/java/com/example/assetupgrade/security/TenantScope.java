package com.example.assetupgrade.security;

/**
 * Skeleton seam for TenantScope.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record TenantScope(com.example.assetupgrade.common.TenantId tenantId, com.example.assetupgrade.common.ActorId actorId, java.util.Set<String> roles, java.util.Set<Permission> permissions, java.time.Instant expiresAt) {}
