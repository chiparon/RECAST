package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.reconciliation.port.ReconciliationAuditPort;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Writes the tenant-scoped audit evidence for a scheduled reconciliation run.
 *
 * <p>Exactly one {@link AuditAction#RECONCILIATION_RUN} entry is produced for every run, including
 * an empty run and a run whose lease could not be acquired. The entry carries the tenant, the job
 * name as subject, the final {@link AuditStatus}, the correlation identity, the occurrence instant
 * and a details map with the examined/retried/succeeded/failed counts and the checkpoint id.</p>
 *
 * <p>An authorization or tenant denial is recorded with {@link AuditAction#SECURITY_DENIAL}. The
 * handler never rewrites the correlation identity or the final status.</p>
 */
public final class ReconciliationAuditHandler {

    /** Detail key holding the job name. */
    public static final String JOB_NAME = "jobName";
    /** Detail key holding the number of events examined. */
    public static final String EXAMINED = "examined";
    /** Detail key holding the number of events left rerunnable. */
    public static final String RETRIED = "retried";
    /** Detail key holding the number of events delivered. */
    public static final String SUCCEEDED = "succeeded";
    /** Detail key holding the number of events that terminated unsuccessfully. */
    public static final String FAILED = "failed";
    /** Detail key holding the persisted checkpoint identifier. */
    public static final String CHECKPOINT = "checkpoint";
    /** Detail key flagging a run that examined no events. */
    public static final String EMPTY = "empty";
    /** Detail key flagging whether the run acquired its lease. */
    public static final String LEASE_ACQUIRED = "leaseAcquired";
    /** Detail key holding the reason for a denial or skip. */
    public static final String REASON = "reason";
    /** Detail key holding the last event identifier observed by the run. */
    public static final String LAST_EVENT_ID = "lastEventId";

    private final AuditPort audit;
    private final ReconciliationAuditPort reconciliationAudit;
    private final TimeProvider clock;

    /** Creates a handler with no sink; entries are built but not persisted. */
    public ReconciliationAuditHandler() {
        this(null, null, null);
    }

    /** Creates a handler writing through {@code audit}. */
    public ReconciliationAuditHandler(AuditPort audit) {
        this(audit, null, null);
    }

    /** Creates a handler writing through {@code audit} using {@code clock} for the occurrence instant. */
    public ReconciliationAuditHandler(AuditPort audit, TimeProvider clock) {
        this(audit, null, clock);
    }

    /** Creates a handler writing through the reconciliation audit port. */
    public ReconciliationAuditHandler(ReconciliationAuditPort reconciliationAudit) {
        this(null, reconciliationAudit, null);
    }

    /** Creates a handler with the full sink set. */
    public ReconciliationAuditHandler(AuditPort audit, ReconciliationAuditPort reconciliationAudit,
                                      TimeProvider clock) {
        this.audit = audit;
        this.reconciliationAudit = reconciliationAudit;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Builds and writes one audit entry using the current time; returns the entry that was written. */
    public AuditEntry record(TenantId tenantId, String subjectId, AuditAction action, AuditStatus status,
                             CorrelationId correlationId, Map<String, String> details) {
        return record(tenantId, subjectId, action, status, correlationId, clock.now(), details);
    }

    /** Builds and writes one audit entry with an explicit occurrence instant. */
    public AuditEntry record(TenantId tenantId, String subjectId, AuditAction action, AuditStatus status,
                             CorrelationId correlationId, Instant occurredAt, Map<String, String> details) {
        AuditEntry entry = new AuditEntry(tenantId, subjectId, action, status, correlationId,
                occurredAt == null ? clock.now() : occurredAt, details);
        append(entry);
        return entry;
    }

    /** Records the single {@code RECONCILIATION_RUN} entry for a completed scan. */
    public AuditEntry recordRun(TenantId tenantId, String jobName, CorrelationId correlationId,
                                int examined, int retried, int succeeded, int failed, String checkpointId) {
        return recordRun(tenantId, jobName, correlationId, clock.now(), examined, retried, succeeded, failed,
                checkpointId);
    }

    /** Records the single {@code RECONCILIATION_RUN} entry with an explicit occurrence instant. */
    public AuditEntry recordRun(TenantId tenantId, String jobName, CorrelationId correlationId, Instant occurredAt,
                                int examined, int retried, int succeeded, int failed, String checkpointId) {
        Map<String, String> details = new LinkedHashMap<>();
        details.put(JOB_NAME, jobName == null ? ReconciliationTenantFilter.DEFAULT_JOB : jobName);
        details.put(EXAMINED, Integer.toString(Math.max(0, examined)));
        details.put(RETRIED, Integer.toString(Math.max(0, retried)));
        details.put(SUCCEEDED, Integer.toString(Math.max(0, succeeded)));
        details.put(FAILED, Integer.toString(Math.max(0, failed)));
        details.put(EMPTY, Boolean.toString(examined <= 0));
        details.put(LEASE_ACQUIRED, Boolean.TRUE.toString());
        if (checkpointId != null) {
            details.put(CHECKPOINT, checkpointId);
        }
        AuditStatus status = statusFor(examined, retried, failed);
        return record(tenantId, jobName, AuditAction.RECONCILIATION_RUN, status, correlationId, occurredAt, details);
    }

    /** Records the single {@code RECONCILIATION_RUN} entry for an empty run. */
    public AuditEntry recordEmptyRun(TenantId tenantId, String jobName, CorrelationId correlationId,
                                     String checkpointId) {
        return recordRun(tenantId, jobName, correlationId, 0, 0, 0, 0, checkpointId);
    }

    /** Records a skipped run whose lease could not be acquired; still a single audit entry. */
    public AuditEntry recordSkipped(TenantId tenantId, String jobName, CorrelationId correlationId, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        details.put(JOB_NAME, jobName == null ? ReconciliationTenantFilter.DEFAULT_JOB : jobName);
        details.put(LEASE_ACQUIRED, Boolean.FALSE.toString());
        details.put(REASON, reason == null || reason.isBlank() ? "lease-not-acquired" : reason);
        return record(tenantId, jobName, AuditAction.RECONCILIATION_RUN, AuditStatus.DUPLICATE, correlationId,
                details);
    }

    /** Records a scan failure that prevented the due window from being read. */
    public AuditEntry recordFailure(TenantId tenantId, String jobName, CorrelationId correlationId, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        details.put(JOB_NAME, jobName == null ? ReconciliationTenantFilter.DEFAULT_JOB : jobName);
        details.put(REASON, reason == null || reason.isBlank() ? "scan-failed" : reason);
        return record(tenantId, jobName, AuditAction.RECONCILIATION_RUN, AuditStatus.FAILED, correlationId,
                details);
    }

    /** Records an authorization or tenant denial for a run. */
    public AuditEntry recordDenial(TenantId tenantId, String jobName, CorrelationId correlationId, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        details.put(JOB_NAME, jobName == null ? ReconciliationTenantFilter.DEFAULT_JOB : jobName);
        details.put(REASON, reason == null || reason.isBlank() ? "denied" : reason);
        return record(tenantId, jobName, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, correlationId, details);
    }

    /** @return the audit status that best describes the counts of a run. */
    public static AuditStatus statusFor(int examined, int retried, int failed) {
        if (examined <= 0) {
            return AuditStatus.COMPLETED;
        }
        if (failed <= 0 && retried <= 0) {
            return AuditStatus.COMPLETED;
        }
        if (failed >= examined) {
            return AuditStatus.FAILED;
        }
        return AuditStatus.RETRY_PENDING;
    }

    private void append(AuditEntry entry) {
        if (audit != null) {
            audit.append(entry);
            return;
        }
        if (reconciliationAudit != null) {
            reconciliationAudit.record(entry);
        }
    }

    /** @return the backing audit port, or {@code null} when none is configured. */
    public AuditPort port() {
        return audit;
    }

    /** Compatibility seam; accepts a job name and records a skipped run. */
    public Object execute(Object input) {
        if (input instanceof String jobName) {
            return recordSkipped(null, jobName, null, "manual");
        }
        throw new IllegalArgumentException("Expected a job name String");
    }
}
