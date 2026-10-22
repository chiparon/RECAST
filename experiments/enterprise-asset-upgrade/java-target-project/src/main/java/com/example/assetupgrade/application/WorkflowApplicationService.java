package com.example.assetupgrade.application;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditDecorator;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.ServiceResult;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.observability.CorrelationPort;
import com.example.assetupgrade.observability.MetricPort;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.security.AuthorizationDecision;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantScope;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;
import com.example.assetupgrade.workflow.WorkflowDeliveryResult;
import com.example.assetupgrade.workflow.WorkflowDeliveryService;
import com.example.assetupgrade.workflow.WorkflowEvent;
import com.example.assetupgrade.workflow.WorkflowState;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Application use case for approved workflow-event delivery.
 *
 * <p>Composes the reused {@link WorkflowDeliveryService}. The actor must be authorised for
 * the event tenant and the event must be in a dispatchable (approved or retry-pending)
 * state before the boundary dispatches. Duplicate event identifiers short-circuit to the
 * stored outcome without repeating a business side effect. Transport failures and
 * dispatcher exceptions, the retry policy and dead-lettering remain in the feature
 * coordinator; this layer only closes identity, tenant, idempotency and audit handling and
 * never references a Camel, Flowable or Kafka type.</p>
 */
public final class WorkflowApplicationService {

    /** Application-level idempotency operation for workflow delivery. */
    public static final String DELIVERY_OPERATION = "application.workflow.deliver";

    private final WorkflowDeliveryService deliveryService;
    private final CommandValidator validator;
    private final TenantAuthorizer authorizer;
    private final CorrelationPort correlations;
    private final AuditDecorator auditDecorator;
    private final AuditPort auditPort;
    private final IdempotencyPort idempotency;
    private final MetricPort metrics;
    private final TimeProvider clock;

    private final ConcurrentHashMap<String, WorkflowDeliveryResult> completed = new ConcurrentHashMap<>();

    /** Creates an unconfigured service; every delivery fails closed. */
    public WorkflowApplicationService() {
        this(null, null, null, null, null, null, null, null, null);
    }

    /** Creates the service over the reused workflow delivery feature boundary. */
    public WorkflowApplicationService(WorkflowDeliveryService deliveryService) {
        this(deliveryService, null, null, null, null, null, null, null, null);
    }

    /** Creates the service with the identity, correlation and audit collaborators. */
    public WorkflowApplicationService(WorkflowDeliveryService deliveryService,
                                      CommandValidator validator,
                                      TenantAuthorizer authorizer,
                                      CorrelationPort correlations,
                                      AuditDecorator auditDecorator) {
        this(deliveryService, validator, authorizer, correlations, auditDecorator, null, null, null, null);
    }

