package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.TenantId;

import java.util.Set;

/**
 * Tenant-scoped mapping between an actor, that actor's roles, and the permissions the
 * roles grant.
 *
 * <p>Adapted from nopCommerce's customer-role to permission-record mapping. Implementations
 * must be null-safe: an unknown tenant/actor or unknown role yields an empty set rather
 * than an exception.</p>
 */
public interface RoleMappingPort {

    /** @return the roles held by the actor within the tenant, or an empty set when unknown. */
    Set<String> rolesFor(TenantId tenantId, ActorId actorId);

    /** @return the permissions granted to the supplied roles, or an empty set when unknown. */
    Set<Permission> permissionsFor(TenantId tenantId, Set<String> roles);
}
