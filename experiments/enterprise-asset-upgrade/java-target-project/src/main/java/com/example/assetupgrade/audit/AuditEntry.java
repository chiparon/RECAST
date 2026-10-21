package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable, tenant-scoped audit record capturing one business event.
 *
 * <p>The record components {@code tenantId, subjectId, action, status, correlationId,
 * occurredAt, details} are the public contract; attachment, order, workflow,
 * reconciliation, security and reconciliation-audit adapters bind directly to the
 * constructor and accessors. The canonical constructor rejects a missing tenant, action,
 * status or timestamp, normalises a blank subject to {@code null}, and defensively copies
 * {@code details} into an immutable map so event identity and the final state survive
 * persistence unchanged.</p>
 */
public record AuditEntry(
        TenantId tenantId,
        String subjectId,
        AuditAction action,
        AuditStatus status,
        CorrelationId correlationId,
        Instant occurredAt,
        Map<String, String> details) {

    public AuditEntry {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(status, "status");
        Objects.requireNonNull(occurredAt, "occurredAt");
        subjectId = normalize(subjectId);
        details = details == null ? Map.of() : Map.copyOf(details);
    }

    private static String normalize(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** Creates an entry with the full component set. */
    public static AuditEntry of(TenantId tenantId, String subjectId, AuditAction action, AuditStatus status,
                               CorrelationId correlationId, Instant occurredAt, Map<String, String> details) {
        return new AuditEntry(tenantId, subjectId, action, status, correlationId, occurredAt, details);
    }

    /** @return {@code true} when this entry carries a correlation identity. */
    public boolean hasCorrelation() {
        return correlationId != null;
    }

    /** @return {@code true} when this entry records the supplied status. */
    public boolean hasStatus(AuditStatus expected) {
        return status == expected;
    }

    /** @return {@code true} when this status represents a terminal business outcome. */
    public boolean isFinalState() {
        return switch (status) {
            case COMPLETED, FAILED, REJECTED, QUARANTINED, DUPLICATE, ROLLED_BACK -> true;
            case RECEIVED, ACCEPTED, RETRY_PENDING -> false;
        };
    }

    /** Returns a copy of this entry with the supplied status. */
    public AuditEntry withStatus(AuditStatus newStatus) {
        return new AuditEntry(tenantId, subjectId, action, newStatus, correlationId, occurredAt, details);
    }

    /** Returns a copy of this entry with the supplied details, replacing the previous map. */
    public AuditEntry withDetails(Map<String, String> newDetails) {
        return new AuditEntry(tenantId, subjectId, action, status, correlationId, occurredAt, newDetails);
    }

    /** Returns a copy of this entry bound to the supplied correlation identity. */
    public AuditEntry withCorrelationId(CorrelationId newCorrelationId) {
        return new AuditEntry(tenantId, subjectId, action, status, newCorrelationId, occurredAt, details);
    }
}
