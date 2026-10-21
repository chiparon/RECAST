package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.TenantId;

import java.util.Set;

/**
 * Tenant-scoped cache of the effective permissions resolved for an actor.
 *
 * <p>Adapted from the nopCommerce ACL/permission cache keys
 * {@code Nop.aclrecord.{entityId}-{entityName}} and
 * {@code Nop.permissionrecord.allowed.{systemName}-{roleId}} and their cache-event
 * consumer invalidation. Implementations must be null-safe: an unknown tenant/actor
 * yields an empty set instead of an exception.</p>
 */
public interface PermissionCachePort {

    /** @return the cached permissions for the actor, or an empty set when unknown. */
    Set<Permission> permissions(TenantId tenantId, ActorId actorId);

    /** Stores the resolved permission set for the actor. */
    void put(TenantId tenantId, ActorId actorId, Set<Permission> permissions);

    /** Invalidates the cached permissions of a single actor. */
    void invalidate(TenantId tenantId, ActorId actorId);

    /** Invalidates every cached permission entry for a tenant. */
    void invalidateTenant(TenantId tenantId);
}
