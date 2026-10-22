package com.example.assetupgrade.security;

import com.example.assetupgrade.common.TimeProvider;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Tenant-scoped permission policy and the canonical {@link AccessPolicy} implementation.
 *
 * <p>Effective permissions are resolved cache-first through {@link PermissionCachePort},
 * falling back to the {@link RoleMappingPort} role to permission mapping. The policy is a
 * pure function: it never mutates its inputs and performs no side effects beyond
 * populating the cache. A denial is returned as data through {@link AuthorizationDecision}.</p>
 */
public final class PermissionPolicy implements AccessPolicy {

    private final RoleMappingPort roleMapping;
    private final PermissionCachePort cache;
    private final TimeProvider clock;

    public PermissionPolicy(RoleMappingPort roleMapping, PermissionCachePort cache, TimeProvider clock) {
        this.roleMapping = roleMapping;
        this.cache = cache;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    public PermissionPolicy() {
        this(null, null, null);
    }

    @Override
    public AuthorizationDecision evaluate(TenantScope scope, String resourceType, String resourceId, Permission permission) {
        if (scope == null) {
            return AuthorizationDecision.deny("tenant scope is required", Set.of());
        }
        if (scope.isExpired(clock.now())) {
            return AuthorizationDecision.deny("tenant scope has expired", scope.permissions());
        }
        if (permission == null) {
            return AuthorizationDecision.deny("permission is required", scope.permissions());
        }
        if (resourceType == null || resourceType.isBlank()) {
            return AuthorizationDecision.deny("resource type must not be blank", scope.permissions());
        }

        Set<Permission> effective = resolveEffectivePermissions(scope);
        if (effective.contains(permission)) {
            return AuthorizationDecision.allow(effective);
        }
        return AuthorizationDecision.deny("permission " + permission + " is not granted", effective);
    }

    private Set<Permission> resolveEffectivePermissions(TenantScope scope) {
        Set<Permission> effective = new LinkedHashSet<>(scope.permissions());

        boolean cacheHit = false;
        if (cache != null) {
            Set<Permission> cached = cache.permissions(scope.tenantId(), scope.actorId());
            if (cached != null && !cached.isEmpty()) {
                effective.addAll(cached);
                cacheHit = true;
            }
        }

        if (!cacheHit && roleMapping != null) {
            Set<String> roles = scope.roles();
            if (roles == null || roles.isEmpty()) {
                Set<String> resolvedRoles = roleMapping.rolesFor(scope.tenantId(), scope.actorId());
                roles = resolvedRoles == null ? Set.of() : resolvedRoles;
            }
            Set<Permission> mapped = roleMapping.permissionsFor(scope.tenantId(), roles);
            if (mapped != null && !mapped.isEmpty()) {
                effective.addAll(mapped);
                if (cache != null) {
                    cache.put(scope.tenantId(), scope.actorId(), Set.copyOf(effective));
                }
            }
        }

        return Set.copyOf(effective);
    }

    /** Compatibility seam for early implementations; {@link #evaluate} is preferred. */
    public Object execute(Object input) {
        if (input instanceof EvaluateRequest request) {
            return evaluate(request.scope(), request.resourceType(), request.resourceId(), request.permission());
        }
        throw new IllegalArgumentException("Expected PermissionPolicy.EvaluateRequest");
    }

    /** Explicit argument bundle accepted by {@link #execute(Object)}. */
    public record EvaluateRequest(TenantScope scope, String resourceType, String resourceId, Permission permission) {}
}
