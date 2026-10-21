package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.OperationContext;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.TenantAccessException;
import com.example.assetupgrade.error.ValidationException;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Resolves an {@link OperationContext} into a validated, tenant-scoped
 * {@link TenantScope}.
 *
 * <p>Malformed identity is rejected with a {@link ValidationException}; a missing,
 * cross-tenant or expired scope is rejected with a {@link TenantAccessException}. The
 * resolved scope is enriched with the actor's effective permissions cache-first through
 * the {@link RoleMappingPort} and {@link PermissionCachePort}. The base scope returned by
 * the {@link IdentityPort} is never mutated or leaked.</p>
 */
public final class TenantScopeResolver {

    private final IdentityPort identity;
    private final RoleMappingPort roleMapping;
    private final PermissionCachePort cache;
    private final TimeProvider clock;

    public TenantScopeResolver(IdentityPort identity, RoleMappingPort roleMapping, PermissionCachePort cache, TimeProvider clock) {
        this.identity = identity;
        this.roleMapping = roleMapping;
        this.cache = cache;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    public TenantScopeResolver() {
        this(null, null, null, null);
    }

    /** Resolves the scope described by {@code context}. */
    public TenantScope resolve(OperationContext context) {
        if (context == null) {
            throw new ValidationException("operation context is required");
        }
        return resolve(context.tenantId(), context.actorId(), context.correlationId());
    }

    /** Resolves and validates a scope for the requested tenant, actor and correlation. */
    public TenantScope resolve(TenantId tenantId, ActorId actorId, CorrelationId correlationId) {
        if (tenantId == null || !tenantId.isPresent()) {
            throw new ValidationException("tenant id is required");
        }
        if (actorId == null || !actorId.isPresent()) {
            throw new ValidationException("actor id is required");
        }
        if (correlationId == null || !correlationId.isPresent()) {
            throw new ValidationException("correlation id is required");
        }
        if (identity == null) {
            throw new IllegalStateException("identity port is not configured");
        }

        TenantScope base = identity.resolveScope(tenantId, actorId, correlationId);
        if (base == null) {
            throw new TenantAccessException("no scope could be resolved for tenant " + tenantId.value());
        }
        if (base.tenantId() == null || !base.tenantId().equals(tenantId)) {
            throw new TenantAccessException("resolved scope does not belong to tenant " + tenantId.value());
        }
        if (base.isExpired(clock.now())) {
            throw new TenantAccessException("resolved scope has expired for tenant " + tenantId.value());
        }

        ActorId resolvedActor = base.actorId() == null ? actorId : base.actorId();
        Set<Permission> effective = enrichPermissions(tenantId, resolvedActor, base);
        return TenantScope.of(base.tenantId(), resolvedActor, base.roles(), effective, base.expiresAt());
    }

    private Set<Permission> enrichPermissions(TenantId tenantId, ActorId actorId, TenantScope base) {
        Set<Permission> effective = new LinkedHashSet<>(base.permissions());

        boolean cacheHit = false;
        if (cache != null) {
            Set<Permission> cached = cache.permissions(tenantId, actorId);
            if (cached != null && !cached.isEmpty()) {
                effective.addAll(cached);
                cacheHit = true;
            }
        }

        if (!cacheHit && roleMapping != null) {
            Set<String> roles = base.roles();
            if (roles == null || roles.isEmpty()) {
                Set<String> resolvedRoles = roleMapping.rolesFor(tenantId, actorId);
                roles = resolvedRoles == null ? Set.of() : resolvedRoles;
            }
            Set<Permission> mapped = roleMapping.permissionsFor(tenantId, roles);
            if (mapped != null && !mapped.isEmpty()) {
                effective.addAll(mapped);
            }
            if (cache != null) {
                cache.put(tenantId, actorId, Set.copyOf(effective));
            }
        }

        return Set.copyOf(effective);
    }

    /** Compatibility seam for early implementations; {@link #resolve} is preferred. */
    public Object execute(Object input) {
        if (input instanceof OperationContext context) {
            return resolve(context);
        }
        throw new IllegalArgumentException("Expected OperationContext");
    }
}
