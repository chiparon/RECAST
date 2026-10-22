package com.example.assetupgrade.application;

import com.example.assetupgrade.attachment.AttachmentContent;
import com.example.assetupgrade.attachment.AttachmentIntakeCommand;
import com.example.assetupgrade.attachment.AttachmentMetadata;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.ServiceResult;
import com.example.assetupgrade.order.OrderCommand;
import com.example.assetupgrade.order.OrderLine;
import com.example.assetupgrade.order.OrderRequest;
import com.example.assetupgrade.observability.CorrelationPort;
import com.example.assetupgrade.reconciliation.ReconciliationCommand;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;
import com.example.assetupgrade.workflow.WorkflowEvent;

import java.util.ArrayList;
import java.util.List;

/**
 * Fail-closed identity, tenant, correlation and state precondition validator for the
 * application orchestrators.
 *
 * <p>This boundary decides only the preconditions an application use case must establish
 * before it delegates to a feature service: a non-null tenant and actor, a resolvable
 * correlation identity, a well-formed subject/file name and a command shape that matches
 * the requested use case. Feature-level rules - MIME and signature screening, size limits,
 * quarantine decisions, order pricing, payment and inventory policy - deliberately remain
 * in the feature validators so policy is never duplicated in the application layer.</p>
 *
 * <p>{@link #execute(Object)} keeps the historical generic entry point and converts an
 * unknown input type into a failed {@link ServiceResult} carrying a {@link ProblemCode}
 * rather than raising a raw exception.</p>
 */
public final class CommandValidator {

    /** Maximum accepted attachment file-name length, aligned with the storage policy. */
    public static final int MAX_FILENAME_LENGTH = 255;

    private final CorrelationPort correlations;

    /** Creates a validator that does not generate correlation identities. */
    public CommandValidator() {
        this(null);
    }

    /** Creates a validator resolving a missing correlation identity through {@code correlations}. */
    public CommandValidator(CorrelationPort correlations) {
        this.correlations = correlations;
    }

