package com.example.assetupgrade.application;

import com.example.assetupgrade.attachment.AttachmentIntakeCommand;
import com.example.assetupgrade.attachment.AttachmentIntakeResult;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ServiceResult;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.observability.CorrelationPort;
import com.example.assetupgrade.observability.LogContext;
import com.example.assetupgrade.observability.TelemetryContext;
import com.example.assetupgrade.order.OrderCommand;
import com.example.assetupgrade.order.OrderResult;
import com.example.assetupgrade.reconciliation.ReconciliationCommand;
import com.example.assetupgrade.reconciliation.ReconciliationReport;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;
import com.example.assetupgrade.workflow.WorkflowDeliveryResult;

/**
 * Public façade over the four application use-case services and the lifecycle coordinator.
 *
 * <p>The façade resolves the correlation identity once through the configured
 * {@link CorrelationPort}, binds the orchestration-level {@link LogContext} and
 * {@link TelemetryContext}, and dispatches each command to the matching application
 * service. It never re-implements a feature rule; every tenant, state, idempotency and
 * audit decision belongs to the service it delegates to.</p>
 */
public final class AssetUpgradeApplication {

    private final AttachmentApplicationService attachmentService;
    private final WorkflowApplicationService workflowService;
    private final OrderApplicationService orderService;
    private final ReconciliationApplicationService reconciliationService;
    private final AssetLifecycleCoordinator coordinator;
    private final CorrelationPort correlations;

    /** Creates an unconfigured façade. */
    public AssetUpgradeApplication() {
        this(null, null, null, null, null, null);
    }

    /** Creates the façade over the four application use-case services. */
    public AssetUpgradeApplication(AttachmentApplicationService attachmentService,
                                   WorkflowApplicationService workflowService,
                                   OrderApplicationService orderService,
                                   ReconciliationApplicationService reconciliationService) {
        this(attachmentService, workflowService, orderService, reconciliationService, null, null);
    }

    /** Creates the façade with an explicit lifecycle coordinator and correlation port. */
    public AssetUpgradeApplication(AttachmentApplicationService attachmentService,
                                   WorkflowApplicationService workflowService,
                                   OrderApplicationService orderService,
                                   ReconciliationApplicationService reconciliationService,
                                   AssetLifecycleCoordinator coordinator,
                                   CorrelationPort correlations) {
        this.attachmentService = attachmentService;
        this.workflowService = workflowService;
        this.orderService = orderService;
        this.reconciliationService = reconciliationService;
        this.coordinator = coordinator;
        this.correlations = correlations;
    }

    /** Delegates an attachment intake command to the attachment application service. */
    public AttachmentIntakeResult intake(AttachmentIntakeCommand command) {
        requireAttachment();
        return attachmentService.intake(command);
    }

    /** Delegates a workflow delivery command to the workflow application service. */
    public WorkflowDeliveryResult deliver(WorkflowDeliveryCommand command) {
        requireWorkflow();
        return workflowService.deliver(command);
    }

    /** Delegates an order submission command to the order application service. */
    public OrderResult submit(OrderCommand command) {
        requireOrder();
        return orderService.submit(command);
    }

    /** Delegates a reconciliation run command to the reconciliation application service. */
    public ReconciliationReport reconcile(ReconciliationCommand command) {
        requireReconciliation();
        return reconciliationService.run(command);
    }

    /** Alias of {@link #intake(AttachmentIntakeCommand)}. */
    public AttachmentIntakeResult intakeAttachment(AttachmentIntakeCommand command) {
        return intake(command);
    }

    /** Alias of {@link #deliver(WorkflowDeliveryCommand)}. */
    public WorkflowDeliveryResult deliverWorkflow(WorkflowDeliveryCommand command) {
        return deliver(command);
    }

    /** Alias of {@link #submit(OrderCommand)}. */
    public OrderResult submitOrder(OrderCommand command) {
        return submit(command);
    }

