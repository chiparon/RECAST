package com.example.assetupgrade.adapters;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.security.IdentityPort;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.PermissionCachePort;
import com.example.assetupgrade.security.RoleMappingPort;
import com.example.assetupgrade.security.TenantScope;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keycloak-shaped identity adapter implementing {@link IdentityPort}, {@link RoleMappingPort} and
 * {@link PermissionCachePort}.
 *
 * <p>Realm role mappings and role-to-permission grants are held per tenant so that a mapping
 * registered for one tenant is never visible to another. {@link #resolveScope(TenantId, ActorId,
 * CorrelationId)} returns an honest, tenant-scoped {@link TenantScope}: when no identity provider
 * data has been registered for the tenant/actor the scope carries no roles and no permissions rather
 * than fabricating a grant. Every lookup is null-safe and returns an empty set for unknown
 * principals.</p>
 *
 * <p>Provider behaviour (real Keycloak calls) is intentionally absent: this adapter is the local,
 * deterministic fallback used when no identity service is configured.</p>
 */
public final class KeycloakIdentityAdapter implements IdentityPort, RoleMappingPort, PermissionCachePort {

    private final Map<String, Map<String, Set<String>>> rolesByTenant = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Set<Permission>>> permissionsByTenantRole = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Set<Permission>>> directGrants = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Set<Permission>>> cache = new ConcurrentHashMap<>();
    private volatile boolean connected;

    /** Marks the identity provider reachable so health checks can report it up. */
    public KeycloakIdentityAdapter connect() {
        this.connected = true;
        return this;
    }

    /** Marks the identity provider unreachable. */
    public KeycloakIdentityAdapter disconnect() {
        this.connected = false;
        return this;
    }

    /** @return {@code true} when an identity provider session is established. */
    public boolean isConnected() {
        return connected;
    }

    /** @return {@code true} when the identity provider is reachable. */
    public boolean probe() {
        return connected;
    }

    /** Creates an empty adapter that grants nothing until mappings are registered. */
    public KeycloakIdentityAdapter() {
    }

    /** Registers the roles held by {@code actorId} within {@code tenantId}. */
    public void registerActor(TenantId tenantId, ActorId actorId, Set<String> roles) {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(actorId, "actorId");
        if (roles == null || roles.isEmpty()) {
            tenantMap(rolesByTenant, tenantId).remove(actorId.value());
        } else {
            tenantMap(rolesByTenant, tenantId).put(actorId.value(), immutableStrings(roles));
        }
        invalidate(tenantId, actorId);
    }

    /** Registers the permissions granted to {@code role} within {@code tenantId}. */
    public void registerRole(TenantId tenantId, String role, Set<Permission> permissions) {
        Objects.requireNonNull(tenantId, "tenantId");
        String key = requireRole(role);
        if (permissions == null || permissions.isEmpty()) {
            tenantMap(permissionsByTenantRole, tenantId).remove(key);
        } else {
            tenantMap(permissionsByTenantRole, tenantId).put(key, immutablePermissions(permissions));
        }
    }

    /** Grants {@code permissions} directly to {@code actorId} within {@code tenantId}. */
    public void grant(TenantId tenantId, ActorId actorId, Set<Permission> permissions) {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(actorId, "actorId");
        if (permissions == null || permissions.isEmpty()) {
            tenantMap(directGrants, tenantId).remove(actorId.value());
        } else {
            tenantMap(directGrants, tenantId).put(actorId.value(), immutablePermissions(permissions));
        }
        invalidate(tenantId, actorId);
    }

    @Override
    public TenantScope resolveScope(TenantId tenantId, ActorId actorId, CorrelationId correlationId) {
        Set<String> roles = rolesFor(tenantId, actorId);
        Set<Permission> effective = resolvePermissions(tenantId, actorId, roles);
        return TenantScope.of(tenantId, actorId, roles, effective, (Instant) null);
    }

    @Override
    public Set<String> rolesFor(TenantId tenantId, ActorId actorId) {
        if (tenantId == null || actorId == null) {
            return Set.of();
        }
        Map<String, Set<String>> perTenant = rolesByTenant.get(tenantId.value());
        if (perTenant == null) {
            return Set.of();
        }
        Set<String> roles = perTenant.get(actorId.value());
        return roles == null ? Set.of() : roles;
    }

