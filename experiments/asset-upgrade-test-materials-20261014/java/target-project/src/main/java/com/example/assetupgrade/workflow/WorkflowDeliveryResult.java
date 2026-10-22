package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowDeliveryResult.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record WorkflowDeliveryResult(boolean accepted, DeliveryStatus status, WorkflowState finalState, int attemptNumber, java.util.List<com.example.assetupgrade.common.ServiceProblem> problems) {}
