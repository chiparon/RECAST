package com.example.assetupgrade.observability;

/**
 * Skeleton seam for HealthStatus.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record HealthStatus(String marker, java.util.Map<String,String> attributes) {}
