package com.example.assetupgrade.observability;

/**
 * Skeleton seam for TelemetryContext.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record TelemetryContext(String marker, java.util.Map<String,String> attributes) {}