    /** Alias of {@link #reconcile(ReconciliationCommand)}. */
    public ReconciliationReport runReconciliation(ReconciliationCommand command) {
        return reconcile(command);
    }

    /** Alias of {@link #execute(Object)}. */
    public Object handle(Object input) {
        return execute(input);
    }

    /** Validates and sequences a command through the cross-domain coordinator. */
    public ServiceResult<Object> orchestrate(Object input) {
        if (coordinator == null) {
            return ServiceResult.failure(com.example.assetupgrade.common.ServiceProblem.of(
                    com.example.assetupgrade.common.ProblemCode.INVALID_INPUT,
                    "asset lifecycle coordinator is not configured"));
        }
        return coordinator.coordinate(input);
    }

    /** Dispatches a command to the matching application use case. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return intake(command);
        }
        if (input instanceof WorkflowDeliveryCommand command) {
            return deliver(command);
        }
        if (input instanceof OrderCommand command) {
            return submit(command);
        }
        if (input instanceof ReconciliationCommand command) {
            return reconcile(command);
        }
        if (input instanceof CommandMetadata metadata) {
            AssetLifecycleCoordinator lifecycle = coordinator;
            if (lifecycle == null) {
                throw new IllegalStateException("asset lifecycle coordinator is not configured");
            }
            return lifecycle.coordinate(metadata);
        }
        throw new IllegalArgumentException("Unsupported application input: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Resolves the correlation identity to propagate for {@code metadata}. */
    public CorrelationId correlationFor(CommandMetadata metadata) {
        CorrelationId inbound = metadata == null ? null : metadata.correlationId();
        if (correlations == null) {
            return inbound;
        }
        try {
            CorrelationId resolved = correlations.resolve(inbound);
            return resolved == null ? inbound : resolved;
        } catch (RuntimeException ignored) {
            return inbound;
        }
    }

    /** Builds the orchestration log context for {@code metadata}. */
    public LogContext logContextFor(CommandMetadata metadata) {
        TenantId tenantId = metadata == null ? null : metadata.tenantId();
        return LogContext.of(correlationFor(metadata), tenantId);
    }

    /** Builds the orchestration telemetry context for {@code metadata} and {@code marker}. */
    public TelemetryContext telemetryContextFor(CommandMetadata metadata, String marker) {
        TenantId tenantId = metadata == null ? null : metadata.tenantId();
        TelemetryContext context = TelemetryContext.of(marker, java.util.Map.of());
        CorrelationId correlationId = correlationFor(metadata);
        if (correlationId != null) {
            context = context.withAttribute("correlationId", correlationId.value());
        }
        if (tenantId != null) {
            context = context.withAttribute("tenantId", tenantId.value());
        }
        return context;
    }

    /** @return the attachment application service, or {@code null} when unconfigured. */
    public AttachmentApplicationService attachmentService() {
        return attachmentService;
    }

    /** @return the workflow application service, or {@code null} when unconfigured. */
    public WorkflowApplicationService workflowService() {
        return workflowService;
    }

    /** @return the order application service, or {@code null} when unconfigured. */
    public OrderApplicationService orderService() {
        return orderService;
    }

    /** @return the reconciliation application service, or {@code null} when unconfigured. */
    public ReconciliationApplicationService reconciliationService() {
        return reconciliationService;
    }

    /** @return the cross-domain lifecycle coordinator, or {@code null} when unconfigured. */
    public AssetLifecycleCoordinator coordinator() {
        return coordinator;
    }

    private void requireAttachment() {
        if (attachmentService == null) {
            throw new IllegalStateException("attachment application service is not configured");
        }
    }

    private void requireWorkflow() {
        if (workflowService == null) {
            throw new IllegalStateException("workflow application service is not configured");
        }
    }

    private void requireOrder() {
        if (orderService == null) {
            throw new IllegalStateException("order application service is not configured");
        }
    }

    private void requireReconciliation() {
        if (reconciliationService == null) {
            throw new IllegalStateException("reconciliation application service is not configured");
        }
    }
}
