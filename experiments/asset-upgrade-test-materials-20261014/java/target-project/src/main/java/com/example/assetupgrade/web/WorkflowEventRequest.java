package com.example.assetupgrade.web;

/**
 * Skeleton seam for WorkflowEventRequest.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record WorkflowEventRequest(String marker, java.util.Map<String,String> attributes) {}
