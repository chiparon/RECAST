package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.OperationContext;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.TenantAccessException;

import java.time.Instant;

/**
 * Enforces the tenant and permission boundary at each public entry point.
 *
 * <p>This is the canonical {@link TenantAuthorizer} implementation: it evaluates the
 * requested permission through the {@link AccessPolicy}, audits the decision, and throws
 * a {@link TenantAccessException} on denial so that no side effect runs for an
 * unauthorized or cross-tenant call. {@link #guard} additionally rejects a resource that
 * belongs to another tenant before the permission check.</p>
 */
public final class TenantBoundaryFilter implements TenantAuthorizer {

    /** Resource-type token used when authorization is not scoped to a concrete resource. */
    private static final String UNRESOURCED = "*";

    private final TenantScopeResolver resolver;
    private final AccessPolicy accessPolicy;
    private final AuthorizationAuditHandler audit;

    public TenantBoundaryFilter(TenantScopeResolver resolver, AccessPolicy accessPolicy, AuthorizationAuditHandler audit) {
        this.resolver = resolver;
        this.accessPolicy = accessPolicy;
        this.audit = audit;
    }

    public TenantBoundaryFilter() {
        this(null, null, null);
    }

    @Override
    public AuthorizationDecision authorize(TenantScope scope, Permission permission, String subjectId) {
        OperationContext context = contextFor(scope);
        return authorizeWith(context, scope, permission, subjectId, null, null);
    }

    /**
     * Resolves the caller scope, rejects a cross-tenant resource, authorizes the
     * permission and returns the resolved scope when the call is allowed.
     *
     * @throws TenantAccessException when the resource belongs to another tenant or the
     *         permission is denied
     */
    public TenantScope guard(OperationContext context, Permission permission, String resourceType, String resourceId, TenantId resourceTenant) {
        if (resolver == null) {
            throw new IllegalStateException("tenant scope resolver is not configured");
        }
        TenantScope scope = resolver.resolve(context);
        if (resourceTenant != null && !resourceTenant.equals(scope.tenantId())) {
            throw new TenantAccessException("resource belongs to a different tenant");
        }
        String subjectId = scope.actorId() == null ? null : scope.actorId().value();
        AuthorizationDecision decision = authorizeWith(context, scope, permission, subjectId, resourceType, resourceId);
        if (decision.isDenied()) {
            throw new TenantAccessException("access denied: " + decision.reason());
        }
        return scope;
    }

    private AuthorizationDecision authorizeWith(OperationContext context, TenantScope scope, Permission permission,
                                                String subjectId, String resourceType, String resourceId) {
        if (accessPolicy == null) {
            throw new IllegalStateException("access policy is not configured");
        }
        String effectiveResourceType = resourceType == null || resourceType.isBlank() ? UNRESOURCED : resourceType;
        String effectiveResourceId = resourceId != null ? resourceId : subjectId;
        AuthorizationDecision decision = accessPolicy.evaluate(scope, effectiveResourceType, effectiveResourceId, permission);
        if (audit != null && context != null) {
            audit.record(context, permission, decision);
        }
        return decision;
    }

    private static OperationContext contextFor(TenantScope scope) {
        if (scope == null || scope.tenantId() == null || scope.actorId() == null) {
            return null;
        }
        return contextFor(scope.tenantId(), scope.actorId());
    }

    private static OperationContext contextFor(TenantId tenantId, ActorId actorId) {
        CommandMetadata metadata = new CommandMetadata(tenantId, actorId, CorrelationId.generate(), Instant.now());
        return new OperationContext(metadata, "tenant-authorize", null);
    }

    /** Compatibility seam for early implementations; {@link #guard} is preferred. */
    public Object execute(Object input) {
        if (input instanceof BoundaryRequest request) {
            return guard(request.context(), request.permission(), request.resourceType(), request.resourceId(), request.resourceTenant());
        }
        throw new IllegalArgumentException("Expected TenantBoundaryFilter.BoundaryRequest");
    }

    /** Explicit argument bundle accepted by {@link #execute(Object)}. */
    public record BoundaryRequest(OperationContext context, Permission permission, String resourceType, String resourceId, TenantId resourceTenant) {}
}
