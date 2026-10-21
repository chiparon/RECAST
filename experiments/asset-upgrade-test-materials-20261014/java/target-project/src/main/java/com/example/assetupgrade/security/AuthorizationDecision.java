package com.example.assetupgrade.security;

/**
 * Skeleton seam for AuthorizationDecision.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AuthorizationDecision(boolean allowed, String reason, java.util.Set<Permission> evaluatedPermissions) {}
