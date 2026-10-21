package com.example.assetupgrade.security;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.OperationContext;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.error.ValidationException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Records every authorization decision and publishes it as a security event.
 *
 * <p>Each decision is appended as an {@link AuditEntry} with
 * {@link AuditAction#SECURITY_DENIAL} and an {@link AuditStatus#ACCEPTED} (allow) or
 * {@link AuditStatus#REJECTED} (deny) status carrying the tenant, subject and
 * correlation identity. A failure to persist the audit entry is never swallowed: it is
 * rethrown as a {@link StorageFailureException}.</p>
 */
public final class AuthorizationAuditHandler {

    private final AuditPort audit;
    private final SecurityEventPublisher events;
    private final TimeProvider clock;

    public AuthorizationAuditHandler(AuditPort audit, SecurityEventPublisher events, TimeProvider clock) {
        this.audit = audit;
        this.events = events;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    public AuthorizationAuditHandler() {
        this(null, null, null);
    }

    /** Records and publishes a decision derived from an operation context. */
    public void record(OperationContext context, Permission permission, AuthorizationDecision decision) {
        if (context == null) {
            throw new ValidationException("operation context is required for authorization audit");
        }
        if (permission == null) {
            throw new ValidationException("permission is required for authorization audit");
        }
        if (decision == null) {
            throw new ValidationException("authorization decision is required for authorization audit");
        }
        append(context.tenantId(), context.actorId(), context.correlationId(), permission, decision);
    }

    /** Records and publishes a decision from explicit identity coordinates. */
    public void record(TenantId tenantId, ActorId actorId, CorrelationId correlationId, Permission permission, AuthorizationDecision decision) {
        if (tenantId == null) {
            throw new ValidationException("tenant id is required for authorization audit");
        }
        if (permission == null) {
            throw new ValidationException("permission is required for authorization audit");
        }
        if (decision == null) {
            throw new ValidationException("authorization decision is required for authorization audit");
        }
        append(tenantId, actorId, correlationId, permission, decision);
    }

    private void append(TenantId tenantId, ActorId actorId, CorrelationId correlationId, Permission permission, AuthorizationDecision decision) {
        Instant occurredAt = clock.now();
        AuditEntry entry = new AuditEntry(
                tenantId,
                actorId == null ? null : actorId.value(),
                AuditAction.SECURITY_DENIAL,
                decision.allowed() ? AuditStatus.ACCEPTED : AuditStatus.REJECTED,
                correlationId,
                occurredAt,
                details(permission, decision));

        if (audit != null) {
            try {
                audit.append(entry);
            } catch (StorageFailureException ex) {
                throw ex;
            } catch (RuntimeException ex) {
                throw new StorageFailureException("failed to persist authorization audit entry", ex);
            }
        }

        if (events != null) {
            events.publish(tenantId, actorId, correlationId, permission, decision);
        }
    }

    private static Map<String, String> details(Permission permission, AuthorizationDecision decision) {
        Map<String, String> details = new LinkedHashMap<>();
        details.put("permission", permission.name());
        details.put("allowed", Boolean.toString(decision.allowed()));
        details.put("reason", decision.reason());
        details.put("evaluatedPermissions", decision.evaluatedPermissions().stream()
                .map(Permission::name)
                .sorted()
                .collect(Collectors.joining(",")));
        return details;
    }

    /** Compatibility seam for early implementations; {@link #record} is preferred. */
    public Object execute(Object input) {
        if (input instanceof AuditRequest request) {
            record(request.context(), request.permission(), request.decision());
            return request.decision();
        }
        throw new IllegalArgumentException("Expected AuthorizationAuditHandler.AuditRequest");
    }

    /** Explicit argument bundle accepted by {@link #execute(Object)}. */
    public record AuditRequest(OperationContext context, Permission permission, AuthorizationDecision decision) {}
}
