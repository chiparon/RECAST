package com.example.assetupgrade.web;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.OperationContext;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.TenantAccessException;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.observability.CorrelationPort;
import com.example.assetupgrade.observability.LogContext;
import com.example.assetupgrade.observability.TelemetryContext;
import com.example.assetupgrade.telemetry.CorrelationIdProvider;

import java.time.Instant;
import java.util.Map;

/**
 * Resolves the tenant, actor and correlation identity for a public request.
 *
 * <p>Translated from the APScheduler {@code _context.py} {@code ContextVar} pattern: instead
 * of a thread-local current-* binding, the resolver derives a {@link CommandMetadata} from
 * the request data, resolves the correlation identity through the configured
 * {@link CorrelationPort} and exposes the orchestration {@link OperationContext},
 * {@link LogContext} and {@link TelemetryContext}. A missing tenant or actor is rejected
 * with a {@link ValidationException}; a resource that belongs to another tenant is rejected
 * with a {@link TenantAccessException}. The legacy {@link #execute(Object)} seam dispatches
 * to the typed resolve methods.</p>
 */
public interface RequestContextResolver {

    /** Operation name used when a caller does not supply one. */
    String DEFAULT_OPERATION = "request";

    /** Shared best-effort correlation provider used when none is injected. */
    CorrelationPort DEFAULT_CORRELATION_PORT = new CorrelationIdProvider();

    /** @return the correlation port used to generate or propagate correlation identities. */
    default CorrelationPort correlationPort() {
        return DEFAULT_CORRELATION_PORT;
    }

    /** Compatibility seam; dispatches to the typed resolve methods. */
    Object execute(Object input);

    /** Resolves the metadata for the declared textual identity. */
    default CommandMetadata resolve(String tenantId, String actorId, String correlationId) {
        TenantId tenant = requireTenant(tenantId);
        ActorId actor = requireActor(actorId);
        CorrelationId correlation = resolveCorrelation(correlationId);
        return CommandMetadata.of(tenant, actor, correlation, Instant.now());
    }

    /**
     * Resolves the metadata for the declared identity and asserts that the resource tenant
     * matches it, rejecting a cross-tenant request.
     */
    default CommandMetadata resolve(String tenantId, String actorId, String correlationId, String resourceTenant) {
        CommandMetadata metadata = resolve(tenantId, actorId, correlationId);
        if (resourceTenant != null && !resourceTenant.isBlank()) {
            assertTenantBoundary(metadata.tenantId(), TenantId.of(resourceTenant.trim()));
        }
        return metadata;
    }

    /** Resolves the metadata for an attachment request. */
    default CommandMetadata resolve(AttachmentRequest request) {
        if (request == null) {
            throw new ValidationException("attachment request is required");
        }
        return resolve(request.tenantId(), request.actorId(), request.correlationId());
    }

    /** Resolves the metadata for an order request. */
    default CommandMetadata resolve(OrderRequestDto request) {
        if (request == null) {
            throw new ValidationException("order request is required");
        }
        return resolve(request.tenantId(), request.actorId(), null);
    }

    /** Resolves the metadata for a workflow-event request. */
    default CommandMetadata resolve(WorkflowEventRequest request) {
        if (request == null) {
            throw new ValidationException("workflow event request is required");
        }
        return resolve(request.tenantId(), request.actorId(), request.correlationId());
    }

    /** Resolves the correlation identity to propagate, generating one when absent. */
    default CorrelationId resolveCorrelation(String correlationId) {
        CorrelationId inbound = null;
        if (correlationId != null && !correlationId.isBlank()) {
            inbound = CorrelationId.of(correlationId.trim());
        }
        CorrelationId resolved = correlationPort().resolve(inbound);
        if (resolved != null) {
            return resolved;
        }
        return inbound == null ? CorrelationId.generate() : inbound;
    }

    /** Builds the orchestration context for the declared identity. */
    default OperationContext operationContext(String tenantId, String actorId, String correlationId, String operationName) {
        String name = operationName == null || operationName.isBlank() ? DEFAULT_OPERATION : operationName.trim();
        return resolve(tenantId, actorId, correlationId).toContext(name);
    }

    /** Builds the log context for the declared identity. */
    default LogContext logContext(String tenantId, String actorId, String correlationId) {
        CommandMetadata metadata = resolve(tenantId, actorId, correlationId);
        return LogContext.of(metadata.correlationId(), metadata.tenantId());
    }

    /** Builds the telemetry context for the declared identity and {@code marker}. */
    default TelemetryContext telemetryContext(String tenantId, String actorId, String correlationId, String marker) {
        CommandMetadata metadata = resolve(tenantId, actorId, correlationId);
        return TelemetryContext.of(marker, Map.of())
                .withAttribute("correlationId", metadata.correlationId().value())
                .withAttribute("tenantId", metadata.tenantId().value());
    }

    /** Asserts that {@code resource} belongs to the tenant declared by {@code declared}. */
    default void assertTenantBoundary(TenantId declared, TenantId resource) {
        if (declared == null || resource == null) {
            throw new ValidationException("declared and resource tenant are required");
        }
        if (!declared.equals(resource)) {
            throw new TenantAccessException("resource belongs to a different tenant");
        }
    }

    /** @return the resolved tenant identity, never {@code null}. */
    static TenantId requireTenant(String tenantId) {
        if (tenantId == null || tenantId.isBlank()) {
            throw new ValidationException("tenant id is required");
        }
        return TenantId.of(tenantId.trim());
    }

    /** @return the resolved actor identity, never {@code null}. */
    static ActorId requireActor(String actorId) {
        if (actorId == null || actorId.isBlank()) {
            throw new ValidationException("actor id is required");
        }
        return ActorId.of(actorId.trim());
    }

    /** @return a resolver backed by a fresh {@link CorrelationIdProvider}. */
    static RequestContextResolver defaults() {
        return new Default();
    }

    /** @return a resolver backed by {@code correlationPort}. */
    static RequestContextResolver of(CorrelationPort correlationPort) {
        return new Default(correlationPort);
    }

    /** Explicit identity bundle accepted by the compatibility seam. */
    record RequestIdentity(String tenantId, String actorId, String correlationId) {
    }

    /** Default resolver adapting the request data onto the typed metadata. */
    final class Default implements RequestContextResolver {

        private final CorrelationPort correlationPort;

        /** Creates a resolver generating correlation identities locally. */
        public Default() {
            this(null);
        }

        /** Creates a resolver delegating correlation resolution to {@code correlationPort}. */
        public Default(CorrelationPort correlationPort) {
            this.correlationPort = correlationPort == null ? new CorrelationIdProvider() : correlationPort;
        }

        @Override
        public CorrelationPort correlationPort() {
            return correlationPort;
        }

        @Override
        public Object execute(Object input) {
            if (input instanceof AttachmentRequest request) {
                return resolve(request);
            }
            if (input instanceof OrderRequestDto request) {
                return resolve(request);
            }
            if (input instanceof WorkflowEventRequest request) {
                return resolve(request);
            }
            if (input instanceof RequestIdentity identity) {
                return resolve(identity.tenantId(), identity.actorId(), identity.correlationId());
            }
            if (input instanceof OperationContext context) {
                return context.metadata();
            }
            throw new IllegalArgumentException("Unsupported request context input: "
                    + (input == null ? "null" : input.getClass().getName()));
        }
    }
}
