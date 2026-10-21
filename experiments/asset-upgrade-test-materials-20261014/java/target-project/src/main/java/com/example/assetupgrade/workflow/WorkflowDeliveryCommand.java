package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowDeliveryCommand.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record WorkflowDeliveryCommand(com.example.assetupgrade.common.CommandMetadata metadata, WorkflowEvent event, String routeKey) {}
