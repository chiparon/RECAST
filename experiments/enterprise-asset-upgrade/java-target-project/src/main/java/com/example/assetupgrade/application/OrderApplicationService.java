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
import com.example.assetupgrade.order.OrderCommand;
import com.example.assetupgrade.order.OrderPluginBridge;
import com.example.assetupgrade.order.OrderResult;
import com.example.assetupgrade.order.OrderStatus;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.security.AuthorizationDecision;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantScope;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Application use case for the tenant-aware order-plugin bridge.
 *
 * <p>Composes the reused {@link OrderPluginBridge}. The command and every order line are
 * validated before inventory is touched; plugin capability resolution, reservation,
 * inventory policy, pricing, payment and the commit/rollback sequencing stay in the
 * feature coordinator. This layer closes tenant, actor, correlation, idempotency and audit
 * handling: a duplicate tenant-scoped command returns the stored outcome without reserving
 * or committing again, and a failed commit leaves the idempotency claim removed so a later
 * retry can proceed. The commit and audit evidence are executed inside the injected
 * {@link TransactionPort} boundary when one is configured.</p>
 */
public final class OrderApplicationService {

    /** Application-level idempotency operation for order submission. */
    public static final String SUBMISSION_OPERATION = "application.order.submit";

    private final OrderPluginBridge orderBridge;
    private final CommandValidator validator;
    private final TenantAuthorizer authorizer;
    private final CorrelationPort correlations;
    private final AuditDecorator auditDecorator;
    private final AuditPort auditPort;
    private final IdempotencyPort idempotency;
    private final TransactionPort transaction;
    private final MetricPort metrics;
    private final TimeProvider clock;

    private final ConcurrentHashMap<String, OrderResult> completed = new ConcurrentHashMap<>();

    /** Creates an unconfigured service; every submission fails closed. */
    public OrderApplicationService() {
        this(null, null, null, null, null, null, null, null, null, null);
    }

    /** Creates the service over the reused order-plugin feature boundary. */
    public OrderApplicationService(OrderPluginBridge orderBridge) {
        this(orderBridge, null, null, null, null, null, null, null, null, null);
    }

    /** Creates the service with the identity, correlation and audit collaborators. */
    public OrderApplicationService(OrderPluginBridge orderBridge,
                                   CommandValidator validator,
                                   TenantAuthorizer authorizer,
                                   CorrelationPort correlations,
                                   AuditDecorator auditDecorator) {
        this(orderBridge, validator, authorizer, correlations, auditDecorator, null, null, null, null, null);
    }

