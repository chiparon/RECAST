package com.example.assetupgrade.application;

import com.example.assetupgrade.attachment.AttachmentIntakeCommand;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.OperationContext;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.ServiceResult;
import com.example.assetupgrade.order.OrderCommand;
import com.example.assetupgrade.reconciliation.ReconciliationCommand;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;

/**
 * Cross-domain sequencer for the asset-upgrade orchestration chain.
 *
 * <p>Verifies that one consistent tenant/actor/correlation identity is carried across the
 * attachment, workflow, order and reconciliation use cases, then delegates every feature
 * decision to the corresponding application service. No feature policy is duplicated here:
 * the coordinator only enforces identity and state preconditions and converts a failed
 * precondition into a {@link ServiceResult} carrying a typed {@link ServiceProblem}.</p>
 */
public final class AssetLifecycleCoordinator {

    private final AttachmentApplicationService attachmentService;
    private final WorkflowApplicationService workflowService;
    private final OrderApplicationService orderService;
    private final ReconciliationApplicationService reconciliationService;
    private final CommandValidator validator;

    /** Creates an unconfigured coordinator. */
    public AssetLifecycleCoordinator() {
        this(null, null, null, null, null);
    }

    /** Creates the coordinator over the four application use-case services. */
    public AssetLifecycleCoordinator(AttachmentApplicationService attachmentService,
                                     WorkflowApplicationService workflowService,
                                     OrderApplicationService orderService,
                                     ReconciliationApplicationService reconciliationService) {
        this(attachmentService, workflowService, orderService, reconciliationService, null);
    }

    /** Creates the coordinator with an explicit identity validator. */
    public AssetLifecycleCoordinator(AttachmentApplicationService attachmentService,
                                     WorkflowApplicationService workflowService,
                                     OrderApplicationService orderService,
                                     ReconciliationApplicationService reconciliationService,
                                     CommandValidator validator) {
        this.attachmentService = attachmentService;
        this.workflowService = workflowService;
        this.orderService = orderService;
        this.reconciliationService = reconciliationService;
        this.validator = validator == null ? new CommandValidator() : validator;
    }

    /** Validates the identity carried by {@code metadata} and returns it on success. */
    public ServiceResult<CommandMetadata> coordinate(CommandMetadata metadata) {
        ServiceResult<CommandMetadata> validated = validator.validateMetadata(metadata);
        return validated.isSuccess() ? ServiceResult.success(metadata) : ServiceResult.failure(validated.problems());
    }

    /** Validates the identity carried by {@code context} and returns it on success. */
    public ServiceResult<OperationContext> coordinate(OperationContext context) {
        if (context == null) {
            return ServiceResult.failure(ServiceProblem.of(ProblemCode.INVALID_INPUT, "operation context is required"));
        }
        ServiceResult<CommandMetadata> validated = validator.validateMetadata(context.metadata());
        return validated.isSuccess() ? ServiceResult.success(context) : ServiceResult.failure(validated.problems());
    }

    /** Dispatches a command to the matching use-case service, wrapping the outcome as a result. */
    public ServiceResult<Object> coordinate(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            ServiceResult<AttachmentIntakeCommand> identity = validator.validateAttachment(command);
            return identity.isSuccess()
                    ? ServiceResult.success(requireAttachment().intake(command))
                    : ServiceResult.failure(identity.problems());
        }
        if (input instanceof WorkflowDeliveryCommand command) {
            ServiceResult<WorkflowDeliveryCommand> identity = validator.validateWorkflow(command);
            return identity.isSuccess()
                    ? ServiceResult.success(requireWorkflow().deliver(command))
                    : ServiceResult.failure(identity.problems());
        }
        if (input instanceof OrderCommand command) {
            ServiceResult<OrderCommand> identity = validator.validateOrder(command);
            return identity.isSuccess()
                    ? ServiceResult.success(requireOrder().submit(command))
                    : ServiceResult.failure(identity.problems());
        }
        if (input instanceof ReconciliationCommand command) {
            ServiceResult<ReconciliationCommand> identity = validator.validateReconciliation(command);
            return identity.isSuccess()
                    ? ServiceResult.success(requireReconciliation().run(command))
                    : ServiceResult.failure(identity.problems());
        }
        return ServiceResult.failure(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                "unsupported orchestration input: " + (input == null ? "null" : input.getClass().getName())));
    }

    /** Compatibility seam for early implementations; {@link #coordinate(Object)} is preferred. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return requireAttachment().intake(command);
        }
        if (input instanceof WorkflowDeliveryCommand command) {
            return requireWorkflow().deliver(command);
        }
        if (input instanceof OrderCommand command) {
            return requireOrder().submit(command);
        }
        if (input instanceof ReconciliationCommand command) {
            return requireReconciliation().run(command);
        }
        throw new IllegalArgumentException("Unsupported orchestration input: "
                + (input == null ? "null" : input.getClass().getName()));
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

    private AttachmentApplicationService requireAttachment() {
        if (attachmentService == null) {
            throw new IllegalStateException("attachment application service is not configured");
        }
        return attachmentService;
    }

    private WorkflowApplicationService requireWorkflow() {
        if (workflowService == null) {
            throw new IllegalStateException("workflow application service is not configured");
        }
        return workflowService;
    }

    private OrderApplicationService requireOrder() {
        if (orderService == null) {
            throw new IllegalStateException("order application service is not configured");
        }
        return orderService;
    }

    private ReconciliationApplicationService requireReconciliation() {
        if (reconciliationService == null) {
            throw new IllegalStateException("reconciliation application service is not configured");
        }
        return reconciliationService;
    }
}
