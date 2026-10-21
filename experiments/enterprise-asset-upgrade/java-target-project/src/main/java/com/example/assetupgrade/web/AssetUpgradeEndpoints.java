package com.example.assetupgrade.web;

import com.example.assetupgrade.application.AssetUpgradeApplication;
import com.example.assetupgrade.attachment.AttachmentIntakeCommand;
import com.example.assetupgrade.attachment.AttachmentIntakeResult;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.error.AssetUpgradeException;
import com.example.assetupgrade.order.OrderCommand;
import com.example.assetupgrade.order.OrderResult;
import com.example.assetupgrade.reconciliation.ReconciliationCommand;
import com.example.assetupgrade.reconciliation.ReconciliationReport;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;
import com.example.assetupgrade.workflow.WorkflowDeliveryResult;

import java.time.Instant;

/**
 * Public API surface for the four asset-upgrade requirements.
 *
 * <p>Each operation resolves the tenant/actor/correlation context through the injected
 * {@link RequestContextResolver}, builds the typed command and delegates to the completed
 * {@link AssetUpgradeApplication} service chain, then renders the outcome through the
 * injected {@link ResponseMapper}. The endpoints only orchestrate and map: every tenant,
 * quarantine, delivery, idempotency and audit rule stays in the application services. A
 * missing resource, a cross-tenant request or a wrong state is surfaced as an
 * {@link ApiError} rather than a leaked provider exception.</p>
 */
public interface AssetUpgradeEndpoints {

    /** Default reconciliation window size when the caller does not supply one. */
    int DEFAULT_RECONCILIATION_LIMIT = 100;

    /** Accepts and processes an attachment submission. */
    default Object intakeAttachment(AttachmentRequest request) {
        return execute(request);
    }

    /** Validates and submits an order through the plugin bridge. */
    default Object submitOrder(OrderRequestDto request) {
        return execute(request);
    }

    /** Delivers an approved workflow event to its configured route. */
    default Object deliverWorkflowEvent(WorkflowEventRequest request) {
        return execute(request);
    }

    /** Runs a tenant-scoped reconciliation window over due retryable events. */
    default Object runReconciliation(String tenantId, String actorId, String correlationId, int limit, String jobName) {
        return execute(new ReconciliationRequest(tenantId, actorId, correlationId, limit, jobName));
    }

    /** Compatibility seam; dispatches the typed inputs to the matching operation. */
    Object execute(Object input);

    /** @return endpoints over {@code application} using the default context and response seams. */
    static AssetUpgradeEndpoints of(AssetUpgradeApplication application) {
        return new Default(application);
    }

    /** @return endpoints over {@code application} with explicit context and response seams. */
    static AssetUpgradeEndpoints of(AssetUpgradeApplication application, RequestContextResolver contexts,
                                    ResponseMapper mapper) {
        return new Default(application, contexts, mapper);
    }

    /** Explicit reconciliation-run bundle accepted by the compatibility seam. */
    record ReconciliationRequest(String tenantId, String actorId, String correlationId, int limit, String jobName) {
    }

    /** Default endpoint implementation over the completed application service chain. */
    final class Default implements AssetUpgradeEndpoints {

        private final AssetUpgradeApplication application;
        private final RequestContextResolver contexts;
        private final ResponseMapper mapper;

        /** Creates endpoints over {@code application} with the default context and response seams. */
        public Default(AssetUpgradeApplication application) {
            this(application, RequestContextResolver.defaults(), ResponseMapper.defaults());
        }

        /** Creates endpoints over {@code application} with an explicit context resolver. */
        public Default(AssetUpgradeApplication application, RequestContextResolver contexts) {
            this(application, contexts, ResponseMapper.defaults());
        }

        /** Creates endpoints over the given application, context resolver and response mapper. */
        public Default(AssetUpgradeApplication application, RequestContextResolver contexts, ResponseMapper mapper) {
            this.application = application;
            this.contexts = contexts == null ? RequestContextResolver.defaults() : contexts;
            this.mapper = mapper == null ? ResponseMapper.defaults() : mapper;
        }

