package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.OperationContext;
import com.example.assetupgrade.error.TenantAccessException;
import com.example.assetupgrade.error.ValidationException;

/**
 * Safe accessor for the actor and tenant identity carried by an
 * {@link OperationContext}.
 *
 * <p>Absent actor identity is rejected with a {@link ValidationException}. Tenant
 * boundary assertions reject a mismatch with a {@link TenantAccessException}.</p>
 */
public final class ActorContextProvider {

    private final TenantScopeResolver resolver;

    public ActorContextProvider(TenantScopeResolver resolver) {
        this.resolver = resolver;
    }

    public ActorContextProvider() {
        this(null);
    }

    /** @return the actor on {@code context}, never {@code null}. */
    public ActorId requireActor(OperationContext context) {
        if (context == null || context.actorId() == null || !context.actorId().isPresent()) {
            throw new ValidationException("actor id is required on the operation context");
        }
        return context.actorId();
    }

    /** Resolves the tenant scope for {@code context} through the configured resolver. */
    public TenantScope scopeFor(OperationContext context) {
        if (resolver == null) {
            throw new IllegalStateException("tenant scope resolver is not configured");
        }
        return resolver.resolve(context);
    }

    /**
     * Asserts that the resolved scope belongs to the tenant declared by the command.
     *
     * @throws TenantAccessException when the resolved tenant differs from the declared one
     */
    public void assertTenantBoundary(CommandMetadata declared, TenantScope resolved) {
        if (declared == null || resolved == null) {
            throw new ValidationException("declared metadata and resolved scope are required");
        }
        if (resolved.tenantId() == null || !resolved.tenantId().equals(declared.tenantId())) {
            throw new TenantAccessException("resolved tenant does not match the declared tenant boundary");
        }
    }

    /** Compatibility seam for early implementations; {@link #scopeFor} is preferred. */
    public Object execute(Object input) {
        if (input instanceof OperationContext context) {
            return scopeFor(context);
        }
        throw new IllegalArgumentException("Expected OperationContext");
    }
}
