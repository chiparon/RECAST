package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for WorkflowStateMachine.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface WorkflowStateMachine { boolean canTransition(WorkflowState from, WorkflowState to); WorkflowState transition(WorkflowState from, WorkflowState to); }
