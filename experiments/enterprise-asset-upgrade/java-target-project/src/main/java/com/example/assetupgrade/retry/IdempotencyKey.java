package com.example.assetupgrade.retry;

import com.example.assetupgrade.common.TenantId;
import java.util.Objects;

/**
 * Tenant-qualified identity for a logically-once operation.
 *
 * <p>A key is always scoped to a single {@link TenantId}; two tenants never share a key even
 * when the operation and subject are identical. The textual form produced by {@link #asString()}
 * is stable and is the canonical dedup identity used by {@link IdempotencyPort} implementations
 * and adapters.</p>
 *
 * @param tenantId  the owning tenant, never {@code null}
 * @param operation the operation name, never blank
 * @param subjectId the subject the operation targets, {@code null} when not applicable
 */
public record IdempotencyKey(TenantId tenantId, String operation, String subjectId) {

    public IdempotencyKey {
        Objects.requireNonNull(tenantId, "tenantId");
        operation = normalizeOperation(operation);
        subjectId = normalizeSubject(subjectId);
    }

    private static String normalizeOperation(String raw) {
        String trimmed = Objects.requireNonNull(raw, "operation").trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("operation must not be blank");
        }
        return trimmed;
    }

    private static String normalizeSubject(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** Creates a key from its parts, applying the same normalisation as the canonical constructor. */
    public static IdempotencyKey of(TenantId tenantId, String operation, String subjectId) {
        return new IdempotencyKey(tenantId, operation, subjectId);
    }

    /**
     * @return the stable, tenant-qualified textual key of the form
     *         {@code tenantId:operation:subjectId} (an absent subject renders as the empty string).
     */
    public String asString() {
        return tenantId.value() + ':' + operation + ':' + (subjectId == null ? "" : subjectId);
    }

    @Override
    public String toString() {
        return asString();
    }
}
