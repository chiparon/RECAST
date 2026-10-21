package com.example.assetupgrade.web;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.workflow.EventEnvelope;
import com.example.assetupgrade.workflow.EventProcessingStage;
import com.example.assetupgrade.workflow.WorkflowDeliveryCommand;
import com.example.assetupgrade.workflow.WorkflowEvent;
import com.example.assetupgrade.workflow.WorkflowState;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public web request describing one workflow-event delivery.
 *
 * <p>Translated from the APScheduler shared-model normalisation pattern: identifiers are
 * trimmed, the payload attribute map is defensively copied, and a missing state defaults to
 * {@link WorkflowState#NEW}. The {@code to*} helpers bridge to the typed
 * {@link WorkflowEvent}, {@link WorkflowDeliveryCommand} and {@link EventEnvelope} records
 * without introducing a provider type.</p>
 */
public record WorkflowEventRequest(
        String eventId,
        String tenantId,
        String actorId,
        WorkflowState state,
        String routeKey,
        Map<String, String> payload,
        String correlationId) {

    public WorkflowEventRequest {
        eventId = trim(eventId);
        tenantId = trim(tenantId);
        actorId = trim(actorId);
        routeKey = trim(routeKey);
        correlationId = trim(correlationId);
        state = state == null ? WorkflowState.NEW : state;
        payload = immutableCopy(payload);
    }

    private static String trim(String value) {
        return value == null ? null : value.trim();
    }

    private static Map<String, String> immutableCopy(Map<String, String> source) {
        if (source == null || source.isEmpty()) {
            return Map.of();
        }
        Map<String, String> copy = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                copy.put(entry.getKey(), entry.getValue());
            }
        }
        return Collections.unmodifiableMap(copy);
    }

    /** @return the typed workflow event derived from this request. */
    public WorkflowEvent toEvent() {
        return toEvent(tenantId == null ? null : TenantId.of(tenantId));
    }

    /** @return the typed workflow event bound to {@code tenant}. */
    public WorkflowEvent toEvent(TenantId tenant) {
        return new WorkflowEvent(eventId, tenant, attribute("assetId"), eventType(), state, null, payload);
    }

    /** @return the declared event type read from the payload ({@code eventType} or {@code type}). */
    public String eventType() {
        String declared = attribute("eventType");
        return declared == null ? attribute("type") : declared;
    }

    /** @return the value of {@code name} in the payload, or {@code null} when absent. */
    public String attribute(String name) {
        return name == null ? null : payload.get(name);
    }

    /** @return the event envelope derived from this request for {@code stage}. */
    public EventEnvelope toEnvelope(WorkflowEvent event, EventProcessingStage stage, int attempt, Instant nextAttemptAt,
                                    CorrelationId correlation) {
        return new EventEnvelope(event, stage, attempt, nextAttemptAt, routeKey, correlation);
    }

    /** @return the delivery command bridging this request for {@code metadata}. */
    public WorkflowDeliveryCommand toCommand(com.example.assetupgrade.common.CommandMetadata metadata) {
        TenantId tenant = metadata == null ? null : metadata.tenantId();
        return new WorkflowDeliveryCommand(metadata, toEvent(tenant), routeKey);
    }

    /** @return a copy of this request in {@code newState}. */
    public WorkflowEventRequest withState(WorkflowState newState) {
        return new WorkflowEventRequest(eventId, tenantId, actorId, newState, routeKey, payload, correlationId);
    }

    /** @return a copy of this request with an additional payload attribute. */
    public WorkflowEventRequest withPayloadAttribute(String key, String value) {
        Map<String, String> copy = new LinkedHashMap<>(payload);
        copy.put(key, value);
        return new WorkflowEventRequest(eventId, tenantId, actorId, state, routeKey, copy, correlationId);
    }
}
