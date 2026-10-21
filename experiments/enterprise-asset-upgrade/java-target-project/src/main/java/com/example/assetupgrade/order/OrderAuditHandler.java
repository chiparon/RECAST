package com.example.assetupgrade.order;

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
 * Writes tenant-scoped audit evidence for order submission and plugin invocation.
 *
 * <p>Every entry carries the owning tenant, the order or plugin identifier as subject, the
 * {@link AuditAction#ORDER_SUBMISSION} / {@link AuditAction#PLUGIN_INVOCATION} action, the final
 * {@link AuditStatus} and the correlation identity propagated across the operation. Details carry
 * the reservation identity, the plugin identity and the outcome so the evidence can be joined back
 * to the persisted {@link OrderSnapshot}.</p>
 *
 * <p>The handler never rewrites the correlation identity or the final status. Appending through
 * {@link com.example.assetupgrade.audit.AuditWriter} guarantees a duplicate command is written at
 * most once.</p>
 */
public final class OrderAuditHandler {

    /** Detail key holding the order identifier. */
    public static final String ORDER_ID = "orderId";
    /** Detail key holding the reservation identifier. */
    public static final String RESERVATION_ID = "reservationId";
    /** Detail key holding the plugin identifier. */
    public static final String PLUGIN_ID = "pluginId";
    /** Detail key holding the outcome marker. */
    public static final String OUTCOME = "outcome";
    /** Detail key holding the plugin operation. */
    public static final String OPERATION = "operation";
    /** Detail key holding whether the plugin capability was resolved. */
    public static final String RESOLVED = "resolved";
    /** Detail key holding the rollback or failure reason. */
    public static final String REASON = "reason";

    private final AuditPort audit;
    private final TimeProvider clock;

    /** Creates a handler with no sink; entries are built but not persisted. */
    public OrderAuditHandler() {
        this(null, null);
    }

    /** Creates a handler writing through {@code audit}. */
    public OrderAuditHandler(AuditPort audit) {
        this(audit, null);
    }

    /** Creates a handler writing through {@code audit} using {@code clock} for the occurrence instant. */
    public OrderAuditHandler(AuditPort audit, TimeProvider clock) {
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

    /** Records the final status of an order submission. */
    public AuditEntry recordOrderSubmission(TenantId tenantId, String orderId, AuditStatus status,
                                            CorrelationId correlationId, String reservationId, String pluginId,
                                            String outcome) {
        Map<String, String> details = new LinkedHashMap<>();
        if (orderId != null) {
            details.put(ORDER_ID, orderId);
        }
        if (reservationId != null) {
            details.put(RESERVATION_ID, reservationId);
        }
        if (pluginId != null) {
            details.put(PLUGIN_ID, pluginId);
        }
        details.put(OUTCOME, outcome == null || outcome.isBlank() ? "unknown" : outcome);
        return record(tenantId, orderId, AuditAction.ORDER_SUBMISSION,
                status == null ? AuditStatus.FAILED : status, correlationId, details);
    }

    /** Records the final status of an order submission, translating {@code orderStatus}. */
    public AuditEntry recordOrderSubmission(TenantId tenantId, String orderId, OrderStatus orderStatus,
                                            CorrelationId correlationId, String reservationId, String pluginId,
                                            String outcome) {
        return recordOrderSubmission(tenantId, orderId, statusFor(orderStatus), correlationId, reservationId,
                pluginId, outcome);
    }

    /** Records that a plugin capability was resolved for an order command. */
    public AuditEntry recordPluginInvocation(TenantId tenantId, String pluginId, String orderId,
                                             CorrelationId correlationId, String operation, boolean resolved) {
        Map<String, String> details = new LinkedHashMap<>();
        if (orderId != null) {
            details.put(ORDER_ID, orderId);
        }
        details.put(OPERATION, operation == null || operation.isBlank()
                ? PluginCapabilityPolicy.ORDER_SUBMIT_OPERATION : operation);
        details.put(RESOLVED, Boolean.toString(resolved));
        return record(tenantId, pluginId, AuditAction.PLUGIN_INVOCATION,
                resolved ? AuditStatus.ACCEPTED : AuditStatus.REJECTED, correlationId, details);
    }

    /** Records the rollback of a failed order submission. */
    public AuditEntry recordRollback(TenantId tenantId, String orderId, CorrelationId correlationId,
                                     String reservationId, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        if (orderId != null) {
            details.put(ORDER_ID, orderId);
        }
        if (reservationId != null) {
            details.put(RESERVATION_ID, reservationId);
        }
        details.put(REASON, reason == null || reason.isBlank() ? "rollback" : reason);
        details.put(OUTCOME, OrderStatus.ROLLED_BACK.name());
        return record(tenantId, orderId, AuditAction.ORDER_SUBMISSION, AuditStatus.ROLLED_BACK, correlationId, details);
    }

    /** Records an authorization or tenant denial for an order command. */
    public AuditEntry recordDenial(TenantId tenantId, String orderId, CorrelationId correlationId, String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        if (orderId != null) {
            details.put(ORDER_ID, orderId);
        }
        details.put(REASON, reason == null || reason.isBlank() ? "denied" : reason);
        return record(tenantId, orderId, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, correlationId, details);
    }

    /** @return the audit status that best describes an order status. */
    public static AuditStatus statusFor(OrderStatus status) {
        if (status == null) {
            return AuditStatus.FAILED;
        }
        return switch (status) {
            case DRAFT, VALIDATING -> AuditStatus.RECEIVED;
            case RESERVED, COMMITTING, ACCEPTED -> AuditStatus.ACCEPTED;
            case REJECTED -> AuditStatus.REJECTED;
            case ROLLED_BACK -> AuditStatus.ROLLED_BACK;
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

    /** Compatibility seam; accepts an {@link OrderCommand} and records its final status. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) {
            TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
            CorrelationId correlationId = command.metadata() == null ? null : command.metadata().correlationId();
            return recordOrderSubmission(tenantId, command.orderId(), OrderStatus.DRAFT, correlationId,
                    null, command.pluginId(), "recorded");
        }
        if (input instanceof AuditEntry entry) {
            if (audit != null) {
                audit.append(entry);
            }
            return entry;
        }
        throw new IllegalArgumentException("Expected an OrderCommand or AuditEntry");
    }
}