        /** @return the application service chain backing these endpoints, or {@code null}. */
        public AssetUpgradeApplication application() {
            return application;
        }

        /** @return the context resolver backing these endpoints. */
        public RequestContextResolver contexts() {
            return contexts;
        }

        /** @return the response mapper backing these endpoints. */
        public ResponseMapper mapper() {
            return mapper;
        }

        @Override
        public Object intakeAttachment(AttachmentRequest request) {
            if (request == null) {
                return error(ProblemCode.INVALID_INPUT, "attachment request is required", null);
            }
            try {
                CommandMetadata metadata = contexts.resolve(request);
                AttachmentIntakeCommand command = new AttachmentIntakeCommand(metadata,
                        request.toMetadata(metadata.tenantId()), request.content());
                return mapper.map(dispatch().intake(command));
            } catch (AssetUpgradeException failure) {
                return mapper.toApiError(failure);
            } catch (RuntimeException failure) {
                return mapper.toApiError(failure);
            }
        }

        @Override
        public Object submitOrder(OrderRequestDto request) {
            if (request == null) {
                return error(ProblemCode.INVALID_INPUT, "order request is required", null);
            }
            try {
                CommandMetadata metadata = contexts.resolve(request);
                OrderCommand command = request.toCommand(metadata);
                return mapper.map(dispatch().submit(command));
            } catch (AssetUpgradeException failure) {
                return mapper.toApiError(failure);
            } catch (RuntimeException failure) {
                return mapper.toApiError(failure);
            }
        }

        @Override
        public Object deliverWorkflowEvent(WorkflowEventRequest request) {
            if (request == null) {
                return error(ProblemCode.INVALID_INPUT, "workflow event request is required", null);
            }
            try {
                CommandMetadata metadata = contexts.resolve(request);
                WorkflowDeliveryCommand command = request.toCommand(metadata);
                return mapper.map(dispatch().deliver(command));
            } catch (AssetUpgradeException failure) {
                return mapper.toApiError(failure);
            } catch (RuntimeException failure) {
                return mapper.toApiError(failure);
            }
        }

        @Override
        public Object runReconciliation(String tenantId, String actorId, String correlationId, int limit, String jobName) {
            try {
                CommandMetadata metadata = contexts.resolve(tenantId, actorId, correlationId);
                int effectiveLimit = limit <= 0 ? DEFAULT_RECONCILIATION_LIMIT : limit;
                ReconciliationCommand command = new ReconciliationCommand(metadata, Instant.now(), effectiveLimit,
                        jobName);
                return mapper.map(dispatch().reconcile(command));
            } catch (AssetUpgradeException failure) {
                return mapper.toApiError(failure);
            } catch (RuntimeException failure) {
                return mapper.toApiError(failure);
            }
        }

        @Override
        public Object execute(Object input) {
            if (input instanceof AttachmentRequest request) {
                return intakeAttachment(request);
            }
            if (input instanceof OrderRequestDto request) {
                return submitOrder(request);
            }
            if (input instanceof WorkflowEventRequest request) {
                return deliverWorkflowEvent(request);
            }
            if (input instanceof ReconciliationRequest request) {
                return runReconciliation(request.tenantId(), request.actorId(), request.correlationId(),
                        request.limit(), request.jobName());
            }
            if (application != null) {
                return mapDomain(application.execute(input));
            }
            throw new IllegalArgumentException("Unsupported endpoints input: "
                    + (input == null ? "null" : input.getClass().getName()));
        }

        private AssetUpgradeApplication dispatch() {
            if (application == null) {
                throw new IllegalStateException("asset upgrade application is not configured");
            }
            return application;
        }

        private ApiError error(ProblemCode code, String message, String subjectId) {
            return mapper.toApiError(ServiceProblem.of(code, message, subjectId));
        }

        private Object mapDomain(Object result) {
            if (result instanceof AttachmentIntakeResult
                    || result instanceof OrderResult
                    || result instanceof WorkflowDeliveryResult
                    || result instanceof ReconciliationReport) {
                return mapper.execute(result);
            }
            return result;
        }
    }
}
