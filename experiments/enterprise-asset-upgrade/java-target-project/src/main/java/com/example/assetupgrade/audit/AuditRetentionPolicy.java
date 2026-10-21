package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Tenant-scoped retention eligibility for audit entries.
 *
 * <p>An entry is eligible for purge once its {@code occurredAt} instant is older than the
 * configured retention window measured from the injected {@link TimeProvider}. Eligibility
 * is always evaluated per tenant: an entry belonging to a different tenant is never
 * considered eligible for or retained by the caller's tenant scope, and this policy never
 * mutates an entry.</p>
 */
public final class AuditRetentionPolicy {

    /** Default retention window of one year. */
    public static final Duration DEFAULT_RETENTION = Duration.ofDays(365);

    private final TimeProvider clock;
    private final Duration retention;

    public AuditRetentionPolicy() {
        this(TimeProvider.system(), DEFAULT_RETENTION);
    }

    public AuditRetentionPolicy(Duration retention) {
        this(TimeProvider.system(), retention);
    }

    public AuditRetentionPolicy(TimeProvider clock, Duration retention) {
        this.clock = clock == null ? TimeProvider.system() : clock;
        Duration window = retention == null ? DEFAULT_RETENTION : retention;
        if (window.isZero() || window.isNegative()) {
            throw new IllegalArgumentException("retention window must be positive");
        }
        this.retention = window;
    }

    /** @return the configured retention window. */
    public Duration retention() {
        return retention;
    }

    /** @return the instant before which entries are eligible for purge. */
    public Instant cutoff() {
        return clock.now().minus(retention);
    }

    /** @return {@code true} when {@code entry} is older than the retention window. */
    public boolean isEligibleForPurge(AuditEntry entry) {
        Objects.requireNonNull(entry, "entry");
        return entry.occurredAt().isBefore(cutoff());
    }

    /** Alias of {@link #isEligibleForPurge(AuditEntry)}. */
    public boolean isExpired(AuditEntry entry) {
        return isEligibleForPurge(entry);
    }

    /** @return {@code true} when {@code entry} is still within the retention window. */
    public boolean isRetained(AuditEntry entry) {
        return !isEligibleForPurge(entry);
    }

    /** @return {@code true} when the entry belongs to {@code tenantId} and is eligible for purge. */
    public boolean isEligible(TenantId tenantId, AuditEntry entry) {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(entry, "entry");
        return tenantId.equals(entry.tenantId()) && isEligibleForPurge(entry);
    }

    /** @return {@code true} when {@code occurredAt} is older than the retention window. */
    public boolean isEligible(TenantId tenantId, Instant occurredAt) {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(occurredAt, "occurredAt");
        return occurredAt.isBefore(cutoff());
    }

    /** Filters {@code entries} to those of {@code tenantId} eligible for purge. */
    public List<AuditEntry> eligibleForPurge(TenantId tenantId, List<AuditEntry> entries) {
        Objects.requireNonNull(tenantId, "tenantId");
        List<AuditEntry> eligible = new ArrayList<>();
        if (entries != null) {
            for (AuditEntry entry : entries) {
                if (entry != null && isEligible(tenantId, entry)) {
                    eligible.add(entry);
                }
            }
        }
        return List.copyOf(eligible);
    }

    /** Filters {@code entries} to those of {@code tenantId} still within retention. */
    public List<AuditEntry> retained(TenantId tenantId, List<AuditEntry> entries) {
        Objects.requireNonNull(tenantId, "tenantId");
        List<AuditEntry> retained = new ArrayList<>();
        if (entries != null) {
            for (AuditEntry entry : entries) {
                if (entry != null && tenantId.equals(entry.tenantId()) && isRetained(entry)) {
                    retained.add(entry);
                }
            }
        }
        return List.copyOf(retained);
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #isEligibleForPurge(AuditEntry)}. */
    public Object execute(Object input) {
        if (input instanceof AuditEntry entry) {
            return isEligibleForPurge(entry);
        }
        throw new IllegalArgumentException("expected an AuditEntry but got "
                + (input == null ? "null" : input.getClass().getName()));
    }
}
