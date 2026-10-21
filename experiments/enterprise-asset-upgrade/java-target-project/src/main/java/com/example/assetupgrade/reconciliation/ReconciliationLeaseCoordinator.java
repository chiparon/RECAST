package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.reconciliation.port.LeasePort;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Tenant-scoped lease coordination for a scheduled reconciliation run.
 *
 * <p>Before scanning the due window the run claims a lease keyed by tenant and job so that only
 * one scheduler instance processes a tenant's records at a time. A failed claim is a skipped run
 * rather than an error; the caller still audits it. When a claim's lease has expired the run was
 * interrupted and is repairable: the coordinator can reap the abandoned claim so the next run is
 * rerunnable, mirroring the datastore's acquired-until comparison and abandoned-job reaping.</p>
 */
public final class ReconciliationLeaseCoordinator {

    /** Default lease duration when the caller does not supply one. */
    public static final Duration DEFAULT_LEASE_DURATION = Duration.ofMinutes(5);

    private final LeasePort leases;
    private final TimeProvider clock;
    private final Duration leaseDuration;

    /** Creates an unconfigured coordinator; claims fail closed. */
    public ReconciliationLeaseCoordinator() {
        this(null, null, null);
    }

    /** Creates a coordinator claiming leases through {@code leases}. */
    public ReconciliationLeaseCoordinator(LeasePort leases) {
        this(leases, null, null);
    }

    /** Creates a coordinator with an explicit clock and lease duration. */
    public ReconciliationLeaseCoordinator(LeasePort leases, TimeProvider clock, Duration leaseDuration) {
        this.leases = leases;
        this.clock = clock == null ? TimeProvider.system() : clock;
        Duration duration = leaseDuration == null ? DEFAULT_LEASE_DURATION : leaseDuration;
        if (duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException("lease duration must be positive");
        }
        this.leaseDuration = duration;
    }

    /**
     * Attempts to claim the tenant/job lease.
     *
     * @return the claim when acquired, otherwise {@link Optional#empty()} so the run is skipped
     */
    public Optional<LeaseClaim> acquire(TenantId tenantId, String key) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (leases == null) {
            return Optional.empty();
        }
        try {
            Optional<LeaseClaim> claim = leases.tryClaim(tenantId, key, leaseDuration);
            return claim == null ? Optional.empty() : claim;
        } catch (RuntimeException denied) {
            return Optional.empty();
        }
    }

    /** Alias of {@link #acquire(TenantId, String)}. */
    public Optional<LeaseClaim> claim(TenantId tenantId, String key) {
        return acquire(tenantId, key);
    }

    /** Releases a held claim; a release failure never changes the run outcome. */
    public boolean release(LeaseClaim claim) {
        if (leases == null || claim == null) {
            return false;
        }
        try {
            leases.release(claim);
            return true;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    /** @return {@code true} when {@code claim} holds no live lease at {@code now}. */
    public boolean isExpired(LeaseClaim claim, Instant now) {
        if (claim == null || claim.expiresAt() == null || now == null) {
            return false;
        }
        return !now.isBefore(claim.expiresAt());
    }

    /** @return {@code true} when {@code claim}'s lease has expired at the coordinator clock. */
    public boolean isExpired(LeaseClaim claim) {
        return isExpired(claim, clock.now());
    }

    /** @return {@code true} when {@code claim} still holds a live lease at {@code now}. */
    public boolean isActive(LeaseClaim claim, Instant now) {
        return claim != null && !isExpired(claim, now);
    }

    /** Releases an expired claim so an interrupted run becomes rerunnable. */
    public boolean reapIfExpired(LeaseClaim claim) {
        if (!isExpired(claim)) {
            return false;
        }
        return release(claim);
    }

    /** @return the configured lease duration. */
    public Duration leaseDuration() {
        return leaseDuration;
    }

    /** @return the time source used to evaluate lease expiry. */
    public TimeProvider clock() {
        return clock;
    }

    /** @return the backing lease port, or {@code null} when none is configured. */
    public LeasePort port() {
        return leases;
    }

    /** Compatibility seam; releases a claim or claims the default job for a tenant. */
    public Object execute(Object input) {
        if (input instanceof LeaseClaim claim) {
            return release(claim);
        }
        if (input instanceof TenantId tenantId) {
            return acquire(tenantId, ReconciliationTenantFilter.DEFAULT_JOB);
        }
        throw new IllegalArgumentException("Expected a LeaseClaim or TenantId");
    }
}
