package com.example.assetupgrade.security;

/**
 * Skeleton seam for TenantAuthorizer.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface TenantAuthorizer { AuthorizationDecision authorize(TenantScope scope, Permission permission, String subjectId); }
