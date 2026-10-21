package com.example.assetupgrade.workflow;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ValidationException;

import java.util.Map;

/**
 * Validates and normalises a workflow event before delivery.
 *
 * <p>An event must carry a non-blank {@code eventId} and {@code eventType} and a present
 * {@link TenantId}. When the delivery command declares a tenant, the event tenant must match it;
 * a cross-tenant event is rejected with an {@link ValidationException}. The immutable attribute
 * map is null-guarded and the original {@code occurredAt} is preserved unchanged.</p>
 */
public final class WorkflowEventNormalizer {

    /** @return a normalised copy of {@code event}, requiring it to belong to {@code expectedTenant}. */
    public WorkflowEvent normalize(WorkflowEvent event, TenantId expectedTenant) {
        if (event == null) {
            throw new ValidationException("workflow event is required");
        }
        String eventId = requireText(event.eventId(), "event id");
        String eventType = requireText(event.eventType(), "event type");
        TenantId tenantId = event.tenantId();
        if (tenantId == null || !tenantId.isPresent()) {
            throw new ValidationException("workflow event tenant is required");
        }
        if (expectedTenant != null && !expectedTenant.equals(tenantId)) {
            throw new ValidationException("workflow event tenant does not match the command tenant");
        }
        Map<String, String> attributes = event.attributes() == null ? Map.of() : Map.copyOf(event.attributes());
        return new WorkflowEvent(eventId, tenantId, event.assetId(), eventType, event.state(),
                event.occurredAt(), attributes);
    }

    /** @return a normalised copy of {@code event} with no tenant cross-check. */
    public WorkflowEvent normalize(WorkflowEvent event) {
        return normalize(event, null);
    }

    /** @return the normalised event declared by {@code command}, checked against the command tenant. */
    public WorkflowEvent normalize(WorkflowDeliveryCommand command) {
        if (command == null || command.metadata() == null) {
            throw new ValidationException("workflow delivery command metadata is required");
        }
        return normalize(command.event(), command.metadata().tenantId());
    }

    /**
     * Compatibility seam; accepts a {@link WorkflowEvent} or {@link WorkflowDeliveryCommand}.
     */
    public Object execute(Object input) {
        if (input instanceof WorkflowDeliveryCommand command) {
            return normalize(command);
        }
        if (input instanceof WorkflowEvent event) {
            return normalize(event);
        }
        if (input == null) {
            throw new ValidationException("workflow event is required");
        }
        throw new IllegalArgumentException("Expected a WorkflowEvent or WorkflowDeliveryCommand");
    }

    /** @return {@code true} when {@code event} carries the identifiers required for delivery. */
    public boolean isValid(WorkflowEvent event, TenantId expectedTenant) {
        try {
            normalize(event, expectedTenant);
            return true;
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    /** @return the problem code reported for an invalid event. */
    public ProblemCode problemCode() {
        return ProblemCode.INVALID_INPUT;
    }

    private static String requireText(String value, String name) {
        if (value == null) {
            throw new ValidationException(name + " is required");
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            throw new ValidationException(name + " must not be blank");
        }
        return trimmed;
    }
}
