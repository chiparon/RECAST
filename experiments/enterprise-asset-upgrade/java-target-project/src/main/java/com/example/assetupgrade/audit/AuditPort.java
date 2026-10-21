package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.TenantId;

import java.util.List;

/**
 * Append-and-query seam for tenant-scoped audit persistence.
 *
 * <p>{@link #append(AuditEntry)} persists one immutable audit record. {@link #query(AuditQuery)}
 * must return only entries belonging to {@code query.tenantId()} and must never read or
 * mutate another tenant's records. Both operations preserve the entry's correlation
 * identity and final {@link AuditStatus} unchanged.</p>
 */
public interface AuditPort {

    /** Appends a single audit entry. */
    void append(AuditEntry entry);

    /** Returns the tenant-scoped entries matching {@code query}. */
    List<AuditEntry> query(AuditQuery query);

    /** Convenience query for a whole tenant. */
    default List<AuditEntry> queryForTenant(TenantId tenantId) {
        return query(AuditQuery.forTenant(tenantId));
    }
}
