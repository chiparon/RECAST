package com.example.assetupgrade.workflow;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Writes tenant-scoped audit evidence for workflow delivery.
 *
 * <p>Every record carries the owning tenant, the event identifier as subject, the
 * {@link AuditAction#WORKFLOW_DELIVERY} action, the final {@link AuditStatus} and the correlation
 * identity propagated across the operation. Details always include the event identity, the
 * attempt number, the resolved route and the final workflow state, so the evidence can be joined
 * back to the persisted envelope.</p>
 *
 * <p>An authorization failure is recorded with {@link AuditAction#SECURITY_DENIAL}. The handler
 * never rewrites the correlation identity or the final status.</p>
 */
public final class WorkflowAuditHandler {

    /** Detail key holding the event identifier. */
    public static final String EVENT_ID = "eventId";
    /** Detail key holding the 1-based delivery attempt number. */
    public static final String ATTEMPT = "attempt";
    /** Detail key holding the resolved route key. */
    public static final String ROUTE_KEY = "routeKey";
    /** Detail key holding the final workflow state. */
    public static final String FINAL_STATE = "finalState";
    /** Detail key holding the failure or denial reason. */
    public static final String REASON = "reason";

    private final AuditPort audit;
    private final TimeProvider clock;

    /** Creates a handler with no sink; entries are built but not persisted. */
    public WorkflowAuditHandler() {
        this(null, null);
    }

    /** Creates a handler writing through {@code audit}. */
    public WorkflowAuditHandler(AuditPort audit) {
        this(audit, null);
    }

    /** Creates a handler writing through {@code audit} using {@code clock} for the occurrence instant. */
    public WorkflowAuditHandler(AuditPort audit, TimeProvider clock) {
        this.audit = audit;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Builds and writes one audit entry using the current time; returns the entry that was written. */
    public AuditEntry record(TenantId tenantId, String subjectId, AuditAction action, AuditStatus status,
                             CorrelationId correlationId, Map<String, String> details) {
        return record(tenantId, subjectId, action, status, correlationId, clock.now(), details);
    }

    /** Builds and writes one audit entry with an explicit occurrence instant. */
    public AuditEntry record(TenantId tenantId, String subjectId, AuditAction action, AuditStatus status,
                             CorrelationId correlationId, Instant occurredAt, Map<String, String> details) {
        AuditEntry entry = new AuditEntry(tenantId, subjectId, action, status, correlationId,
                occurredAt == null ? clock.now() : occurredAt, details);
        if (audit != null) {
            audit.append(entry);
        }
        return entry;
    }

    /** Records the final status of a delivery attempt. */
    public AuditEntry recordDelivery(TenantId tenantId, String eventId, AuditStatus status,
                                     CorrelationId correlationId, int attempt, String routeKey,
                                     WorkflowState finalState) {
        Map<String, String> details = new LinkedHashMap<>();
        if (eventId != null) {
            details.put(EVENT_ID, eventId);
        }
        details.put(ATTEMPT, Integer.toString(Math.max(0, attempt)));
        if (routeKey != null) {
            details.put(ROUTE_KEY, routeKey);
        }
        details.put(FINAL_STATE, finalState == null ? WorkflowState.NEW.name() : finalState.name());
        return record(tenantId, eventId, AuditAction.WORKFLOW_DELIVERY, status, correlationId, details);
    }

    /** Records an authorization or tenant denial for a delivery command. */
    public AuditEntry recordDenial(TenantId tenantId, String eventId, CorrelationId correlationId, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        if (eventId != null) {
            details.put(EVENT_ID, eventId);
        }
        details.put(REASON, reason == null || reason.isBlank() ? "denied" : reason);
        return record(tenantId, eventId, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, correlationId, details);
    }

    /** @return the audit status that best describes a delivery status. */
    public static AuditStatus statusFor(DeliveryStatus status) {
        if (status == null) {
            return AuditStatus.FAILED;
        }
        return switch (status) {
            case ACCEPTED -> AuditStatus.COMPLETED;
            case DUPLICATE -> AuditStatus.DUPLICATE;
            case RETRYABLE -> AuditStatus.RETRY_PENDING;
            case REJECTED -> AuditStatus.REJECTED;
            case DEAD_LETTERED -> AuditStatus.FAILED;
        };
    }

    /** @return the audit status that best describes a workflow state. */
    public static AuditStatus statusFor(WorkflowState state) {
        if (state == null) {
            return AuditStatus.RECEIVED;
        }
        return switch (state) {
            case NEW, APPROVED -> AuditStatus.ACCEPTED;
            case RETRY_PENDING -> AuditStatus.RETRY_PENDING;
            case DISPATCHED, COMPLETED -> AuditStatus.COMPLETED;
            case FAILED, DEAD_LETTERED -> AuditStatus.FAILED;
        };
    }

    /** @return the backing audit port, or {@code null} when none is configured. */
    public AuditPort port() {
        return audit;
    }

    /** @return the time source used for the occurrence instant. */
    public TimeProvider clock() {
        return clock;
    }

    /** Compatibility seam; accepts a {@link WorkflowEvent} and records its current state. */
    public Object execute(Object input) {
        if (input instanceof WorkflowEvent event) {
            return recordDelivery(event.tenantId(), event.eventId(), statusFor(event.state()), null, 0, null,
                    event.state());
        }
        throw new IllegalArgumentException("Expected WorkflowEvent");
    }
}
