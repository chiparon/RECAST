package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.security.TenantScope;

import java.time.Instant;
import java.util.Objects;
import java.util.Set;

/**
 * Resolves and enforces the tenant scope of a scheduled reconciliation run.
 *
 * <p>Every read or mutation performed by the reconciliation module is keyed by the tenant that
 * owns the command, so a run can never scan, lease, checkpoint, metric or audit against another
 * tenant's records. The filter mirrors the {@code scheduler_id} scoping of the historical
 * datastore where every due-window, lease and checkpoint query carried the owning scope.</p>
 *
 * <p>Validation rejects a missing command, tenant, actor, correlation identity or run instant as
 * a typed {@link ValidationException} rather than a raw failure so the boundary can surface a
 * structured problem.</p>
 */
public final class ReconciliationTenantFilter {

    /** Job name used when a command does not declare one. */
    public static final String DEFAULT_JOB = "reconciliation";
    /** Separator between the tenant and job segments of a scoped key. */
    public static final String SCOPE_SEPARATOR = "::";

    /** Creates a stateless tenant filter. */
    public ReconciliationTenantFilter() {
    }

    /** @return the tenant that owns {@code command}; never {@code null}. */
    public TenantId tenantOf(ReconciliationCommand command) {
        require(command);
        TenantId tenantId = command.metadata().tenantId();
        if (tenantId == null) {
            throw new ValidationException("reconciliation command must carry a tenant identity");
        }
        return tenantId;
    }

    /** @return the actor performing {@code command}; never {@code null}. */
    public ActorId actorOf(ReconciliationCommand command) {
        require(command);
        ActorId actorId = command.metadata().actorId();
        if (actorId == null || !actorId.isPresent()) {
            throw new ValidationException("reconciliation command must carry an actor identity");
        }
        return actorId;
    }

    /** @return the correlation identity propagated across {@code command}; never {@code null}. */
    public CorrelationId correlationOf(ReconciliationCommand command) {
        require(command);
        CorrelationId correlationId = command.metadata().correlationId();
        if (correlationId == null || !correlationId.isPresent()) {
            throw new ValidationException("reconciliation command must carry a correlation identity");
        }
        return correlationId;
    }

    /** @return the effective job name, falling back to {@link #DEFAULT_JOB} when absent. */
    public String jobNameOf(ReconciliationCommand command) {
        if (command == null || command.jobName() == null || command.jobName().isBlank()) {
            return DEFAULT_JOB;
        }
        return command.jobName().trim();
    }

    /** @return the instant the run is evaluated against. */
    public Instant occurredAtOf(ReconciliationCommand command) {
        require(command);
        Instant now = command.now();
        if (now == null) {
            throw new ValidationException("reconciliation command must carry the run instant");
        }
        return now;
    }

    /** Validates the full identity set of {@code command}. */
    public void validate(ReconciliationCommand command) {
        tenantOf(command);
        actorOf(command);
        correlationOf(command);
        occurredAtOf(command);
    }

    /** @return a tenant scope bound to the command's tenant and actor. */
    public TenantScope scopeFor(ReconciliationCommand command) {
        return TenantScope.of(tenantOf(command), actorOf(command), Set.of(), Set.of(), null);
    }

    /** @return {@code true} when {@code candidate} is the same tenant as {@code expected}. */
    public boolean belongsTo(TenantId expected, TenantId candidate) {
        return expected != null && candidate != null && expected.equals(candidate);
    }

    /** @return {@code true} when {@code command} is scoped to {@code tenantId}. */
    public boolean matches(ReconciliationCommand command, TenantId tenantId) {
        return command != null && belongsTo(tenantId, tenantOf(command));
    }

    /** Builds the tenant-keyed scope shared by lease, checkpoint and lock lookups. */
    public static String scopeKey(TenantId tenantId, String jobName) {
        Objects.requireNonNull(tenantId, "tenantId");
        String job = jobName == null || jobName.isBlank() ? DEFAULT_JOB : jobName.trim();
        return tenantId.value() + SCOPE_SEPARATOR + job;
    }

    /** Instance alias of {@link #scopeKey(TenantId, String)}. */
    public String scopedKey(TenantId tenantId, String jobName) {
        return scopeKey(tenantId, jobName);
    }

    private static void require(ReconciliationCommand command) {
        if (command == null || command.metadata() == null) {
            throw new ValidationException("reconciliation command with metadata is required");
        }
    }

    /** Compatibility seam; validates a command and returns its scoped key. */
    public Object execute(Object input) {
        if (input instanceof ReconciliationCommand command) {
            validate(command);
            return scopeKey(tenantOf(command), jobNameOf(command));
        }
        throw new IllegalArgumentException("Expected a ReconciliationCommand");
    }
}
