package com.example.assetupgrade.security;

/**
 * Skeleton seam for AccessPolicy.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AccessPolicy { AuthorizationDecision evaluate(TenantScope scope, String resourceType, String resourceId, Permission permission); }
