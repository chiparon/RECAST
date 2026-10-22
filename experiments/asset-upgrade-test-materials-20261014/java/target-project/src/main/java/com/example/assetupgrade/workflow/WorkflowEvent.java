package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowEvent.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record WorkflowEvent(String eventId, com.example.assetupgrade.common.TenantId tenantId, String assetId, String eventType, WorkflowState state, java.time.Instant occurredAt, java.util.Map<String,String> attributes) {}