    /** Validates the identity metadata carried by every command. */
    public ServiceResult<CommandMetadata> validateMetadata(CommandMetadata metadata) {
        if (metadata == null) {
            return ServiceResult.failure(problem(ProblemCode.INVALID_INPUT, "command metadata is required", null));
        }
        List<ServiceProblem> problems = new ArrayList<>();
        if (metadata.tenantId() == null) {
            problems.add(problem(ProblemCode.TENANT_DENIED, "tenant id is required", null));
        }
        if (metadata.actorId() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "actor id is required", null));
        }
        if (resolveCorrelation(metadata.correlationId()) == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "correlation id could not be resolved", null));
        }
        if (metadata.receivedAt() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "receivedAt is required", null));
        }
        return problems.isEmpty() ? ServiceResult.success(metadata) : ServiceResult.failure(problems);
    }

    /** Validates an attachment intake command before it reaches the intake feature boundary. */
    public ServiceResult<AttachmentIntakeCommand> validateAttachment(AttachmentIntakeCommand command) {
        if (command == null) {
            return ServiceResult.failure(problem(ProblemCode.INVALID_INPUT, "attachment intake command is required", null));
        }
        List<ServiceProblem> problems = new ArrayList<>();
        if (command.metadata() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "command metadata is required", command.attachmentId()));
        } else {
            problems.addAll(validateMetadata(command.metadata()).problems());
        }
        AttachmentMetadata attachment = command.attachment();
        if (attachment == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "attachment metadata is required", null));
        } else {
            if (command.metadata() != null && !attachment.belongsTo(command.tenantId())) {
                problems.add(problem(ProblemCode.TENANT_DENIED,
                        "attachment tenant does not match the command tenant", attachment.attachmentId()));
            }
            problems.addAll(validateFileName(attachment.fileName(), attachment.attachmentId()));
        }
        AttachmentContent content = command.content();
        if (content == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "attachment content is required", command.attachmentId()));
        }
        return problems.isEmpty() ? ServiceResult.success(command) : ServiceResult.failure(problems);
    }

    /** Validates an order command and each order line before inventory is touched. */
    public ServiceResult<OrderCommand> validateOrder(OrderCommand command) {
        if (command == null) {
            return ServiceResult.failure(problem(ProblemCode.INVALID_INPUT, "order command is required", null));
        }
        List<ServiceProblem> problems = new ArrayList<>();
        if (command.metadata() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "command metadata is required", command.orderId()));
        } else {
            problems.addAll(validateMetadata(command.metadata()).problems());
        }
        OrderRequest order = command.order();
        if (order == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "order request is required", null));
        } else {
            if (order.orderId() == null || order.orderId().isBlank()) {
                problems.add(problem(ProblemCode.INVALID_INPUT, "order id is required", null));
            }
            if (command.metadata() != null && !order.belongsTo(command.tenantId())) {
                problems.add(problem(ProblemCode.TENANT_DENIED,
                        "order tenant does not match the command tenant", order.orderId()));
            }
            if (!order.hasLines()) {
                problems.add(problem(ProblemCode.INVALID_INPUT, "order must contain at least one line", order.orderId()));
            } else {
                problems.addAll(validateLines(order));
            }
        }
        if (command.pluginId() == null || command.pluginId().isBlank()) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "plugin id is required", command.orderId()));
        }
        return problems.isEmpty() ? ServiceResult.success(command) : ServiceResult.failure(problems);
    }

    /** Validates a workflow delivery command before the event is dispatched. */
    public ServiceResult<WorkflowDeliveryCommand> validateWorkflow(WorkflowDeliveryCommand command) {
        if (command == null) {
            return ServiceResult.failure(problem(ProblemCode.INVALID_INPUT, "workflow delivery command is required", null));
        }
        List<ServiceProblem> problems = new ArrayList<>();
        if (command.metadata() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "command metadata is required", null));
        } else {
            problems.addAll(validateMetadata(command.metadata()).problems());
        }
        WorkflowEvent event = command.event();
        if (event == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "workflow event is required", null));
        } else {
            if (event.eventId() == null || event.eventId().isBlank()) {
                problems.add(problem(ProblemCode.INVALID_INPUT, "workflow event id is required", null));
            }
            if (command.metadata() != null && event.tenantId() != null
                    && !event.tenantId().equals(command.metadata().tenantId())) {
                problems.add(problem(ProblemCode.TENANT_DENIED,
                        "workflow event tenant does not match the command tenant", event.eventId()));
            }
        }
        return problems.isEmpty() ? ServiceResult.success(command) : ServiceResult.failure(problems);
    }

    /** Validates a scheduled reconciliation command before the window is read. */
    public ServiceResult<ReconciliationCommand> validateReconciliation(ReconciliationCommand command) {
        if (command == null) {
            return ServiceResult.failure(problem(ProblemCode.INVALID_INPUT, "reconciliation command is required", null));
        }
        List<ServiceProblem> problems = new ArrayList<>();
        if (command.metadata() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "command metadata is required", null));
        } else {
            problems.addAll(validateMetadata(command.metadata()).problems());
        }
        if (command.now() == null) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "reconciliation run instant is required", null));
        }
        if (command.limit() < 0) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "reconciliation limit must not be negative", null));
        }
        return problems.isEmpty() ? ServiceResult.success(command) : ServiceResult.failure(problems);
    }

    /** Resolves the correlation identity to propagate, generating one when permitted. */
    public CorrelationId resolveCorrelation(CorrelationId inbound) {
        if (correlations != null) {
            try {
                CorrelationId resolved = correlations.resolve(inbound);
                if (resolved != null) {
                    return resolved;
                }
            } catch (RuntimeException ignored) {
                // resolution is best-effort; fall back to the inbound identity
            }
        }
        return inbound;
    }

    /**
     * Generic entry point retained from the historical contract. Dispatches on the command
     * type and always returns a {@link ServiceResult}; an unknown input is reported as a
     * failed result rather than an exception.
     */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return validateAttachment(command);
        }
        if (input instanceof OrderCommand command) {
            return validateOrder(command);
        }
        if (input instanceof WorkflowDeliveryCommand command) {
            return validateWorkflow(command);
        }
        if (input instanceof ReconciliationCommand command) {
            return validateReconciliation(command);
        }
        if (input instanceof CommandMetadata metadata) {
            return validateMetadata(metadata);
        }
        return ServiceResult.failure(problem(ProblemCode.INVALID_INPUT,
                "unsupported validation input: " + (input == null ? "null" : input.getClass().getName()), null));
    }

    /** @return {@code true} when {@code input} passes every precondition this validator checks. */
    public boolean isValid(Object input) {
        return execute(input) instanceof ServiceResult<?> result && result.isSuccess();
    }

    /** @return the problems blocking {@code input}, empty when it is valid. */
    public List<ServiceProblem> problems(Object input) {
        if (execute(input) instanceof ServiceResult<?> result) {
            return result.problems();
        }
        return List.of();
    }

    private List<ServiceProblem> validateLines(OrderRequest order) {
        List<ServiceProblem> problems = new ArrayList<>();
        int index = 0;
        for (OrderLine line : order.lines()) {
            String subject = order.orderId() == null ? null : order.orderId() + "#" + index;
            if (line == null) {
                problems.add(problem(ProblemCode.INVALID_INPUT, "order line is required", subject));
            } else {
                if (!line.hasSku()) {
                    problems.add(problem(ProblemCode.INVALID_INPUT, "order line sku is required", subject));
                }
                if (!line.isPositiveQuantity()) {
                    problems.add(problem(ProblemCode.INVALID_INPUT, "order line quantity must be positive", subject));
                }
                if (!line.isNonNegativePrice()) {
                    problems.add(problem(ProblemCode.INVALID_INPUT, "order line price must not be negative", subject));
                }
            }
            index++;
        }
        return problems;
    }

    private static List<ServiceProblem> validateFileName(String fileName, String subjectId) {
        List<ServiceProblem> problems = new ArrayList<>();
        if (fileName == null || fileName.isBlank()) {
            problems.add(problem(ProblemCode.INVALID_INPUT, "attachment file name must not be blank", subjectId));
            return problems;
        }
        String trimmed = fileName.trim();
        if (trimmed.length() > MAX_FILENAME_LENGTH) {
            problems.add(problem(ProblemCode.INVALID_INPUT,
                    "attachment file name exceeds " + MAX_FILENAME_LENGTH + " characters", subjectId));
        }
        if (trimmed.indexOf('/') >= 0 || trimmed.indexOf('\\') >= 0) {
            problems.add(problem(ProblemCode.INVALID_INPUT,
                    "attachment file name must not contain path separators", subjectId));
        }
        if (trimmed.contains("..")) {
            problems.add(problem(ProblemCode.INVALID_INPUT,
                    "attachment file name must not contain path traversal", subjectId));
        }
        return problems;
    }

    private static ServiceProblem problem(ProblemCode code, String message, String subjectId) {
        return ServiceProblem.of(code, message, subjectId);
    }
}
