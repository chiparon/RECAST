package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
import java.util.Objects;

/**
 * Tenant-scoped audit query.
 *
 * <p>The record components {@code tenantId, subjectId, from, to, limit, cursor} are the
 * public contract bound by audit callers and adapters. The canonical constructor requires
 * the tenant, normalises a blank subject/cursor to {@code null} and rejects an inverted
 * time range. A {@code limit} of {@code 0} (or less) means unbounded; a positive limit caps
 * the page size and {@code cursor} continues a previous page.</p>
 */
public record AuditQuery(
        TenantId tenantId,
        String subjectId,
        Instant from,
        Instant to,
        int limit,
        String cursor) {

    public AuditQuery {
        Objects.requireNonNull(tenantId, "tenantId");
        subjectId = normalize(subjectId);
        cursor = normalize(cursor);
        if (from != null && to != null && from.isAfter(to)) {
            throw new IllegalArgumentException("from must not be after to");
        }
    }

    private static String normalize(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** Creates an unbounded query for the whole tenant. */
    public static AuditQuery forTenant(TenantId tenantId) {
        return new AuditQuery(tenantId, null, null, null, 0, null);
    }

    /** Creates a query for the tenant limited to {@code limit} entries. */
    public static AuditQuery forTenant(TenantId tenantId, int limit) {
        return new AuditQuery(tenantId, null, null, null, limit, null);
    }

    /** Creates a query for a specific subject. */
    public static AuditQuery forSubject(TenantId tenantId, String subjectId, int limit) {
        return new AuditQuery(tenantId, subjectId, null, null, limit, null);
    }

    /** @return {@code true} when a continuation cursor is present. */
    public boolean hasCursor() {
        return cursor != null;
    }

    /** @return {@code true} when the query is bounded by a time range. */
    public boolean isTimeBounded() {
        return from != null || to != null;
    }

    /** @return {@code true} when the query is subject-scoped. */
    public boolean hasSubject() {
        return subjectId != null;
    }

    /** Returns a copy of this query with the supplied page limit. */
    public AuditQuery withLimit(int newLimit) {
        return new AuditQuery(tenantId, subjectId, from, to, newLimit, cursor);
    }

    /** Returns a copy of this query continuing at the supplied cursor. */
    public AuditQuery withCursor(String newCursor) {
        return new AuditQuery(tenantId, subjectId, from, to, limit, newCursor);
    }
}
