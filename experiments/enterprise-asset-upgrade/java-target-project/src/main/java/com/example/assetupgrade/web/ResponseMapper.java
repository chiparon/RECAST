package com.example.assetupgrade.web;

import com.example.assetupgrade.attachment.AttachmentIntakeResult;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.ServiceResult;
import com.example.assetupgrade.error.AssetUpgradeException;
import com.example.assetupgrade.order.OrderResult;
import com.example.assetupgrade.order.OrderStatus;
import com.example.assetupgrade.reconciliation.ReconciliationReport;
import com.example.assetupgrade.workflow.WorkflowDeliveryResult;

import java.util.ArrayList;
import java.util.List;

/**
 * Translates application outcomes into the public response and error surface.
 *
 * <p>Mirrors the APScheduler {@code abc.py} interface discipline with the outcome vocabulary
 * from {@code _enums.py} and the error catalogue from {@code _exceptions.py}: an accepted
 * outcome becomes a typed response record, while a rejected, retryable, dead-lettered or
 * rolled-back outcome becomes a deterministic {@link ApiError} (or list of them) whose
 * status follows {@link ProblemCode}. The legacy {@link #execute(Object)} seam dispatches to
 * the typed mapping methods and never weakens an error classification.</p>
 */
public interface ResponseMapper {

    /** Compatibility seam; dispatches to the typed mapping methods. */
    Object execute(Object input);

    /** Maps a service problem onto the public error shape. */
    default ApiError toApiError(ServiceProblem problem) {
        return ApiError.from(problem);
    }

    /** Maps a problem code and message onto the public error shape. */
    default ApiError toApiError(ProblemCode code, String message) {
        return ApiError.from(code, message, null);
    }

    /** Maps a failure onto the public error shape. */
    default ApiError toApiError(Throwable failure) {
        return ApiError.from(failure);
    }

    /** Maps a list of service problems onto the public error shape. */
    default List<ApiError> toApiErrors(List<ServiceProblem> problems) {
        if (problems == null || problems.isEmpty()) {
            return List.of();
        }
        List<ApiError> errors = new ArrayList<>(problems.size());
        for (ServiceProblem problem : problems) {
            errors.add(toApiError(problem));
        }
        return List.copyOf(errors);
    }

    /** Maps an attachment intake result: a response on success, the errors otherwise. */
    default Object map(AttachmentIntakeResult result) {
        if (result == null) {
            return ApiError.from(ProblemCode.INVALID_INPUT, "attachment result is required", null);
        }
        List<ApiError> errors = toApiErrors(result.problems());
        if (!result.isAccepted() || !errors.isEmpty()) {
            if (errors.isEmpty()) {
                errors = List.of(ApiError.from(ProblemCode.QUARANTINED, "attachment was not accepted", null));
            }
            return errors;
        }
        return new AttachmentResponse(true, result.state().name(), result.fingerprint(), List.of());
    }

    /** Maps an order result: a response on success, the errors otherwise. */
    default Object map(OrderResult result) {
        if (result == null) {
            return ApiError.from(ProblemCode.INVALID_INPUT, "order result is required", null);
        }
        List<ApiError> errors = toApiErrors(result.problems());
        if (!result.isAccepted()) {
            if (errors.isEmpty()) {
                ProblemCode code = result.status() == OrderStatus.ROLLED_BACK
                        ? ProblemCode.RETRYABLE : ProblemCode.CONFLICT;
                errors = List.of(ApiError.from(code, "order was not accepted", result.reservationId()));
            }
            return errors;
        }
        if (!errors.isEmpty()) {
            return errors;
        }
        return new OrderResponse(true, result.status().name(), result.reservationId(), List.of());
    }

    /** Maps a workflow delivery result: a response on success, the errors otherwise. */
    default Object map(WorkflowDeliveryResult result) {
        if (result == null) {
            return ApiError.from(ProblemCode.INVALID_INPUT, "workflow delivery result is required", null);
        }
        if (result.isAccepted()) {
            return new WorkflowResponse(true, result.status().name(), result.finalState().name(),
                    result.attemptNumber(), List.of());
        }
        List<ApiError> errors = toApiErrors(result.problems());
        if (errors.isEmpty()) {
            ProblemCode code = result.isDeadLettered()
                    ? ProblemCode.RETRY_EXHAUSTED
                    : result.isRetryable() ? ProblemCode.RETRYABLE : ProblemCode.CONFLICT;
            errors = List.of(ApiError.from(code, "workflow delivery was not accepted", null));
        }
        return errors;
    }

    /** Maps a reconciliation report onto its public summary. */
    default Object map(ReconciliationReport report) {
        if (report == null) {
            return ApiError.from(ProblemCode.INVALID_INPUT, "reconciliation report is required", null);
        }
        return new ReconciliationResponse(report.examined(), report.retried(), report.succeeded(),
                report.failed(), report.eventIds(), report.checkpoint());
    }

    /** Maps a single service problem onto the public error shape. */
    default Object map(ServiceProblem problem) {
        return toApiError(problem);
    }

    /** Maps a generic service result: the payload on success, the errors otherwise. */
    default Object map(ServiceResult<?> result) {
        if (result == null) {
            return ApiError.from(ProblemCode.INVALID_INPUT, "service result is required", null);
        }
        if (result.isSuccess()) {
            return result.value();
        }
        return toApiErrors(result.problems());
    }

    /** @return a mapper backed by the default translation policy. */
    static ResponseMapper defaults() {
        return new Default();
    }

    /** Public attachment-outcome response. */
    record AttachmentResponse(boolean accepted, String state, String fingerprint, List<ApiError> errors) {
        public AttachmentResponse {
            errors = errors == null ? List.of() : List.copyOf(errors);
        }
    }

    /** Public order-outcome response. */
    record OrderResponse(boolean accepted, String status, String reservationId, List<ApiError> errors) {
        public OrderResponse {
            errors = errors == null ? List.of() : List.copyOf(errors);
        }
    }

    /** Public workflow-delivery response. */
    record WorkflowResponse(boolean accepted, String status, String finalState, int attemptNumber,
                            List<ApiError> errors) {
        public WorkflowResponse {
            errors = errors == null ? List.of() : List.copyOf(errors);
        }
    }

    /** Public reconciliation-run response. */
    record ReconciliationResponse(int examined, int retried, int succeeded, int failed, List<String> eventIds,
                                  String checkpoint) {
        public ReconciliationResponse {
            eventIds = eventIds == null ? List.of() : List.copyOf(eventIds);
        }
    }

    /** Default mapper dispatching the compatibility seam onto the typed methods. */
    final class Default implements ResponseMapper {

        @Override
        public Object execute(Object input) {
            if (input instanceof AttachmentIntakeResult result) {
                return map(result);
            }
            if (input instanceof OrderResult result) {
                return map(result);
            }
            if (input instanceof WorkflowDeliveryResult result) {
                return map(result);
            }
            if (input instanceof ReconciliationReport report) {
                return map(report);
            }
            if (input instanceof ServiceResult<?> result) {
                return map(result);
            }
            if (input instanceof ServiceProblem problem) {
                return map(problem);
            }
            if (input instanceof AssetUpgradeException failure) {
                return toApiError(failure);
            }
            if (input instanceof Throwable failure) {
                return toApiError(failure);
            }
            throw new IllegalArgumentException("Unsupported response input: "
                    + (input == null ? "null" : input.getClass().getName()));
        }
    }
}