    /** Creates the service with the full collaborator set. */
    public WorkflowApplicationService(WorkflowDeliveryService deliveryService,
                                      CommandValidator validator,
                                      TenantAuthorizer authorizer,
                                      CorrelationPort correlations,
                                      AuditDecorator auditDecorator,
                                      AuditPort auditPort,
                                      IdempotencyPort idempotency,
                                      MetricPort metrics,
                                      TimeProvider clock) {
        this.deliveryService = deliveryService;
        this.validator = validator == null ? new CommandValidator(correlations) : validator;
        this.authorizer = authorizer;
        this.correlations = correlations;
        this.auditDecorator = auditDecorator;
        this.auditPort = auditPort;
        this.idempotency = idempotency;
        this.metrics = metrics;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Delivers an approved workflow event through the reused feature boundary. */
    public WorkflowDeliveryResult deliver(WorkflowDeliveryCommand command) {
        WorkflowState declaredState = command == null || command.event() == null
                ? WorkflowState.NEW : command.event().state();
        if (command == null) {
            return WorkflowDeliveryResult.rejected(WorkflowState.NEW,
                    ServiceProblem.of(ProblemCode.INVALID_INPUT, "workflow delivery command is required"));
        }
        ServiceResult<WorkflowDeliveryCommand> validation = validator.validateWorkflow(command);
        if (validation.isFailure()) {
            auditShortCircuit(command, AuditAction.WORKFLOW_DELIVERY, AuditStatus.REJECTED, validation.problems());
            return WorkflowDeliveryResult.rejected(declaredState, validation.problems());
        }

        TenantId tenantId = command.metadata().tenantId();
        ActorId actorId = command.metadata().actorId();
        WorkflowEvent event = command.event();
        String eventId = event.eventId();
        CorrelationId correlationId = resolveCorrelation(command.metadata().correlationId());

        String cacheKey = cacheKey(tenantId, eventId);
        WorkflowDeliveryResult previous = completed.get(cacheKey);
        if (previous != null) {
            countDuplicate();
            return previous;
        }
        ServiceProblem denial = authorize(tenantId, actorId, Permission.WORKFLOW_DISPATCH, eventId);
        if (denial != null) {
            auditShortCircuit(command, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, List.of(denial));
            return WorkflowDeliveryResult.rejected(event.state(), denial);
        }

        IdempotencyKey key = IdempotencyKey.of(tenantId, DELIVERY_OPERATION, eventId);
        if (idempotency != null && !idempotency.tryMarkCompleted(key)) {
            countDuplicate();
            return WorkflowDeliveryResult.duplicate(event.state(), 0);
        }

        if (deliveryService == null) {
            List<ServiceProblem> problems = List.of(ServiceProblem.of(ProblemCode.STORAGE_FAILURE,
                    "workflow delivery service is not configured", eventId));
            releaseClaim(key);
            auditShortCircuit(command, AuditAction.WORKFLOW_DELIVERY, AuditStatus.FAILED, problems);
            return WorkflowDeliveryResult.rejected(event.state(), problems);
        }

        WorkflowDeliveryResult result;
        try {
            result = deliveryService.deliver(command);
        } catch (RuntimeException failure) {
            releaseClaim(key);
            auditFailure(command, AuditAction.WORKFLOW_DELIVERY, AuditStatus.FAILED, failure);
            throw failure;
        }

        if (result == null) {
            releaseClaim(key);
            return WorkflowDeliveryResult.rejected(event.state(),
                    ServiceProblem.of(ProblemCode.STORAGE_FAILURE, "delivery returned no result", eventId));
        }
        if (result.isAccepted()) {
            completed.put(cacheKey, result);
        } else if (result.isDeadLettered()) {
            // exhausted events remain terminal; keep the claim so they are not redelivered
            completed.put(cacheKey, result);
        } else {
            releaseClaim(key);
            if (!result.isRetryable() && !result.isDuplicate()) {
                // The feature coordinator audits retryable and dead-lettered attempts; a plain
                // state or route rejection never reached its audit seam, so record it here.
                auditOutcome(command, result, correlationId);
            }
        }
        return result;
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof WorkflowDeliveryCommand command) {
            return deliver(command);
        }
        throw new IllegalArgumentException("Expected a WorkflowDeliveryCommand but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** @return the reused workflow delivery feature boundary, or {@code null} when unconfigured. */
    public WorkflowDeliveryService deliveryService() {
        return deliveryService;
    }

    /** @return the identity/state validator backing this service. */
    public CommandValidator validator() {
        return validator;
    }

    /** @return the audit decorator backing this service, or {@code null} when unconfigured. */
    public AuditDecorator auditDecorator() {
        return auditDecorator;
    }

    private ServiceProblem authorize(TenantId tenantId, ActorId actorId, Permission permission, String subjectId) {
        if (authorizer == null) {
            return null;
        }
        TenantScope scope = TenantScope.of(tenantId, actorId, Set.of(), Set.of(), null);
        AuthorizationDecision decision = authorizer.authorize(scope, permission, subjectId);
        if (decision == null) {
            return ServiceProblem.of(ProblemCode.TENANT_DENIED, "authorizer returned no decision", subjectId);
        }
        if (decision.isDenied()) {
            String reason = decision.reason() == null || decision.reason().isBlank()
                    ? "workflow dispatch denied" : decision.reason();
            return ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, subjectId);
        }
        return null;
    }

    private void auditOutcome(WorkflowDeliveryCommand command, WorkflowDeliveryResult result,
                              CorrelationId correlationId) {
        Map<String, String> details = new LinkedHashMap<>();
        if (command.event() != null && command.event().eventId() != null) {
            details.put("eventId", command.event().eventId());
        }
        details.put("attempt", Integer.toString(result.attemptNumber()));
        details.put("finalState", result.finalState() == null ? "" : result.finalState().name());
        details.put("deliveryStatus", result.status().name());
        if (result.hasProblems()) {
            details.put("problemCode", result.firstProblem().code().name());
            details.put("problem", result.firstProblem().message());
        }
        TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
        ActorId actorId = command.metadata() == null ? null : command.metadata().actorId();
        writeAudit(tenantId, actorId, AuditAction.WORKFLOW_DELIVERY, AuditStatus.REJECTED, correlationId, details);
    }

    private void auditShortCircuit(WorkflowDeliveryCommand command, AuditAction action, AuditStatus status,
                                   List<ServiceProblem> problems) {
        TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
        ActorId actorId = command.metadata() == null ? null : command.metadata().actorId();
        CorrelationId correlationId = command.metadata() == null ? null : command.metadata().correlationId();
        String eventId = command.event() == null ? null : command.event().eventId();
        Map<String, String> details = new LinkedHashMap<>();
        if (eventId != null) {
            details.put("eventId", eventId);
        }
        if (problems != null && !problems.isEmpty()) {
            details.put("problemCode", problems.get(0).code().name());
            details.put("problem", problems.get(0).message());
        }
        writeAudit(tenantId, actorId, action, status, correlationId, details);
    }

    private void auditFailure(WorkflowDeliveryCommand command, AuditAction action, AuditStatus status,
                              RuntimeException failure) {
        TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
        ActorId actorId = command.metadata() == null ? null : command.metadata().actorId();
        CorrelationId correlationId = command.metadata() == null ? null : command.metadata().correlationId();
        Map<String, String> details = new LinkedHashMap<>();
        if (command.event() != null && command.event().eventId() != null) {
            details.put("eventId", command.event().eventId());
        }
        details.put("error", failure.getClass().getName());
        if (failure.getMessage() != null) {
            details.put("message", failure.getMessage());
        }
        writeAudit(tenantId, actorId, action, status, correlationId, details);
    }

    private void writeAudit(TenantId tenantId, ActorId actorId, AuditAction action, AuditStatus status,
                            CorrelationId correlationId, Map<String, String> details) {
        if (auditPort == null || tenantId == null) {
            return;
        }
        Map<String, String> enriched = new LinkedHashMap<>(details == null ? Map.of() : details);
        if (correlationId != null) {
            enriched.put("correlationId", correlationId.value());
        }
        AuditEntry entry;
        if (auditDecorator != null) {
            entry = auditDecorator.entryFor(
                    new AuditDecorator.AuditScope(tenantId, actorId == null ? null : actorId.value(), action, correlationId),
                    status, enriched);
        } else {
            entry = new AuditEntry(tenantId, actorId == null ? null : actorId.value(), action, status,
                    correlationId, clock.now(), enriched);
        }
        try {
            auditPort.append(entry);
        } catch (RuntimeException ignored) {
            // audit failures on the orchestration short-circuit path must not mask the problem
        }
    }

    private CorrelationId resolveCorrelation(CorrelationId inbound) {
        return validator.resolveCorrelation(inbound);
    }

    private void releaseClaim(IdempotencyKey key) {
        if (idempotency != null) {
            idempotency.remove(key);
        }
    }

    private void countDuplicate() {
        if (metrics != null) {
            try {
                metrics.increment("workflow.application.duplicate");
            } catch (RuntimeException ignored) {
                // telemetry is best-effort
            }
        }
    }

    private static String cacheKey(TenantId tenantId, String eventId) {
        return (tenantId == null ? "" : tenantId.value()) + '\u001f' + (eventId == null ? "" : eventId);
    }
}
