package com.example.assetupgrade.adapters;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.observability.MetricPort;
import com.example.assetupgrade.reconciliation.Checkpoint;
import com.example.assetupgrade.reconciliation.LeaseClaim;
import com.example.assetupgrade.reconciliation.ReconciliationCommand;
import com.example.assetupgrade.reconciliation.ReconciliationReport;
import com.example.assetupgrade.reconciliation.port.CheckpointPort;
import com.example.assetupgrade.reconciliation.port.LeasePort;
import com.example.assetupgrade.reconciliation.port.ReconciliationAuditPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationJobPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationLockPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationMetricsPort;
import com.example.assetupgrade.reconciliation.port.RetryableEventPort;
import com.example.assetupgrade.workflow.DeliveryAttempt;
import com.example.assetupgrade.workflow.EventEnvelope;
import com.example.assetupgrade.workflow.port.WorkflowDispatcher;
import com.example.assetupgrade.workflow.port.WorkflowEventStore;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Quartz-shaped reconciliation scheduler implementing {@link ReconciliationJobPort},
 * {@link LeasePort}, {@link ReconciliationLockPort} and {@link ReconciliationMetricsPort}.
 *
 * <p>{@link #run(ReconciliationCommand)} acquires a tenant-scoped lease (with a TTL) and a
 * tenant-scoped lock, reads only due retryable events through the workflow event store, dispatches
 * them through the same workflow boundary, closes successes and leaves failures rerunnable. A
 * checkpoint and an audit entry are persisted for every run, including an empty run, and per-tenant
 * metrics are counted. Re-running the same window is safe because a completed event is closed and no
 * longer returned as due; a run never reads or mutates another tenant's records.</p>
 *
 * <p>Quartz itself is absent from the classpath, so {@link #schedule(ReconciliationCommand, Duration)}
 * records an explicit in-process schedule rather than pretending a remote trigger exists.</p>
 */
public final class QuartzReconciliationScheduler
        implements ReconciliationJobPort, LeasePort, ReconciliationLockPort, ReconciliationMetricsPort {

    /** Default lease time-to-live applied when the caller does not supply one. */
    public static final Duration DEFAULT_LEASE_TTL = Duration.ofMinutes(5);

    /** Default backoff applied to a failed, rerunnable event. */
    public static final Duration DEFAULT_FAILURE_BACKOFF = Duration.ofSeconds(30);

    private final WorkflowEventStore events;
    private final RetryableEventPort retryable;
    private final WorkflowDispatcher dispatcher;
    private final CheckpointPort checkpoints;
    private final ReconciliationAuditPort audit;
    private final MetricPort metrics;
    private final TimeProvider clock;
    private final Duration leaseTtl;
    private final Duration failureBackoff;
    private final Map<String, LeaseClaim> leases = new ConcurrentHashMap<>();
    private final Map<String, ReentrantLock> locks = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Long>> counters = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Checkpoint>> checkpointsByTenant = new ConcurrentHashMap<>();
    private final List<ScheduleRecord> schedules = new ArrayList<>();

    /** Creates a scheduler with no collaborators; every run is an honest empty run. */
    public QuartzReconciliationScheduler() {
        this(null, null, null, null, null, null, TimeProvider.system(), DEFAULT_LEASE_TTL);
    }

    /** Creates a scheduler over the workflow collaborators. */
    public QuartzReconciliationScheduler(WorkflowEventStore events, RetryableEventPort retryable,
                                         WorkflowDispatcher dispatcher) {
        this(events, retryable, dispatcher, null, null, null, TimeProvider.system(), DEFAULT_LEASE_TTL);
    }

    /** Creates a scheduler over the workflow collaborators plus a checkpoint store. */
    public QuartzReconciliationScheduler(WorkflowEventStore events, RetryableEventPort retryable,
                                         WorkflowDispatcher dispatcher, CheckpointPort checkpoints) {
        this(events, retryable, dispatcher, checkpoints, null, null, TimeProvider.system(), DEFAULT_LEASE_TTL);
    }

    /** Creates a fully configured scheduler. */
    public QuartzReconciliationScheduler(WorkflowEventStore events, RetryableEventPort retryable,
                                         WorkflowDispatcher dispatcher, CheckpointPort checkpoints,
                                         ReconciliationAuditPort audit, MetricPort metrics,
                                         TimeProvider clock, Duration leaseTtl) {
        this.events = events;
        this.retryable = retryable;
        this.dispatcher = dispatcher;
        this.checkpoints = checkpoints;
        this.audit = audit;
        this.metrics = metrics;
        this.clock = clock == null ? TimeProvider.system() : clock;
        this.leaseTtl = leaseTtl == null || leaseTtl.isZero() || leaseTtl.isNegative()
                ? DEFAULT_LEASE_TTL
                : leaseTtl;
        this.failureBackoff = DEFAULT_FAILURE_BACKOFF;
    }

    /** @return a scheduler with no external collaborators. */
    public static QuartzReconciliationScheduler local() {
        return new QuartzReconciliationScheduler();
    }

    // ------------------------------------------------------------------ ReconciliationJobPort

    @Override
    public ReconciliationReport run(ReconciliationCommand command) {
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(command.metadata(), "command.metadata");
        TenantId tenantId = Objects.requireNonNull(command.metadata().tenantId(), "command.metadata.tenantId");
        Instant now = command.now() == null ? clock.now() : command.now();
        int limit = command.limit() > 0 ? command.limit() : 100;
        String jobName = command.jobName() == null || command.jobName().isBlank()
                ? "reconciliation"
                : command.jobName().trim();

        Lock lock = lock(tenantId, jobName);
        try {
            Optional<LeaseClaim> claim = tryClaim(tenantId, jobName, leaseTtl);
            if (claim.isEmpty()) {
                count(tenantId, "reconciliation.skipped", 1);
                return new ReconciliationReport(0, 0, 0, 0, List.of(), jobName);
            }
            try {
                return executeRun(command, tenantId, now, limit, jobName);
            } finally {
                release(claim.get());
            }
        } finally {
            lock.unlock();
        }
    }

    private ReconciliationReport executeRun(ReconciliationCommand command, TenantId tenantId, Instant now,
                                            int limit, String jobName) {
        List<EventEnvelope> due = events == null ? List.of() : events.findDue(tenantId, now, limit);
        int examined = 0;
        int succeeded = 0;
        int failed = 0;
        String lastEventId = null;
        List<String> eventIds = new ArrayList<>();

        for (EventEnvelope envelope : due) {
            if (envelope == null || envelope.event() == null) {
                continue;
            }
            examined++;
            String eventId = envelope.event().eventId();
            if (eventId != null) {
                eventIds.add(eventId);
                lastEventId = eventId;
            }
            int attempt = Math.max(1, envelope.deliveryAttempt() + 1);
            DeliveryAttempt outcome = dispatcher == null
                    ? null
                    : dispatcher.dispatch(envelope.event(), envelope.routeKey(), attempt);
            boolean accepted = outcome != null && outcome.accepted();
            if (accepted) {
                succeeded++;
                if (retryable != null) {
                    retryable.close(envelope);
                }
            } else {
                failed++;
                if (retryable != null) {
                    retryable.markRetryable(envelope, now.plus(failureBackoff));
                }
            }
        }

        Checkpoint checkpoint = new Checkpoint(jobName, lastEventId, now, examined);
        checkpointsByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>())
                .put(jobName, checkpoint);
        if (checkpoints != null) {
            checkpoints.put(tenantId, checkpoint);
        }
        count(tenantId, "reconciliation.examined", examined);
        count(tenantId, "reconciliation.succeeded", succeeded);
        count(tenantId, "reconciliation.failed", failed);
        recordAudit(command, tenantId, examined, succeeded, failed, now);
        return new ReconciliationReport(examined, examined, succeeded, failed, eventIds,
                lastEventId == null ? jobName : lastEventId);
    }

    private void recordAudit(ReconciliationCommand command, TenantId tenantId, int examined, int succeeded,
                             int failed, Instant now) {
        if (audit == null) {
            return;
        }
        Map<String, String> details = new LinkedHashMap<>();
        details.put("jobName", command.jobName() == null ? "reconciliation" : command.jobName());
        details.put("examined", Integer.toString(examined));
        details.put("succeeded", Integer.toString(succeeded));
        details.put("failed", Integer.toString(failed));
        String subjectId = command.metadata().actorId() == null ? null : command.metadata().actorId().value();
        AuditEntry entry = new AuditEntry(tenantId, subjectId, AuditAction.RECONCILIATION_RUN,
                AuditStatus.COMPLETED, command.metadata().correlationId(), now, details);
        audit.record(entry);
    }

    // ------------------------------------------------------------------ LeasePort

    @Override
    public Optional<LeaseClaim> tryClaim(TenantId tenantId, String key, Duration duration) {
        if (tenantId == null || key == null || key.isBlank()) {
            return Optional.empty();
        }
        String lockKey = leaseKey(tenantId, key);
        Duration ttl = duration == null || duration.isZero() || duration.isNegative() ? leaseTtl : duration;
        Instant now = clock.now();
        synchronized (leases) {
            LeaseClaim existing = leases.get(lockKey);
            if (existing != null && existing.expiresAt() != null && existing.expiresAt().isAfter(now)) {
                return Optional.empty();
            }
            LeaseClaim claim = new LeaseClaim(key.trim(), tenantId, now.plus(ttl), ownerId());
            leases.put(lockKey, claim);
            return Optional.of(claim);
        }
    }

    @Override
    public void release(LeaseClaim claim) {
        if (claim == null || claim.tenantId() == null || claim.key() == null) {
            return;
        }
        leases.remove(leaseKey(claim.tenantId(), claim.key()));
    }

    // ------------------------------------------------------------------ ReconciliationLockPort

    @Override
    public Lock lock(TenantId tenantId, String jobName) {
        Objects.requireNonNull(tenantId, "tenantId");
        String key = leaseKey(tenantId, jobName == null ? "reconciliation" : jobName);
        ReentrantLock lock = locks.computeIfAbsent(key, ignored -> new ReentrantLock());
        lock.lock();
        return lock;
    }

    // ------------------------------------------------------------------ ReconciliationMetricsPort

    @Override
    public void count(TenantId tenantId, String metric, long amount) {
        if (tenantId == null || metric == null || metric.isBlank()) {
            return;
        }
        counters.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>())
                .merge(metric.trim(), amount, Long::sum);
        if (metrics != null) {
            try {
                metrics.increment(metric.trim(), Math.max(0L, amount));
            } catch (RuntimeException ignored) {
                // Metrics are best effort and must never change the reconciliation outcome.
            }
        }
    }

    /** @return the recorded counter for {@code tenantId}/{@code metric}, or {@code 0}. */
    public long counter(TenantId tenantId, String metric) {
        if (tenantId == null || metric == null) {
            return 0L;
        }
        Map<String, Long> tenantCounters = counters.get(tenantId.value());
        if (tenantCounters == null) {
            return 0L;
        }
        Long value = tenantCounters.get(metric);
        return value == null ? 0L : value;
    }

    /** @return the checkpoint most recently persisted for {@code tenantId}/{@code jobName}. */
    public Optional<Checkpoint> checkpoint(TenantId tenantId, String jobName) {
        if (tenantId == null || jobName == null) {
            return Optional.empty();
        }
        Map<String, Checkpoint> tenantCheckpoints = checkpointsByTenant.get(tenantId.value());
        if (tenantCheckpoints == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantCheckpoints.get(jobName));
    }

    /** @return the active lease for {@code tenantId}/{@code key}, if any. */
    public Optional<LeaseClaim> activeLease(TenantId tenantId, String key) {
        if (tenantId == null || key == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(leases.get(leaseKey(tenantId, key)));
    }

    /**
     * Records an in-process schedule for {@code command}; no remote trigger is claimed.
     *
     * @return the instant at which the run would be triggered
     */
    public Instant schedule(ReconciliationCommand command, Duration delay) {
        Objects.requireNonNull(command, "command");
        Duration effective = delay == null || delay.isNegative() ? Duration.ZERO : delay;
        Instant triggerAt = clock.now().plus(effective);
        synchronized (schedules) {
            schedules.add(new ScheduleRecord(command.jobName(), triggerAt));
        }
        return triggerAt;
    }

    /** @return the recorded in-process schedules. */
    public List<ScheduleRecord> schedules() {
        synchronized (schedules) {
            return List.copyOf(schedules);
        }
    }

    private String ownerId() {
        return "quartz-" + Integer.toHexString(System.identityHashCode(this));
    }

    private static String leaseKey(TenantId tenantId, String key) {
        return tenantId.value() + '\u0000' + (key == null ? "" : key.trim());
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof ReconciliationCommand command) {
            return run(command);
        }
        if (input instanceof ClaimRequest request) {
            return tryClaim(request.tenantId(), request.key(), request.duration());
        }
        if (input instanceof LeaseClaim claim) {
            release(claim);
            return null;
        }
        if (input instanceof LockRequest request) {
            return lock(request.tenantId(), request.jobName());
        }
        if (input instanceof MetricRequest request) {
            count(request.tenantId(), request.metric(), request.amount());
            return null;
        }
        throw new IllegalArgumentException("unsupported reconciliation scheduler request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record ClaimRequest(TenantId tenantId, String key, Duration duration) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record LockRequest(TenantId tenantId, String jobName) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record MetricRequest(TenantId tenantId, String metric, long amount) {
    }

    /**
     * An in-process schedule record.
     *
     * @param jobName   the scheduled job name
     * @param triggerAt the instant the run would fire
     */
    public record ScheduleRecord(String jobName, Instant triggerAt) {
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
