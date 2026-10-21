package com.example.assetupgrade.workflow;

import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.RetryableTransportException;
import com.example.assetupgrade.retry.DeadLetterCoordinator;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.retry.RetryPolicy;
import com.example.assetupgrade.security.AuthorizationDecision;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantScope;
import com.example.assetupgrade.workflow.port.DeadLetterPort;
import com.example.assetupgrade.workflow.port.DeliveryAttemptRepository;
import com.example.assetupgrade.workflow.port.EventEnvelopeRepository;
import com.example.assetupgrade.workflow.port.WorkflowDispatcher;
import com.example.assetupgrade.workflow.port.WorkflowEventStore;
import com.example.assetupgrade.workflow.port.WorkflowLockPort;
import com.example.assetupgrade.workflow.port.WorkflowOutboxPort;
import com.example.assetupgrade.workflow.port.WorkflowRoutePort;
import com.example.assetupgrade.workflow.port.WorkflowStateStore;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Tenant-aware delivery boundary for approved workflow events.
 *
 * <p>Delivery validates the command metadata, authorises the actor for the event tenant with
 * {@link Permission#WORKFLOW_DISPATCH}, requires the event to be in a dispatchable state (an
 * approved event, or a retry-pending event being retried), enforces the tenant and tenant-scoped
 * idempotency rules, resolves the route, persists an {@link EventEnvelope} plus every
 * {@link DeliveryAttempt}, and dispatches behind {@link WorkflowDispatcher} while holding the
 * {@link WorkflowLockPort}. A transport fault or dispatcher exception is converted into a retryable
 * state and the retry policy is applied. When the retry budget is exhausted the event is
 * dead-lettered exactly once. The final status is audited carrying the tenant, correlation, event
 * identity, attempt number and final state.</p>
 *
 * <p>A duplicate event identifier never repeats a business side effect: a completed idempotency key
 * or a terminal envelope short-circuits the delivery with a {@link DeliveryStatus#DUPLICATE}
 * outcome. The application layer depends only on the declared ports; no Camel, Flowable or Kafka
 * type is referenced.</p>
 */
public final class WorkflowDeliveryCoordinator implements WorkflowDeliveryService {

    private final TenantAuthorizer authorizer;
    private final WorkflowDispatcher dispatcher;
    private final EventEnvelopeRepository envelopes;
    private final DeliveryAttemptRepository attempts;
    private final AuditPort audit;
    private final IdempotencyPort idempotency;
    private final RetryPolicy retryPolicy;
    private final DeadLetterPort deadLetters;

    private final WorkflowRoutePort routePort;
    private final WorkflowOutboxPort outbox;
    private final WorkflowLockPort locks;
    private final WorkflowStateStore stateStore;
    private final WorkflowEventStore eventStore;
    private final TimeProvider clock;

    private final WorkflowStatePolicy statePolicy = new WorkflowStatePolicy();
    private final WorkflowEventNormalizer normalizer = new WorkflowEventNormalizer();
    private final WorkflowDuplicateCoordinator duplicateCoordinator;
    private final WorkflowRetryCoordinator retryCoordinator;
    private final WorkflowDeadLetterHandler deadLetterHandler;
    private final WorkflowAuditHandler auditHandler;
    private final ConcurrentHashMap<String, ReentrantLock> fallbackLocks = new ConcurrentHashMap<>();

    /** Creates an unconfigured coordinator; every delivery fails closed. */
    public WorkflowDeliveryCoordinator() {
        this(null, null, null, null, null, null, null, null);
    }

    /** Creates the coordinator with the collaborators declared by the delivery service. */
    public WorkflowDeliveryCoordinator(
            TenantAuthorizer authorizer,
            WorkflowDispatcher dispatcher,
            EventEnvelopeRepository envelopes,
            DeliveryAttemptRepository attempts,
            AuditPort audit,
            IdempotencyPort idempotency,
            RetryPolicy retryPolicy,
            DeadLetterPort deadLetters) {
        this(authorizer, dispatcher, envelopes, attempts, audit, idempotency, retryPolicy, deadLetters,
                null, null, null, null, null, null);
    }

    /** Creates the coordinator with the full set of optional delivery collaborators. */
    public WorkflowDeliveryCoordinator(
            TenantAuthorizer authorizer,
            WorkflowDispatcher dispatcher,
            EventEnvelopeRepository envelopes,
            DeliveryAttemptRepository attempts,
            AuditPort audit,
            IdempotencyPort idempotency,
            RetryPolicy retryPolicy,
            DeadLetterPort deadLetters,
            WorkflowRoutePort routePort,
            WorkflowOutboxPort outbox,
            WorkflowLockPort locks,
            WorkflowStateStore stateStore,
            WorkflowEventStore eventStore,
            TimeProvider clock) {
        this.authorizer = authorizer;
        this.dispatcher = dispatcher;
        this.envelopes = envelopes;
        this.attempts = attempts;
        this.audit = audit;
        this.idempotency = idempotency;
        this.retryPolicy = retryPolicy;
        this.deadLetters = deadLetters;
        this.routePort = routePort;
        this.outbox = outbox;
        this.locks = locks;
        this.stateStore = stateStore;
        this.eventStore = eventStore;
        this.clock = clock == null ? TimeProvider.system() : clock;

        this.auditHandler = new WorkflowAuditHandler(audit, this.clock);
        this.duplicateCoordinator = new WorkflowDuplicateCoordinator(idempotency, envelopes, stateStore);
        this.retryCoordinator = new WorkflowRetryCoordinator(retryPolicy, this.clock);
        this.deadLetterHandler = new WorkflowDeadLetterHandler(
                deadLetters == null ? null : new DeadLetterCoordinator(deadLetters));
    }

    @Override
    public WorkflowDeliveryResult deliver(WorkflowDeliveryCommand command) {
        if (command == null || command.metadata() == null || command.event() == null) {
            return invalid(WorkflowState.NEW, null, null,
                    "workflow delivery command, metadata and event are required");
        }
        CommandMetadata metadata = command.metadata();
        TenantId tenantId = metadata.tenantId();
        ActorId actorId = metadata.actorId();
        CorrelationId correlationId = metadata.correlationId();
        if (tenantId == null || actorId == null || correlationId == null) {
            return invalid(WorkflowState.NEW, tenantId, correlationId,
                    "command metadata must carry tenant, actor and correlation identity");
        }

        TenantId declaredTenant = command.event().tenantId();
        if (declaredTenant != null && !declaredTenant.equals(tenantId)) {
            String reason = "workflow event tenant does not match the command tenant";
            auditHandler.recordDenial(tenantId, command.event().eventId(), correlationId, reason);
            return WorkflowDeliveryResult.rejected(command.event().state(),
                    ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, command.event().eventId()));
        }

        WorkflowEvent event;
        try {
            event = normalizer.normalize(command.event(), tenantId);
        } catch (RuntimeException validation) {
            return invalid(WorkflowState.NEW, tenantId, correlationId, describe(validation));
        }
        String eventId = event.eventId();

        AuthorizationDecision decision = authorize(tenantId, actorId, Permission.WORKFLOW_DISPATCH, eventId);
        if (decision.isDenied()) {
            String reason = decision.reason() == null || decision.reason().isBlank()
                    ? "workflow dispatch denied" : decision.reason();
            auditHandler.recordDenial(tenantId, eventId, correlationId, reason);
            return WorkflowDeliveryResult.rejected(event.state(),
                    ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, eventId));
        }

        if (dispatcher == null) {
            return WorkflowDeliveryResult.rejected(event.state(),
                    ServiceProblem.of(ProblemCode.STORAGE_FAILURE, "workflow dispatcher is not configured", eventId));
        }

        String routeKey = resolveRoute(command.routeKey(), event);
        if (routeKey == null || routeKey.isBlank()) {
            return invalid(event.state(), tenantId, correlationId, "a route key is required to dispatch the event");
        }

        if (!statePolicy.isDispatchable(event.state())) {
            return WorkflowDeliveryResult.rejected(event.state(), ServiceProblem.of(ProblemCode.CONFLICT,
                    "event is not in a dispatchable state: "
                            + (event.state() == null ? "null" : event.state().name()), eventId));
        }

        IdempotencyKey key = duplicateCoordinator.key(tenantId, eventId);
        if (duplicateCoordinator.isDuplicate(key) || duplicateCoordinator.isDuplicate(tenantId, eventId)) {
            return duplicateResult(tenantId, eventId, event);
        }

        Lock lock = lockFor(tenantId, eventId);
        lock.lock();
        try {
            if (duplicateCoordinator.isDuplicate(key) || duplicateCoordinator.isDuplicate(tenantId, eventId)) {
                return duplicateResult(tenantId, eventId, event);
            }

            int attemptNumber = nextAttemptNumber(tenantId, eventId);
            EventEnvelope pending = new EventEnvelope(event, EventProcessingStage.VALIDATED, attemptNumber,
                    null, routeKey, correlationId);
            try {
                persist(pending);
            } catch (RuntimeException storageFailure) {
                return storageFailure(event.state(), eventId, "envelope could not be persisted", storageFailure);
            }

            Instant startedAt = clock.now();
            DeliveryAttempt dispatched = null;
            RuntimeException thrown = null;
            try {
                dispatched = dispatcher.dispatch(event, routeKey, attemptNumber);
            } catch (RuntimeException failure) {
                thrown = failure;
            }

            if (thrown != null || isRetryable(dispatched) || isUnsuccessful(dispatched)) {
                String reason = thrown != null ? describe(thrown) : detailOf(dispatched);
                WorkflowRetryCoordinator.RetryDecision retryDecision =
                        retryCoordinator.onFailure(attemptNumber, thrown, reason);
                if (retryDecision.retry()) {
                    return onRetryable(event, tenantId, correlationId, routeKey, attemptNumber, startedAt,
                            retryDecision, thrown, reason);
                }
                return onDeadLetter(event, tenantId, correlationId, routeKey, attemptNumber, startedAt, reason, key);
            }
            if (isDeadLettered(dispatched)) {
                return onDeadLetter(event, tenantId, correlationId, routeKey, attemptNumber, startedAt,
                        detailOf(dispatched), key);
            }
            if (isRejected(dispatched)) {
                return onTerminalFailure(event, tenantId, correlationId, routeKey, attemptNumber, startedAt,
                        detailOf(dispatched));
            }
            return onSuccess(event, tenantId, correlationId, routeKey, attemptNumber, startedAt, dispatched, key);
        } finally {
            lock.unlock();
        }
    }

    private WorkflowDeliveryResult onSuccess(WorkflowEvent event, TenantId tenantId, CorrelationId correlationId,
                                             String routeKey, int attemptNumber, Instant startedAt,
                                             DeliveryAttempt dispatched, IdempotencyKey key) {
        DeliveryAttempt record = dispatched != null
                ? dispatched
                : new DeliveryAttempt(event.eventId(), tenantId, attemptNumber, true, DeliveryStatus.ACCEPTED,
                        "dispatched", startedAt, clock.now());
        appendAttempt(record);

        WorkflowState dispatchedState = statePolicy.transition(event.state(), WorkflowState.DISPATCHED);
        WorkflowState completedState = statePolicy.transition(dispatchedState, WorkflowState.COMPLETED);
        EventEnvelope completed = new EventEnvelope(event, EventProcessingStage.COMPLETED, attemptNumber,
                null, routeKey, correlationId);

        // Audit is part of the success boundary: record it before the operation is marked complete
        // or the terminal envelope is persisted, so an audit failure leaves the event retryable.
        try {
            auditHandler.recordDelivery(tenantId, event.eventId(), AuditStatus.COMPLETED, correlationId,
                    attemptNumber, routeKey, completedState);
        } catch (RuntimeException auditFailure) {
            duplicateCoordinator.release(key);
            return WorkflowDeliveryResult.retryable(attemptNumber,
                    List.of(ServiceProblem.of(ProblemCode.AUDIT_FAILURE,
                            "delivery audit could not be recorded", event.eventId())));
        }

        try {
            persist(completed);
        } catch (RuntimeException storageFailure) {
            return storageFailure(completedState, event.eventId(), "completed envelope could not be persisted",
                    storageFailure);
        }
        if (eventStore != null) {
            try {
                eventStore.close(completed);
            } catch (RuntimeException ignored) {
                // closing the due record is best-effort and never changes the delivery outcome
            }
        }
        duplicateCoordinator.complete(key);
        return WorkflowDeliveryResult.accepted(attemptNumber);
    }

    private WorkflowDeliveryResult onRetryable(WorkflowEvent event, TenantId tenantId, CorrelationId correlationId,
                                               String routeKey, int attemptNumber, Instant startedAt,
                                               WorkflowRetryCoordinator.RetryDecision decision, Throwable failure,
                                               String reason) {
        DeliveryAttempt record = new DeliveryAttempt(event.eventId(), tenantId, attemptNumber, false,
                DeliveryStatus.RETRYABLE, reason, startedAt, clock.now());
        appendAttempt(record);
        EventEnvelope retry = new EventEnvelope(event, EventProcessingStage.RETRY_PENDING, attemptNumber,
                decision.nextAttemptAt(), routeKey, correlationId);
        try {
            persist(retry);
        } catch (RuntimeException storageFailure) {
            return storageFailure(WorkflowState.RETRY_PENDING, event.eventId(),
                    "retry envelope could not be persisted", storageFailure);
        }
        duplicateCoordinator.release(duplicateCoordinator.key(tenantId, event.eventId()));
        auditHandler.recordDelivery(tenantId, event.eventId(), AuditStatus.RETRY_PENDING, correlationId,
                attemptNumber, routeKey, WorkflowState.RETRY_PENDING);
        ProblemCode code = failure instanceof RetryableTransportException
                ? ProblemCode.TRANSPORT_FAILURE : ProblemCode.RETRYABLE;
        return WorkflowDeliveryResult.retryable(attemptNumber,
                List.of(ServiceProblem.of(code, reason, event.eventId())));
    }

    private WorkflowDeliveryResult onDeadLetter(WorkflowEvent event, TenantId tenantId, CorrelationId correlationId,
                                                String routeKey, int attemptNumber, Instant startedAt,
                                                String reason, IdempotencyKey key) {
        String effectiveReason = reason == null || reason.isBlank() ? "delivery exhausted" : reason;
        deadLetterHandler.deliver(event, effectiveReason, attemptNumber);
        DeliveryAttempt record = new DeliveryAttempt(event.eventId(), tenantId, attemptNumber, false,
                DeliveryStatus.DEAD_LETTERED, effectiveReason, startedAt, clock.now());
        appendAttempt(record);
        EventEnvelope dead = new EventEnvelope(event, EventProcessingStage.DEAD_LETTERED, attemptNumber,
                null, routeKey, correlationId);
        try {
            persist(dead);
        } catch (RuntimeException storageFailure) {
            return storageFailure(WorkflowState.DEAD_LETTERED, event.eventId(),
                    "dead-letter envelope could not be persisted", storageFailure);
        }
        duplicateCoordinator.complete(key);
        auditHandler.recordDelivery(tenantId, event.eventId(), AuditStatus.FAILED, correlationId,
                attemptNumber, routeKey, WorkflowState.DEAD_LETTERED);
        return WorkflowDeliveryResult.deadLettered(attemptNumber,
                List.of(ServiceProblem.of(ProblemCode.RETRY_EXHAUSTED, effectiveReason, event.eventId())));
    }

    private WorkflowDeliveryResult onTerminalFailure(WorkflowEvent event, TenantId tenantId, CorrelationId correlationId,
                                                     String routeKey, int attemptNumber, Instant startedAt,
                                                     String reason) {
        DeliveryAttempt record = new DeliveryAttempt(event.eventId(), tenantId, attemptNumber, false,
                DeliveryStatus.REJECTED, reason, startedAt, clock.now());
        appendAttempt(record);
        EventEnvelope failed = new EventEnvelope(event, EventProcessingStage.DEAD_LETTERED, attemptNumber,
                null, routeKey, correlationId);
        try {
            persist(failed);
        } catch (RuntimeException storageFailure) {
            return storageFailure(WorkflowState.FAILED, event.eventId(),
                    "failed envelope could not be persisted", storageFailure);
        }
        auditHandler.recordDelivery(tenantId, event.eventId(), AuditStatus.FAILED, correlationId,
                attemptNumber, routeKey, WorkflowState.FAILED);
        return new WorkflowDeliveryResult(false, DeliveryStatus.REJECTED, WorkflowState.FAILED, attemptNumber,
                List.of(ServiceProblem.of(ProblemCode.CONFLICT, reason, event.eventId())));
    }

    private WorkflowDeliveryResult duplicateResult(TenantId tenantId, String eventId, WorkflowEvent event) {
        Optional<EventEnvelope> existing = findViewById(tenantId, eventId);
        WorkflowState finalState = existing
                .map(env -> env.event() != null && env.event().state() != null
                        ? env.event().state() : WorkflowStatePolicy.stateOf(env.stage()))
                .orElse(event.state());
        int attemptNumber = existing.map(EventEnvelope::deliveryAttempt).orElse(0);
        return WorkflowDeliveryResult.duplicate(finalState, attemptNumber);
    }

    private WorkflowDeliveryResult invalid(WorkflowState state, TenantId tenantId, CorrelationId correlationId,
                                           String message) {
        return WorkflowDeliveryResult.rejected(state,
                ServiceProblem.of(ProblemCode.INVALID_INPUT, message == null ? "invalid workflow delivery" : message));
    }

    private WorkflowDeliveryResult storageFailure(WorkflowState state, String eventId, String message,
                                                  RuntimeException failure) {
        return WorkflowDeliveryResult.rejected(state,
                ServiceProblem.of(ProblemCode.STORAGE_FAILURE, message + ": " + describe(failure), eventId));
    }

    private AuthorizationDecision authorize(TenantId tenantId, ActorId actorId, Permission permission,
                                            String subjectId) {
        if (authorizer == null) {
            return AuthorizationDecision.allow(Set.of(permission));
        }
        TenantScope scope = TenantScope.of(tenantId, actorId, Set.of(), Set.of(), null);
        AuthorizationDecision decision = authorizer.authorize(scope, permission, subjectId);
        return decision == null ? AuthorizationDecision.deny("authorizer returned no decision") : decision;
    }

    private String resolveRoute(String routeKey, WorkflowEvent event) {
        if (routePort != null) {
            try {
                String resolved = routePort.resolve(routeKey, event);
                if (resolved != null && !resolved.isBlank()) {
                    return resolved;
                }
            } catch (RuntimeException ignored) {
                // fall back to the declared route key
            }
        }
        return routeKey;
    }

    private void persist(EventEnvelope envelope) {
        if (outbox != null) {
            outbox.append(envelope);
        }
        if (envelopes != null) {
            envelopes.save(envelope);
        }
        if (stateStore != null) {
            stateStore.save(envelope);
        }
    }

    private void appendAttempt(DeliveryAttempt attempt) {
        if (attempts != null && attempt != null) {
            attempts.append(attempt);
        }
    }

    private int nextAttemptNumber(TenantId tenantId, String eventId) {
        int prior = 0;
        if (attempts != null) {
            try {
                List<DeliveryAttempt> found = attempts.find(tenantId, eventId);
                if (found != null) {
                    prior = found.size();
                }
            } catch (RuntimeException ignored) {
                // fall through to the persisted envelope
            }
        }
        Optional<EventEnvelope> stored = findViewById(tenantId, eventId);
        if (stored.isPresent()) {
            prior = Math.max(prior, stored.get().deliveryAttempt());
        }
        return prior + 1;
    }

    private Optional<EventEnvelope> findViewById(TenantId tenantId, String eventId) {
        if (stateStore != null) {
            try {
                Optional<EventEnvelope> stored = stateStore.find(tenantId, eventId);
                if (stored != null && stored.isPresent()) {
                    return stored;
                }
            } catch (RuntimeException ignored) {
                // fall through to the envelope repository
            }
        }
        if (envelopes != null) {
            try {
                Optional<EventEnvelope> stored = envelopes.find(tenantId, eventId);
                if (stored != null) {
                    return stored;
                }
            } catch (RuntimeException ignored) {
                // treat a failing lookup as absent
            }
        }
        return Optional.empty();
    }

    private Lock lockFor(TenantId tenantId, String eventId) {
        if (locks != null) {
            try {
                Lock lock = locks.lock(tenantId, eventId);
                if (lock != null) {
                    return lock;
                }
            } catch (RuntimeException ignored) {
                // fall back to an in-process lock
            }
        }
        return fallbackLocks.computeIfAbsent(tenantId.value() + ':' + eventId, key -> new ReentrantLock());
    }

    private static boolean isRetryable(DeliveryAttempt attempt) {
        return attempt != null && attempt.status() == DeliveryStatus.RETRYABLE;
    }

    private static boolean isDeadLettered(DeliveryAttempt attempt) {
        return attempt != null && attempt.status() == DeliveryStatus.DEAD_LETTERED;
    }

    private static boolean isRejected(DeliveryAttempt attempt) {
        return attempt != null && attempt.status() == DeliveryStatus.REJECTED;
    }

    private static boolean isUnsuccessful(DeliveryAttempt attempt) {
        return attempt != null && !attempt.accepted()
                && !isDeadLettered(attempt) && !isRejected(attempt);
    }

    private static String detailOf(DeliveryAttempt attempt) {
        if (attempt == null) {
            return "dispatch failed";
        }
        String detail = attempt.detail();
        return detail == null || detail.isBlank() ? "dispatch failed" : detail;
    }

    private static String describe(Throwable failure) {
        if (failure == null) {
            return "unspecified failure";
        }
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof WorkflowDeliveryCommand command) {
            return deliver(command);
        }
        throw new IllegalArgumentException("Expected WorkflowDeliveryCommand");
    }
}
