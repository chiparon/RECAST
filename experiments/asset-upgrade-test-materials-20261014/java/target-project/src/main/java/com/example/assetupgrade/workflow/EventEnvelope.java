package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for EventEnvelope.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record EventEnvelope(WorkflowEvent event, EventProcessingStage stage, int deliveryAttempt, java.time.Instant nextAttemptAt, String routeKey, com.example.assetupgrade.common.CorrelationId correlationId) {}