    /** Creates the service with the full collaborator set. */
    public OrderApplicationService(OrderPluginBridge orderBridge,
                                   CommandValidator validator,
                                   TenantAuthorizer authorizer,
                                   CorrelationPort correlations,
                                   AuditDecorator auditDecorator,
                                   AuditPort auditPort,
                                   IdempotencyPort idempotency,
                                   TransactionPort transaction,
                                   MetricPort metrics,
                                   TimeProvider clock) {
        this.orderBridge = orderBridge;
        this.validator = validator == null ? new CommandValidator(correlations) : validator;
        this.authorizer = authorizer;
        this.correlations = correlations;
        this.auditDecorator = auditDecorator;
        this.auditPort = auditPort;
        this.idempotency = idempotency;
        this.transaction = transaction;
        this.metrics = metrics;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Submits an order through the reused feature boundary. */
    public OrderResult submit(OrderCommand command) {
        if (command == null) {
            return OrderResult.rejected(ServiceProblem.of(ProblemCode.INVALID_INPUT, "order command is required"));
        }
        ServiceResult<OrderCommand> validation = validator.validateOrder(command);
        if (validation.isFailure()) {
            auditShortCircuit(command, AuditAction.ORDER_SUBMISSION, AuditStatus.REJECTED, validation.problems());
            return OrderResult.rejected(validation.problems());
        }

        TenantId tenantId = command.tenantId();
        ActorId actorId = command.metadata().actorId();
        String orderId = command.orderId();
        CorrelationId correlationId = resolveCorrelation(command.metadata().correlationId());

        String cacheKey = cacheKey(tenantId, orderId);
        OrderResult previous = completed.get(cacheKey);
        if (previous != null) {
            countDuplicate();
            return previous;
        }
        ServiceProblem denial = authorize(tenantId, actorId, Permission.ORDER_SUBMIT, orderId);
        if (denial != null) {
            auditShortCircuit(command, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, List.of(denial));
            return OrderResult.rejected(denial);
        }

        IdempotencyKey key = IdempotencyKey.of(tenantId, SUBMISSION_OPERATION, orderId);
        if (idempotency != null && !idempotency.tryMarkCompleted(key)) {
            countDuplicate();
            return OrderResult.duplicate(OrderStatus.ACCEPTED, null);
        }

        if (orderBridge == null) {
            List<ServiceProblem> problems = List.of(ServiceProblem.of(ProblemCode.STORAGE_FAILURE,
                    "order plugin bridge is not configured", orderId));
            releaseClaim(key);
            auditShortCircuit(command, AuditAction.ORDER_SUBMISSION, AuditStatus.FAILED, problems);
            return OrderResult.rejected(problems);
        }

        OrderResult result;
        try {
            Supplier<OrderResult> boundary = () -> orderBridge.submit(command);
            result = transaction != null ? transaction.inTransaction(boundary) : boundary.get();
        } catch (RuntimeException failure) {
            releaseClaim(key);
            auditFailure(command, AuditAction.ORDER_SUBMISSION, AuditStatus.ROLLED_BACK, failure);
            throw failure;
        }

        if (result == null) {
            releaseClaim(key);
            return OrderResult.rejected(ServiceProblem.of(ProblemCode.STORAGE_FAILURE,
                    "order submission returned no result", orderId));
        }
        if (result.isAccepted()) {
            completed.put(cacheKey, result);
        } else {
            // A rejected or rolled-back order must remain retryable: drop the claim.
            releaseClaim(key);
            if (result.status() != OrderStatus.ROLLED_BACK) {
                // The feature coordinator audits its own rollback outcome; a plain business
                // rejection never reached the feature audit seam, so the application records it.
                auditOutcome(command, result, correlationId);
            }
        }
        return result;
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) {
            return submit(command);
        }
        throw new IllegalArgumentException("Expected an OrderCommand but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** @return the reused order-plugin feature boundary, or {@code null} when unconfigured. */
    public OrderPluginBridge orderBridge() {
        return orderBridge;
    }

    /** @return the identity/state validator backing this service. */
    public CommandValidator validator() {
        return validator;
    }

    /** @return the atomic transaction boundary, or {@code null} when unconfigured. */
    public TransactionPort transaction() {
        return transaction;
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
                    ? "order submission denied" : decision.reason();
            return ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, subjectId);
        }
        return null;
    }

    private void auditOutcome(OrderCommand command, OrderResult result, CorrelationId correlationId) {
        AuditStatus status = result.status() == OrderStatus.ROLLED_BACK ? AuditStatus.ROLLED_BACK : AuditStatus.REJECTED;
        List<ServiceProblem> problems = result.problems();
        Map<String, String> details = new LinkedHashMap<>();
        if (command.orderId() != null) {
            details.put("orderId", command.orderId());
        }
        if (result.reservationId() != null) {
            details.put("reservationId", result.reservationId());
        }
        if (!problems.isEmpty()) {
            details.put("problemCode", problems.get(0).code().name());
            details.put("problem", problems.get(0).message());
        }
        writeAudit(command.tenantId(), command.metadata().actorId(), AuditAction.ORDER_SUBMISSION, status,
                correlationId, details);
    }

    private void auditShortCircuit(OrderCommand command, AuditAction action, AuditStatus status,
                                   List<ServiceProblem> problems) {
        TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
        ActorId actorId = command.metadata() == null ? null : command.metadata().actorId();
        CorrelationId correlationId = command.metadata() == null ? null : command.metadata().correlationId();
        Map<String, String> details = new LinkedHashMap<>();
        if (command.orderId() != null) {
            details.put("orderId", command.orderId());
        }
        if (problems != null && !problems.isEmpty()) {
            details.put("problemCode", problems.get(0).code().name());
            details.put("problem", problems.get(0).message());
        }
        writeAudit(tenantId, actorId, action, status, correlationId, details);
    }

    private void auditFailure(OrderCommand command, AuditAction action, AuditStatus status, RuntimeException failure) {
        TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
        ActorId actorId = command.metadata() == null ? null : command.metadata().actorId();
        CorrelationId correlationId = command.metadata() == null ? null : command.metadata().correlationId();
        Map<String, String> details = new LinkedHashMap<>();
        if (command.orderId() != null) {
            details.put("orderId", command.orderId());
        }
        if (command.pluginId() != null) {
            details.put("pluginId", command.pluginId());
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
                metrics.increment("order.application.duplicate");
            } catch (RuntimeException ignored) {
                // telemetry is best-effort
            }
        }
    }

    private static String cacheKey(TenantId tenantId, String orderId) {
        return (tenantId == null ? "" : tenantId.value()) + '\u001f' + (orderId == null ? "" : orderId);
    }
}
