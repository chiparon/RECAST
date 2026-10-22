package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Immutable, tenant-scoped view of the acting principal.
 *
 * <p>The record components are part of the public contract and must not change. The
 * behavioral helpers added here let callers evaluate permissions and expiry without
 * depending on any provider type.</p>
 */
public record TenantScope(TenantId tenantId, ActorId actorId, Set<String> roles, Set<Permission> permissions, Instant expiresAt) {

    public TenantScope {
        roles = roles == null ? Set.of() : Set.copyOf(roles);
        permissions = permissions == null ? Set.of() : Set.copyOf(permissions);
    }

    /** Creates a scope, defensively copying the role and permission sets. */
    public static TenantScope of(TenantId tenantId, ActorId actorId, Set<String> roles, Set<Permission> permissions, Instant expiresAt) {
        return new TenantScope(tenantId, actorId, roles, permissions, expiresAt);
    }

    /** @return {@code true} when {@code permission} is granted by this scope. */
    public boolean hasPermission(Permission permission) {
        return permission != null && permissions.contains(permission);
    }

    /** @return {@code true} when any of {@code candidates} is granted by this scope. */
    public boolean hasAnyPermission(Set<Permission> candidates) {
        if (candidates == null || candidates.isEmpty()) {
            return false;
        }
        for (Permission candidate : candidates) {
            if (candidate != null && permissions.contains(candidate)) {
                return true;
            }
        }
        return false;
    }

    /** @return {@code true} when this scope belongs to {@code candidate}. */
    public boolean belongsTo(TenantId candidate) {
        return candidate != null && candidate.equals(tenantId);
    }

    /**
     * @return {@code true} when the scope expired at or before {@code now}. A scope with
     *         no expiry never expires; a {@code null} instant is resolved to the current time.
     */
    public boolean isExpired(Instant now) {
        if (expiresAt == null) {
            return false;
        }
        Instant reference = now == null ? Instant.now() : now;
        return !reference.isBefore(expiresAt);
    }

    /** @return {@code true} when the scope is still valid at {@code now}. */
    public boolean isActive(Instant now) {
        return !isExpired(now);
    }

    /** @return a new scope carrying {@code extra} permissions merged into this one. */
    public TenantScope withAdditionalPermissions(Set<Permission> extra) {
        if (extra == null || extra.isEmpty()) {
            return this;
        }
        Set<Permission> merged = new LinkedHashSet<>(permissions);
        merged.addAll(extra);
        return new TenantScope(tenantId, actorId, roles, merged, expiresAt);
    }

    /** @return a new scope with an explicit permission set and the same identity. */
    public TenantScope withPermissions(Set<Permission> effectivePermissions) {
        return new TenantScope(tenantId, actorId, roles, effectivePermissions, expiresAt);
    }
}
