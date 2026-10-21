package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for EventProcessingStage.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum EventProcessingStage { RECEIVED, VALIDATED, RETRY_PENDING, DISPATCHED, COMPLETED, DEAD_LETTERED }
