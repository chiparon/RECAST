package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.reconciliation.port.CheckpointPort;
import com.example.assetupgrade.reconciliation.port.DueWindowPort;
import com.example.assetupgrade.reconciliation.port.LeasePort;
import com.example.assetupgrade.reconciliation.port.ReconciliationLockPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationMetricsPort;
import com.example.assetupgrade.reconciliation.port.RetryableEventPort;
import com.example.assetupgrade.security.AuthorizationDecision;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantScope;
import com.example.assetupgrade.workflow.EventEnvelope;
import com.example.assetupgrade.workflow.EventProcessingStage;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;
import com.example.assetupgrade.workflow.WorkflowDeliveryResult;
import com.example.assetupgrade.workflow.WorkflowDeliveryService;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Tenant-scoped scheduled reconciliation of due retryable workflow events.
 *
 * <p>A run authorises the actor with {@link Permission#RECONCILIATION_RUN}, acquires a tenant/job
 * lease, reads only the events whose retry window has elapsed and whose retry budget is still
 * open, and dispatches each through the same {@link WorkflowDeliveryService} boundary used for
 * first delivery. A successful or duplicated dispatch closes the retry record; a retryable
 * failure increments the attempt and leaves the record rerunnable; a terminal failure closes it.
 * The checkpoint is advanced after the scan so re-running the same window cannot dispatch a
 * completed event twice.</p>
 *
 * <p>Exactly one {@code RECONCILIATION_RUN} audit entry and the per-tenant metrics are emitted for
 * every run, including an empty run and a run whose lease could not be acquired. No read or
 * mutation ever crosses the command tenant: the lease, checkpoint, due window, metric and audit
 * calls are all keyed by the tenant. The application layer depends only on the declared ports; no
 * Quartz or other scheduler type is referenced.</p>
 */
public final class ReconciliationOrchestrator implements ReconciliationService {

    private final TenantAuthorizer authorizer;
    private final DueWindowPort dueWindow;
    private final RetryableEventPort retryableEvents;
    private final LeasePort leases;
    private final CheckpointPort checkpoints;
    private final AuditPort audit;
    private final WorkflowDeliveryService workflow;
    private final ReconciliationMetricsPort metrics;
    private final ReconciliationLockPort lockPort;
    private final TimeProvider clock;

    private final ReconciliationTenantFilter tenantFilter;
    private final ReconciliationLeaseCoordinator leaseCoordinator;
    private final ReconciliationCheckpointCoordinator checkpointCoordinator;
    private final ReconciliationFailureHandler failureHandler;
    private final ReconciliationAuditHandler auditHandler;
    private final ReconciliationMetricsHandler metricsHandler;
    private final ConcurrentHashMap<String, ReentrantLock> fallbackLocks = new ConcurrentHashMap<>();

    /** Creates an unconfigured orchestrator; every run fails closed. */
    public ReconciliationOrchestrator() {
        this(null, null, null, null, null, null, null);
    }

    /** Creates the orchestrator with the collaborators declared by the reconciliation service. */
    public ReconciliationOrchestrator(
            TenantAuthorizer authorizer,
            DueWindowPort dueWindow,
            RetryableEventPort retryableEvents,
            LeasePort leases,
            CheckpointPort checkpoints,
            AuditPort audit,
            WorkflowDeliveryService workflow) {
        this(authorizer, dueWindow, retryableEvents, leases, checkpoints, audit, workflow,
                null, null, null);
    }

    /** Creates the orchestrator with the full set of optional reconciliation collaborators. */
    public ReconciliationOrchestrator(
            TenantAuthorizer authorizer,
            DueWindowPort dueWindow,
            RetryableEventPort retryableEvents,
            LeasePort leases,
            CheckpointPort checkpoints,
            AuditPort audit,
            WorkflowDeliveryService workflow,
            ReconciliationMetricsPort metrics,
            ReconciliationLockPort lockPort,
            TimeProvider clock) {
        this.authorizer = authorizer;
        this.dueWindow = dueWindow;
        this.retryableEvents = retryableEvents;
        this.leases = leases;
        this.checkpoints = checkpoints;
        this.audit = audit;
        this.workflow = workflow;
        this.metrics = metrics;
        this.lockPort = lockPort;
        this.clock = clock == null ? TimeProvider.system() : clock;

        this.tenantFilter = new ReconciliationTenantFilter();
        this.leaseCoordinator = new ReconciliationLeaseCoordinator(leases, this.clock, null);
        this.checkpointCoordinator = new ReconciliationCheckpointCoordinator(checkpoints, dueWindow, this.clock, null);
        this.failureHandler = new ReconciliationFailureHandler(retryableEvents, null, this.clock);
        this.auditHandler = new ReconciliationAuditHandler(audit, this.clock);
        this.metricsHandler = new ReconciliationMetricsHandler(metrics);
    }

    @Override
    public ReconciliationReport run(ReconciliationCommand command) {
        tenantFilter.validate(command);
        TenantId tenantId = tenantFilter.tenantOf(command);
        ActorId actorId = tenantFilter.actorOf(command);
        CorrelationId correlationId = tenantFilter.correlationOf(command);
        String jobName = tenantFilter.jobNameOf(command);
        Instant runAt = tenantFilter.occurredAtOf(command);
        String scopeKey = ReconciliationTenantFilter.scopeKey(tenantId, jobName);

        AuthorizationDecision decision = authorize(tenantId, actorId, jobName);
        if (decision.isDenied()) {
            String reason = decision.reason() == null || decision.reason().isBlank()
                    ? "reconciliation run denied" : decision.reason();
            auditHandler.recordDenial(tenantId, jobName, correlationId, reason);
            metricsHandler.denied(tenantId);
            return emptyReport(null);
        }

        Lock lock = lockFor(tenantId, jobName);
        lock.lock();
        try {
            Optional<LeaseClaim> claimed = leaseCoordinator.acquire(tenantId, scopeKey);
            if (claimed.isEmpty()) {
                auditHandler.recordSkipped(tenantId, jobName, correlationId, "lease-not-acquired");
                metricsHandler.skipped(tenantId);
                return emptyReport(null);
            }
            LeaseClaim claim = claimed.get();
            try {
                return reconcile(command, tenantId, actorId, correlationId, jobName, runAt);
            } finally {
                leaseCoordinator.release(claim);
            }
        } finally {
            lock.unlock();
        }
    }

    private ReconciliationReport reconcile(ReconciliationCommand command, TenantId tenantId, ActorId actorId,
                                           CorrelationId correlationId, String jobName, Instant runAt) {
        if (workflow == null || dueWindow == null) {
            auditHandler.recordRun(tenantId, jobName, correlationId, 0, 0, 0, 0, null);
            metricsHandler.record(tenantId, 0, 0, 0, 0);
            return emptyReport(null);
        }

        Checkpoint previous = checkpointCoordinator.load(tenantId, jobName);
        DueWindow window = checkpointCoordinator.windowFor(previous, command);
        List<EventEnvelope> due;
        try {
            due = checkpointCoordinator.scanDue(tenantId, window);
        } catch (RuntimeException scanFailure) {
            auditHandler.recordFailure(tenantId, jobName, correlationId, describe(scanFailure));
            metricsHandler.record(tenantId, 0, 0, 0, 0);
            return emptyReport(null);
        }

        Counter counter = new Counter();
        List<String> eventIds = new ArrayList<>();
        List<EventEnvelope> dispatched = new ArrayList<>();

        for (EventEnvelope envelope : due) {
            if (envelope == null || envelope.event() == null) {
                continue;
            }
            TenantId owner = envelope.event().tenantId();
            if (owner != null && !owner.equals(tenantId)) {
                // A record owned by another tenant is never read or mutated here.
                continue;
            }
            if (isTerminal(envelope.stage())) {
                // A completed or dead-lettered envelope is never dispatched again.
                safeClose(envelope);
                continue;
            }
            if (!failureHandler.windowElapsed(envelope, runAt)) {
                // The retry window has not elapsed yet; the event is not due for this run.
                continue;
            }
            String eventId = envelope.event().eventId();
            if (eventId != null) {
                eventIds.add(eventId);
            }
            counter.examined++;
            dispatched.add(envelope);

            if (!failureHandler.hasBudget(envelope)) {
                // Retry budget exhausted: close the record so it is not replayed, count as failed.
                safeClose(envelope);
                counter.cleaned++;
                counter.failed++;
                continue;
            }

            WorkflowDeliveryResult result;
            try {
                result = workflow.deliver(deliveryCommand(command, tenantId, actorId, envelope));
            } catch (RuntimeException dispatchFailure) {
                result = null;
            }

            if (result == null) {
                if (failureHandler.recover(envelope, null)) {
                    counter.retried++;
                } else {
                    counter.failed++;
                }
                continue;
            }
            if (result.accepted()) {
                safeClose(envelope);
                counter.succeeded++;
            } else if (result.isRetryable()) {
                if (failureHandler.recover(envelope)) {
                    counter.retried++;
                } else {
                    counter.failed++;
                }
            } else {
                safeClose(envelope);
                counter.failed++;
            }
        }

        String checkpointId = null;
        try {
            Checkpoint next = checkpointCoordinator.advance(tenantId, jobName, previous, dispatched, runAt);
            checkpointId = ReconciliationCheckpointCoordinator.checkpointId(tenantId, next);
        } catch (RuntimeException checkpointFailure) {
            checkpointId = ReconciliationCheckpointCoordinator.checkpointId(tenantId, previous);
        }

        auditHandler.recordRun(tenantId, jobName, correlationId, runAt, counter.examined, counter.retried,
                counter.succeeded, counter.failed, checkpointId);
        metricsHandler.record(tenantId, counter.examined, counter.retried, counter.succeeded, counter.failed);
        if (counter.cleaned > 0) {
            metricsHandler.cleaned(tenantId, counter.cleaned);
        }
        return new ReconciliationReport(counter.examined, counter.retried, counter.succeeded, counter.failed,
                List.copyOf(eventIds), checkpointId);
    }

    private WorkflowDeliveryCommand deliveryCommand(ReconciliationCommand command, TenantId tenantId,
                                                    ActorId actorId, EventEnvelope envelope) {
        CorrelationId correlationId = envelope.correlationId() != null
                ? envelope.correlationId()
                : command.metadata().correlationId();
        CommandMetadata metadata = new CommandMetadata(tenantId, actorId, correlationId,
                command.metadata().receivedAt());
        String routeKey = envelope.routeKey();
        if (routeKey == null || routeKey.isBlank()) {
            routeKey = tenantFilter.jobNameOf(command);
        }
        return new WorkflowDeliveryCommand(metadata, envelope.event(), routeKey);
    }

    private AuthorizationDecision authorize(TenantId tenantId, ActorId actorId, String jobName) {
        if (authorizer == null) {
            return AuthorizationDecision.allow(Set.of(Permission.RECONCILIATION_RUN));
        }
        TenantScope scope = TenantScope.of(tenantId, actorId, Set.of(), Set.of(), null);
        AuthorizationDecision decision = authorizer.authorize(scope, Permission.RECONCILIATION_RUN, jobName);
        return decision == null ? AuthorizationDecision.deny("authorizer returned no decision") : decision;
    }

    private void safeClose(EventEnvelope envelope) {
        try {
            failureHandler.close(envelope);
        } catch (RuntimeException ignored) {
            // closing a due record is best-effort and never changes the run outcome
        }
    }

    private Lock lockFor(TenantId tenantId, String jobName) {
        if (lockPort != null) {
            try {
                Lock lock = lockPort.lock(tenantId, jobName);
                if (lock != null) {
                    return lock;
                }
            } catch (RuntimeException ignored) {
                // fall back to an in-process lock
            }
        }
        String key = ReconciliationTenantFilter.scopeKey(tenantId, jobName);
        return fallbackLocks.computeIfAbsent(key, ignored -> new ReentrantLock());
    }

    private static ReconciliationReport emptyReport(String checkpointId) {
        return new ReconciliationReport(0, 0, 0, 0, List.of(), checkpointId);
    }

    private static String describe(Throwable failure) {
        if (failure == null) {
            return "unspecified failure";
        }
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    private static boolean isTerminal(EventProcessingStage stage) {
        return stage == EventProcessingStage.COMPLETED || stage == EventProcessingStage.DEAD_LETTERED;
    }

    /** Mutable per-run counters. */
    private static final class Counter {
        private int examined;
        private int retried;
        private int succeeded;
        private int failed;
        private int cleaned;
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof ReconciliationCommand command) {
            return run(command);
        }
        throw new IllegalArgumentException("Expected a ReconciliationCommand");
    }
}
