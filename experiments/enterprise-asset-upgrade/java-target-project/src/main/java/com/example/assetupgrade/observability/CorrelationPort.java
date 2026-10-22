package com.example.assetupgrade.observability;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

/**
 * Resolves the {@link CorrelationId} and {@link TenantId} for the current operation.
 *
 * <p>The single abstract method {@link #resolve(CorrelationId)} accepts an inbound
 * correlation identity and returns the identity to propagate, generating a fresh one when
 * none was supplied. The {@link #tenantId()} hook exposes the tenant that scopes the
 * operation and may return {@code null} when no tenant context is established. Adapters
 * are expected to be best-effort: they must never throw during resolution.</p>
 */
@FunctionalInterface
public interface CorrelationPort {

    /** Resolves the correlation id to propagate, generating one when {@code inbound} is {@code null}. */
    CorrelationId resolve(CorrelationId inbound);

    /** @return the correlation id for the current operation. */
    default CorrelationId correlationId() {
        return resolve(null);
    }

    /** Alias of {@link #correlationId()}. */
    default CorrelationId current() {
        return correlationId();
    }

    /** Alias of {@link #correlationId()} with an explicit Camel-style name. */
    default CorrelationId currentCorrelationId() {
        return correlationId();
    }

    /** @return the tenant scoping the current operation, or {@code null} when unbound. */
    default TenantId tenantId() {
        return null;
    }

    /** @return the tenant scoping the current operation, or {@code null} when unbound. */
    default TenantId currentTenantId() {
        return tenantId();
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #resolve(CorrelationId)}. */
    default Object execute(Object input) {
        if (input instanceof CorrelationId correlation) {
            return resolve(correlation);
        }
        if (input instanceof String raw && !raw.isBlank()) {
            return resolve(CorrelationId.of(raw));
        }
        return correlationId();
    }
}
