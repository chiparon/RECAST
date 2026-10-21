package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.StorageFailureException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * Decorates a business action with audit evidence.
 *
 * <p>Runs the supplied action within an {@link AuditScope}, builds an {@link AuditEntry}
 * carrying the caller's tenant, subject, action, correlation identity and a
 * {@link TimeProvider} occurrence instant, writes it through the configured
 * {@link AuditWriter}/{@link AuditPort}, and records the true final business state. A
 * successful action records {@link AuditStatus#ACCEPTED}; a throwing action records
 * {@link AuditStatus#FAILED} and rethrows the original failure. Callers may supply
 * {@link AuditStatus#DUPLICATE}, {@link AuditStatus#ROLLED_BACK} or another status when
 * that is the real outcome.</p>
 *
 * <p>Audit and telemetry failures never fabricate success: the write flows through
 * {@link AuditFailureHandler}, so a policy that forbids reporting completion surfaces a
 * {@link StorageFailureException}, while a failure-path audit is best-effort and can never
 * mask the original business exception.</p>
 */
public final class AuditDecorator {

    private final AuditPort audit;
    private final AuditFailureHandler failureHandler;
    private final TimeProvider clock;

    public AuditDecorator() {
        this(null, null, null);
    }

    public AuditDecorator(AuditPort audit) {
        this(audit, null, null);
    }

    public AuditDecorator(AuditPort audit, AuditFailureHandler failureHandler, TimeProvider clock) {
        this.audit = audit;
        this.failureHandler = failureHandler;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    public AuditDecorator(AuditPort audit, TimeProvider clock) {
        this(audit, null, clock);
    }

    public AuditDecorator(AuditPort audit, AuditFailurePolicy policy) {
        this(audit, new AuditFailureHandler(audit, policy), null);
    }

    /** Runs {@code action} within {@code scope}, recording ACCEPTED on success and FAILED on failure. */
    public <T> T execute(AuditScope scope, Supplier<T> action) {
        return execute(scope, action, AuditStatus.ACCEPTED, AuditStatus.FAILED);
    }

    /** Runs {@code action} within {@code scope}, recording the supplied outcome statuses. */
    public <T> T execute(AuditScope scope, Supplier<T> action, AuditStatus successStatus, AuditStatus failureStatus) {
        Objects.requireNonNull(scope, "scope");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(successStatus, "successStatus");
        Objects.requireNonNull(failureStatus, "failureStatus");

        T result;
        try {
            result = action.get();
        } catch (RuntimeException failure) {
            auditFailure(scope, failureStatus, failure);
            throw failure;
        }
        writeOutcome(scope, successStatus, Map.of());
        return result;
    }

    /** Runs {@code action} within {@code scope}, recording ACCEPTED on success and FAILED on failure. */
    public <T> T execute(TenantId tenantId, String subjectId, AuditAction action, CorrelationId correlationId,
                         Supplier<T> businessAction) {
        return execute(new AuditScope(tenantId, subjectId, action, correlationId), businessAction);
    }

    /** Runs {@code action} within {@code scope}, recording ACCEPTED on success and FAILED on failure. */
    public void run(AuditScope scope, Runnable action) {
        Objects.requireNonNull(action, "action");
        execute(scope, () -> {
            action.run();
            return null;
        });
    }

    /** Builds an audit entry for {@code scope} at the current time with the supplied status. */
    public AuditEntry entryFor(AuditScope scope, AuditStatus status, Map<String, String> details) {
        Objects.requireNonNull(scope, "scope");
        Objects.requireNonNull(status, "status");
        Instant occurredAt = clock.now();
        return new AuditEntry(scope.tenantId(), scope.subjectId(), scope.action(), status,
                scope.correlationId(), occurredAt, details);
    }

    /** Compatibility seam for early implementations; typed execution methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof Supplier<?> supplier) {
            throw new IllegalArgumentException("an audit scope is required to decorate a supplier");
        }
        throw new IllegalArgumentException("expected an AuditScope with an action but got "
                + (input == null ? "null" : input.getClass().getName())
                + "; use execute(AuditScope, Supplier)");
    }

    private void writeOutcome(AuditScope scope, AuditStatus status, Map<String, String> details) {
        AuditEntry entry = entryFor(scope, status, details);
        if (failureHandler != null) {
            failureHandler.append(entry);
            return;
        }
        if (audit == null) {
            return;
        }
        try {
            audit.append(entry);
        } catch (StorageFailureException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new StorageFailureException("failed to persist audit entry", ex);
        }
    }

    private void auditFailure(AuditScope scope, AuditStatus status, RuntimeException failure) {
        Map<String, String> details = new LinkedHashMap<>();
        details.put("error", failure.getClass().getName());
        if (failure.getMessage() != null) {
            details.put("message", failure.getMessage());
        }
        try {
            writeOutcome(scope, status, details);
        } catch (RuntimeException auditFailure) {
            failure.addSuppressed(auditFailure);
        }
    }

    /**
     * Coordinates identifying the business action being audited: tenant, optional subject,
     * action kind and the correlation identity propagated across the operation.
     */
    public record AuditScope(TenantId tenantId, String subjectId, AuditAction action, CorrelationId correlationId) {

        public AuditScope {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(action, "action");
            subjectId = subjectId == null || subjectId.isBlank() ? null : subjectId.trim();
        }

        /** Creates a scope with no subject and no correlation identity. */
        public static AuditScope of(TenantId tenantId, AuditAction action) {
            return new AuditScope(tenantId, null, action, null);
        }
    }
}
