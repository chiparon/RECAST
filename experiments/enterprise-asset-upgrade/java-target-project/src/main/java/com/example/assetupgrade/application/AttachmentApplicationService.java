package com.example.assetupgrade.application;

import com.example.assetupgrade.attachment.AttachmentIntakeCommand;
import com.example.assetupgrade.attachment.AttachmentIntakeResult;
import com.example.assetupgrade.attachment.AttachmentIntakeService;
import com.example.assetupgrade.attachment.AttachmentState;
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

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Application use case for tenant-aware attachment intake and release.
 *
 * <p>Composes the reused {@link AttachmentIntakeService} behind the application boundary:
 * the command is validated for tenant/actor/correlation identity, the tenant-qualified
 * idempotency key is checked so a repeated command returns the stored outcome without a
 * second side effect or audit record, authorisation is confirmed through the security
 * ports, and the feature service owns every quarantine, signature, size and release
 * decision. The application layer never synthesises an approval event for an unscanned,
 * rejected, cross-tenant, unsafe, oversized or signature-mismatched attachment.</p>
 */
public final class AttachmentApplicationService {

    /** Application-level idempotency operation for attachment intake. */
    public static final String INTAKE_OPERATION = "application.attachment.intake";
    /** Application-level idempotency operation for attachment release. */
    public static final String RELEASE_OPERATION = "application.attachment.release";

    private final AttachmentIntakeService intakeService;
    private final CommandValidator validator;
    private final TenantAuthorizer authorizer;
    private final CorrelationPort correlations;
    private final AuditDecorator auditDecorator;
    private final AuditPort auditPort;
    private final IdempotencyPort idempotency;
    private final MetricPort metrics;
    private final TimeProvider clock;

    private final ConcurrentHashMap<String, AttachmentIntakeResult> completed = new ConcurrentHashMap<>();

    /** Creates an unconfigured service; every intake fails closed. */
    public AttachmentApplicationService() {
        this(null, null, null, null, null, null, null, null, null);
    }

    /** Creates the service over the reused attachment intake feature boundary. */
    public AttachmentApplicationService(AttachmentIntakeService intakeService) {
        this(intakeService, null, null, null, null, null, null, null, null);
    }

    /** Creates the service with the identity, correlation and audit collaborators. */
    public AttachmentApplicationService(AttachmentIntakeService intakeService,
                                        CommandValidator validator,
                                        TenantAuthorizer authorizer,
                                        CorrelationPort correlations,
                                        AuditDecorator auditDecorator) {
        this(intakeService, validator, authorizer, correlations, auditDecorator, null, null, null, null);
    }

    /** Creates the service with the full collaborator set. */
    public AttachmentApplicationService(AttachmentIntakeService intakeService,
                                        CommandValidator validator,
                                        TenantAuthorizer authorizer,
                                        CorrelationPort correlations,
                                        AuditDecorator auditDecorator,
                                        AuditPort auditPort,
                                        IdempotencyPort idempotency,
                                        MetricPort metrics,
                                        TimeProvider clock) {
        this.intakeService = intakeService;
        this.validator = validator == null ? new CommandValidator(correlations) : validator;
        this.authorizer = authorizer;
        this.correlations = correlations;
        this.auditDecorator = auditDecorator;
        this.auditPort = auditPort;
        this.idempotency = idempotency;
        this.metrics = metrics;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Accepts and processes an attachment submission through the feature boundary. */
    public AttachmentIntakeResult intake(AttachmentIntakeCommand command) {
        if (command == null) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment intake command is required"));
        }
        ServiceResult<AttachmentIntakeCommand> validation = validator.validateAttachment(command);
        if (validation.isFailure()) {
            deny(command, AuditAction.ATTACHMENT_INTAKE, AuditStatus.REJECTED, validation.problems());
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED, null, validation.problems());
        }

        TenantId tenantId = command.tenantId();
        ActorId actorId = command.actorId();
        String attachmentId = command.attachmentId();
        CorrelationId correlationId = resolveCorrelation(command.correlationId());

