package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tenant-scoped audit append boundary.
 *
 * <p>Delegates persistence to an injected {@link AuditPort} sink while enforcing two
 * invariants: an entry must carry a tenant, and a repeated identical entry - keyed by
 * {@code (tenantId, correlationId, action, occurredAt)} - is written at most once so a
 * retried or duplicated command emits a single audit record. The entry's correlation
 * identity and final {@link AuditStatus} are never rewritten.</p>
 */
public final class AuditWriter implements AuditPort {

    private final AuditPort sink;
    private final Set<EntryKey> written = ConcurrentHashMap.newKeySet();

    public AuditWriter() {
        this(null);
    }

    public AuditWriter(AuditPort sink) {
        this.sink = sink;
    }

    @Override
    public void append(AuditEntry entry) {
        Objects.requireNonNull(entry, "entry");
        if (entry.tenantId() == null) {
            throw new IllegalArgumentException("audit entry tenantId is required");
        }
        EntryKey key = new EntryKey(entry.tenantId(), entry.correlationId(), entry.action(), entry.occurredAt());
        if (!written.add(key)) {
            return;
        }
        try {
            if (sink != null) {
                sink.append(entry);
            }
        } catch (RuntimeException ex) {
            written.remove(key);
            throw ex;
        }
    }

    /** Alias of {@link #append(AuditEntry)}. */
    public void write(AuditEntry entry) {
        append(entry);
    }

    /** Appends {@code entry} and returns it, for fluent call sites. */
    public AuditEntry record(AuditEntry entry) {
        append(entry);
        return entry;
    }

    /** @return {@code true} when an equivalent entry has already been written. */
    public boolean isWritten(AuditEntry entry) {
        return entry != null && written.contains(
                new EntryKey(entry.tenantId(), entry.correlationId(), entry.action(), entry.occurredAt()));
    }

    /** Clears the duplicate-detection memory. */
    public void reset() {
        written.clear();
    }

    @Override
    public List<AuditEntry> query(AuditQuery query) {
        Objects.requireNonNull(query, "query");
        return sink == null ? List.of() : sink.query(query);
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #append(AuditEntry)}. */
    public Object execute(Object input) {
        if (input instanceof AuditEntry entry) {
            append(entry);
            return entry;
        }
        if (input instanceof AuditQuery query) {
            return query(query);
        }
        throw new IllegalArgumentException("expected an AuditEntry or AuditQuery but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Duplicate-detection key preserving tenant, correlation, action and occurrence identity. */
    private record EntryKey(TenantId tenantId, CorrelationId correlationId, AuditAction action, Instant occurredAt) {
    }
}