    @Override
    public Set<Permission> permissionsFor(TenantId tenantId, Set<String> roles) {
        if (tenantId == null || roles == null || roles.isEmpty()) {
            return Set.of();
        }
        Map<String, Set<Permission>> perTenant = permissionsByTenantRole.get(tenantId.value());
        if (perTenant == null) {
            return Set.of();
        }
        Set<Permission> resolved = new LinkedHashSet<>();
        for (String role : roles) {
            if (role == null) {
                continue;
            }
            Set<Permission> granted = perTenant.get(role.trim());
            if (granted != null) {
                resolved.addAll(granted);
            }
        }
        return Collections.unmodifiableSet(resolved);
    }

    @Override
    public Set<Permission> permissions(TenantId tenantId, ActorId actorId) {
        if (tenantId == null || actorId == null) {
            return Set.of();
        }
        Map<String, Set<Permission>> perTenant = cache.get(tenantId.value());
        if (perTenant != null) {
            Set<Permission> cached = perTenant.get(actorId.value());
            if (cached != null) {
                return cached;
            }
        }
        Set<String> roles = rolesFor(tenantId, actorId);
        Set<Permission> resolved = resolvePermissions(tenantId, actorId, roles);
        tenantMap(cache, tenantId).put(actorId.value(), resolved);
        return resolved;
    }

    @Override
    public void put(TenantId tenantId, ActorId actorId, Set<Permission> permissions) {
        if (tenantId == null || actorId == null) {
            return;
        }
        Set<Permission> effective = permissions == null ? Set.of() : immutablePermissions(permissions);
        tenantMap(cache, tenantId).put(actorId.value(), effective);
        tenantMap(directGrants, tenantId).put(actorId.value(), effective);
    }

    @Override
    public void invalidate(TenantId tenantId, ActorId actorId) {
        if (tenantId == null || actorId == null) {
            return;
        }
        Map<String, Set<Permission>> perTenant = cache.get(tenantId.value());
        if (perTenant != null) {
            perTenant.remove(actorId.value());
        }
    }

    @Override
    public void invalidateTenant(TenantId tenantId) {
        if (tenantId == null) {
            return;
        }
        cache.remove(tenantId.value());
    }

    private Set<Permission> resolvePermissions(TenantId tenantId, ActorId actorId, Set<String> roles) {
        Set<Permission> resolved = new LinkedHashSet<>(permissionsFor(tenantId, roles));
        if (tenantId != null && actorId != null) {
            Map<String, Set<Permission>> perTenant = directGrants.get(tenantId.value());
            if (perTenant != null) {
                Set<Permission> direct = perTenant.get(actorId.value());
                if (direct != null) {
                    resolved.addAll(direct);
                }
            }
        }
        return Collections.unmodifiableSet(resolved);
    }

    private static String requireRole(String role) {
        Objects.requireNonNull(role, "role");
        String trimmed = role.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("role must not be blank");
        }
        return trimmed;
    }

    private static Set<String> immutableStrings(Set<String> source) {
        Set<String> copy = new LinkedHashSet<>();
        for (String value : source) {
            if (value != null && !value.isBlank()) {
                copy.add(value.trim());
            }
        }
        return Collections.unmodifiableSet(copy);
    }

    private static Set<Permission> immutablePermissions(Set<Permission> source) {
        Set<Permission> copy = new LinkedHashSet<>();
        for (Permission permission : source) {
            if (permission != null) {
                copy.add(permission);
            }
        }
        return Collections.unmodifiableSet(copy);
    }

    private static <K, V> Map<K, V> tenantMap(Map<String, Map<K, V>> holder, TenantId tenantId) {
        return holder.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    /** Compatibility seam for generic {@code invoke(Object)} callers. */
    public Object invoke(Object input) {
        if (input instanceof TenantScopeRequest request) {
            return resolveScope(request.tenantId(), request.actorId(), request.correlationId());
        }
        throw new IllegalArgumentException("expected a TenantScopeRequest");
    }

    /** Holder accepted by the compatibility {@link #invoke(Object)} seam. */
    public record TenantScopeRequest(TenantId tenantId, ActorId actorId, CorrelationId correlationId) {
    }
}
