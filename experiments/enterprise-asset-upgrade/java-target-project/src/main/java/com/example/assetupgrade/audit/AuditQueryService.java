package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ValidationException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * Tenant-scoped audit query boundary.
 *
 * <p>Delegates to an injected {@link AuditPort}, enforcing that every returned entry
 * belongs to {@code query.tenantId()} - entries from any other tenant are dropped even if
 * the underlying port returns them. Results are ordered by occurrence time (then
 * correlation and subject) and paged using {@code limit}/{@code cursor}: a positive limit
 * caps the page size, and a cursor carrying the previous page's last occurrence instant
 * continues after it. A cursor that is a plain integer is treated as an entry offset.</p>
 */
public final class AuditQueryService implements AuditPort {

    private final AuditPort port;

    public AuditQueryService() {
        this(null);
    }

    public AuditQueryService(AuditPort port) {
        this.port = port;
    }

    @Override
    public void append(AuditEntry entry) {
        if (port != null) {
            port.append(entry);
        }
    }

    @Override
    public List<AuditEntry> query(AuditQuery query) {
        Objects.requireNonNull(query, "query");
        TenantId tenantId = query.tenantId();
        if (tenantId == null) {
            throw new ValidationException("audit query tenantId is required");
        }
        List<AuditEntry> raw = port == null ? List.of() : port.query(query);
        return page(query, raw);
    }

    /** Convenience query for the whole tenant. */
    public List<AuditEntry> queryForTenant(TenantId tenantId) {
        return query(AuditQuery.forTenant(tenantId));
    }

    /** Compatible alias of {@link #query(AuditQuery)}. */
    public List<AuditEntry> find(AuditQuery query) {
        return query(query);
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #query(AuditQuery)}. */
    public Object execute(Object input) {
        if (input instanceof AuditQuery query) {
            return query(query);
        }
        if (input instanceof AuditEntry entry) {
            append(entry);
            return entry;
        }
        throw new IllegalArgumentException("expected an AuditQuery or AuditEntry but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    private List<AuditEntry> page(AuditQuery query, List<AuditEntry> raw) {
        List<AuditEntry> scoped = new ArrayList<>();
        for (AuditEntry entry : raw == null ? List.<AuditEntry>of() : raw) {
            if (entry == null || !query.tenantId().equals(entry.tenantId())) {
                continue;
            }
            if (query.subjectId() != null && !query.subjectId().equals(entry.subjectId())) {
                continue;
            }
            if (query.from() != null && entry.occurredAt().isBefore(query.from())) {
                continue;
            }
            if (query.to() != null && entry.occurredAt().isAfter(query.to())) {
                continue;
            }
            scoped.add(entry);
        }
        scoped.sort(Comparator.comparing(AuditEntry::occurredAt)
                .thenComparing(entry -> entry.correlationId() == null ? "" : entry.correlationId().value())
                .thenComparing(entry -> entry.subjectId() == null ? "" : entry.subjectId()));

        Cursor cursor = Cursor.parse(query.cursor());
        List<AuditEntry> result = new ArrayList<>();
        int skipped = 0;
        for (AuditEntry entry : scoped) {
            if (!cursor.accepts(entry, skipped)) {
                skipped++;
                continue;
            }
            result.add(entry);
            if (query.limit() > 0 && result.size() >= query.limit()) {
                break;
            }
        }
        return List.copyOf(result);
    }

    /** Parsed continuation cursor: either an occurrence instant or a plain offset. */
    private record Cursor(Instant after, Integer offset) {

        static Cursor parse(String cursor) {
            if (cursor == null || cursor.isBlank()) {
                return new Cursor(null, null);
            }
            try {
                return new Cursor(Instant.parse(cursor), null);
            } catch (RuntimeException ignored) {
                try {
                    return new Cursor(null, Integer.valueOf(cursor.trim()));
                } catch (RuntimeException alsoIgnored) {
                    return new Cursor(null, null);
                }
            }
        }

        boolean accepts(AuditEntry entry, int index) {
            if (after != null) {
                return entry.occurredAt().isAfter(after);
            }
            if (offset != null) {
                return index >= offset;
            }
            return true;
        }
    }
}