        String cacheKey = cacheKey(tenantId, attachmentId);
        AttachmentIntakeResult previous = completed.get(cacheKey);
        if (previous != null) {
            countDuplicate();
            return previous;
        }
        ServiceProblem denial = authorize(tenantId, actorId, Permission.ATTACHMENT_SUBMIT, attachmentId);
        if (denial != null) {
            audit(tenantId, actorId, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, correlationId, attachmentId,
                    Map.of("reason", denial.message()));
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED, denial);
        }

        IdempotencyKey key = IdempotencyKey.of(tenantId, INTAKE_OPERATION, attachmentId);
        if (idempotency != null && !idempotency.tryMarkCompleted(key)) {
            countDuplicate();
            return AttachmentIntakeResult.duplicate(AttachmentState.RELEASED, null);
        }

        if (intakeService == null) {
            List<ServiceProblem> problems = List.of(ServiceProblem.of(ProblemCode.STORAGE_FAILURE,
                    "attachment intake service is not configured", attachmentId));
            releaseClaim(key);
            audit(tenantId, actorId, AuditAction.ATTACHMENT_INTAKE, AuditStatus.FAILED, correlationId, attachmentId,
                    Map.of("reason", "intake service is not configured"));
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED, null, problems);
        }

        AttachmentIntakeResult result;
        try {
            result = intakeService.intake(command);
        } catch (RuntimeException failure) {
            releaseClaim(key);
            auditFailure(tenantId, actorId, AuditAction.ATTACHMENT_INTAKE, AuditStatus.FAILED, correlationId,
                    attachmentId, failure);
            throw failure;
        }

        if (result != null && result.isAccepted()) {
            completed.put(cacheKey, result);
        } else {
            releaseClaim(key);
        }
        return result == null
                ? AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                        ServiceProblem.of(ProblemCode.STORAGE_FAILURE, "intake returned no result", attachmentId))
                : result;
    }

    /** Releases an already cleanly scanned attachment for the owning tenant. */
    public AttachmentIntakeResult release(TenantId tenantId, ActorId actorId, String attachmentId,
                                          CorrelationId correlationId) {
        if (tenantId == null || actorId == null || attachmentId == null || attachmentId.isBlank()) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.INVALID_INPUT, "tenant, actor and attachment id are required"));
        }
        CorrelationId resolved = resolveCorrelation(correlationId);
        ServiceProblem denial = authorize(tenantId, actorId, Permission.ATTACHMENT_RELEASE, attachmentId);
        if (denial != null) {
            audit(tenantId, actorId, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, resolved, attachmentId,
                    Map.of("reason", denial.message()));
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED, denial);
        }
        if (intakeService == null) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.STORAGE_FAILURE, "attachment intake service is not configured", attachmentId));
        }
        return intakeService.release(tenantId, actorId, attachmentId, resolved);
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return intake(command);
        }
        if (input instanceof ReleaseRequest request) {
            return release(request.tenantId(), request.actorId(), request.attachmentId(), request.correlationId());
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** @return the reused attachment intake feature boundary, or {@code null} when unconfigured. */
    public AttachmentIntakeService intakeService() {
        return intakeService;
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
                    ? "attachment operation denied" : decision.reason();
            return ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, subjectId);
        }
        return null;
    }

    private void deny(AttachmentIntakeCommand command, AuditAction action, AuditStatus status,
                      List<ServiceProblem> problems) {
        Map<String, String> details = new LinkedHashMap<>();
        if (command.attachmentId() != null) {
            details.put("attachmentId", command.attachmentId());
        }
        if (problems != null && !problems.isEmpty()) {
            ServiceProblem first = problems.get(0);
            details.put("problemCode", first.code().name());
            details.put("problem", first.message());
        }
        audit(command.tenantId(), command.actorId(), action, status, command.correlationId(), command.attachmentId(), details);
    }

    private void audit(TenantId tenantId, ActorId actorId, AuditAction action, AuditStatus status,
                       CorrelationId correlationId, String subjectId, Map<String, String> details) {
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

    private void auditFailure(TenantId tenantId, ActorId actorId, AuditAction action, AuditStatus status,
                              CorrelationId correlationId, String subjectId, RuntimeException failure) {
        Map<String, String> details = new LinkedHashMap<>();
        if (subjectId != null) {
            details.put("attachmentId", subjectId);
        }
        details.put("error", failure.getClass().getName());
        if (failure.getMessage() != null) {
            details.put("message", failure.getMessage());
        }
        audit(tenantId, actorId, action, status, correlationId, subjectId, details);
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
                metrics.increment("attachment.application.duplicate");
            } catch (RuntimeException ignored) {
                // telemetry is best-effort
            }
        }
    }

    private static String cacheKey(TenantId tenantId, String attachmentId) {
        return (tenantId == null ? "" : tenantId.value()) + '\u001f' + (attachmentId == null ? "" : attachmentId);
    }

    /** Carrier for the release use case dispatched through {@link #execute(Object)}. */
    public record ReleaseRequest(TenantId tenantId, ActorId actorId, String attachmentId, CorrelationId correlationId) {
    }
}
