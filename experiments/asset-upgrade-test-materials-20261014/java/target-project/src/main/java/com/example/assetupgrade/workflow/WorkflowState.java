package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowState.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum WorkflowState { NEW, APPROVED, RETRY_PENDING, DISPATCHED, COMPLETED, FAILED, DEAD_LETTERED }
