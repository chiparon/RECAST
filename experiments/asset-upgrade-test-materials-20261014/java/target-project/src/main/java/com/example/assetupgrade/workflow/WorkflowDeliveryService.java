package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowDeliveryService.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface WorkflowDeliveryService { WorkflowDeliveryResult deliver(WorkflowDeliveryCommand command); }
