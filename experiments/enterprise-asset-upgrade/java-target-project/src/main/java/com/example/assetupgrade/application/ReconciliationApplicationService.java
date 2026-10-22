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
import com.example.assetupgrade.reconciliation.ReconciliationCommand;
import com.example.assetupgrade.reconciliation.ReconciliationReport;
import com.example.assetupgrade.reconciliation.ReconciliationService;
import com.example.assetupgrade.reconciliation.ReconciliationTenantFilter;
import com.example.assetupgrade.security.AuthorizationDecision;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantScope;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Application use case for periodic, tenant-scoped reconciliation.
 *
 * <p>Composes the reused {@link ReconciliationService}. The run authorises the actor for
 * {@link Permission#RECONCILIATION_RUN}, then the feature orchestrator acquires the
 * tenant/job lease, reads only events whose retry window has elapsed and whose retry budget
 * is still open, dispatches them through the workflow boundary, closes or increments the
 * retry records and persists the checkpoint. A successful run and an empty run both leave
 * exactly one audit entry, and no read or mutation ever crosses the command tenant. The
 * scheduler adapter (Quartz or otherwise) stays outside this layer.</p>
 */
public final class ReconciliationApplicationService {

    private final ReconciliationService reconciliationService;
    private final CommandValidator validator;
    private final TenantAuthorizer authorizer;
    private final CorrelationPort correlations;
    private final AuditDecorator auditDecorator;
    private final AuditPort auditPort;
    private final MetricPort metrics;
    private final TimeProvider clock;

    private final ReconciliationTenantFilter tenantFilter = new ReconciliationTenantFilter();

    /** Creates an unconfigured service; every run fails closed. */
    public ReconciliationApplicationService() {
        this(null, null, null, null, null, null, null, null);
    }

    /** Creates the service over the reused reconciliation feature boundary. */
    public ReconciliationApplicationService(ReconciliationService reconciliationService) {
        this(reconciliationService, null, null, null, null, null, null, null);
    }

    /** Creates the service with the identity, correlation and audit collaborators. */
    public ReconciliationApplicationService(ReconciliationService reconciliationService,
                                            CommandValidator validator,
                                            TenantAuthorizer authorizer,
                                            CorrelationPort correlations,
                                            AuditDecorator auditDecorator) {
        this(reconciliationService, validator, authorizer, correlations, auditDecorator, null, null, null);
    }

    /** Creates the service with the full collaborator set. */
    public ReconciliationApplicationService(ReconciliationService reconciliationService,
                                            CommandValidator validator,
                                            TenantAuthorizer authorizer,
                                            CorrelationPort correlations,
                                            AuditDecorator auditDecorator,
                                            AuditPort auditPort,
                                            MetricPort metrics,
                                            TimeProvider clock) {
        this.reconciliationService = reconciliationService;
        this.validator = validator == null ? new CommandValidator(correlations) : validator;
        this.authorizer = authorizer;
        this.correlations = correlations;
        this.auditDecorator = auditDecorator;
        this.auditPort = auditPort;
        this.metrics = metrics;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Runs one reconciliation window through the reused feature boundary. */
    public ReconciliationReport run(ReconciliationCommand command) {
        if (command == null) {
            auditEmpty(null, null, null, null, AuditStatus.FAILED, "reconciliation command is required");
            return emptyReport();
        }
        ServiceResult<ReconciliationCommand> validation = validator.validateReconciliation(command);
        if (validation.isFailure()) {
            auditEmpty(command, AuditStatus.REJECTED, validation.problems());
            return emptyReport();
        }

        TenantId tenantId = command.metadata().tenantId();
        ActorId actorId = command.metadata().actorId();
        CorrelationId correlationId = resolveCorrelation(command.metadata().correlationId());
        String jobName = tenantFilter.jobNameOf(command);

        ServiceProblem denial = authorize(tenantId, actorId, Permission.RECONCILIATION_RUN, jobName);
        if (denial != null) {
            Map<String, String> details = new LinkedHashMap<>();
            details.put("job", jobName);
            details.put("reason", denial.message());
            writeAudit(tenantId, actorId, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, correlationId, details);
            return emptyReport();
        }

        if (reconciliationService == null) {
            Map<String, String> details = new LinkedHashMap<>();
            details.put("job", jobName);
            details.put("reason", "reconciliation service is not configured");
            writeAudit(tenantId, actorId, AuditAction.RECONCILIATION_RUN, AuditStatus.FAILED, correlationId, details);
            return emptyReport();
        }

        ReconciliationReport report;
        try {
            report = reconciliationService.run(command);
        } catch (RuntimeException failure) {
            Map<String, String> details = new LinkedHashMap<>();
            details.put("job", jobName);
            details.put("error", failure.getClass().getName());
            if (failure.getMessage() != null) {
                details.put("message", failure.getMessage());
            }
            writeAudit(tenantId, actorId, AuditAction.RECONCILIATION_RUN, AuditStatus.FAILED, correlationId, details);
            throw failure;
        }
        if (report == null) {
            report = emptyReport();
        }
        return report;
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof ReconciliationCommand command) {
            return run(command);
        }
        throw new IllegalArgumentException("Expected a ReconciliationCommand but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** @return the reused reconciliation feature boundary, or {@code null} when unconfigured. */
    public ReconciliationService reconciliationService() {
        return reconciliationService;
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
                    ? "reconciliation run denied" : decision.reason();
            return ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, subjectId);
        }
        return null;
    }

    private void auditEmpty(ReconciliationCommand command, AuditStatus status, List<ServiceProblem> problems) {
        TenantId tenantId = command == null || command.metadata() == null ? null : command.metadata().tenantId();
        ActorId actorId = command == null || command.metadata() == null ? null : command.metadata().actorId();
        CorrelationId correlationId = command == null || command.metadata() == null ? null : command.metadata().correlationId();
        String jobName = tenantFilter.jobNameOf(command);
        Map<String, String> details = new LinkedHashMap<>();
        details.put("job", jobName);
        if (problems != null && !problems.isEmpty()) {
            details.put("problemCode", problems.get(0).code().name());
            details.put("problem", problems.get(0).message());
        }
        writeAudit(tenantId, actorId, AuditAction.RECONCILIATION_RUN, status, correlationId, details);
    }

    private void auditEmpty(TenantId tenantId, ActorId actorId, CorrelationId correlationId, String jobName,
                            AuditStatus status, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        if (jobName != null) {
            details.put("job", jobName);
        }
        if (reason != null) {
            details.put("reason", reason);
        }
        writeAudit(tenantId, actorId, AuditAction.RECONCILIATION_RUN, status, correlationId, details);
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

    private static ReconciliationReport emptyReport() {
        return new ReconciliationReport(0, 0, 0, 0, List.of(), null);
    }
}
