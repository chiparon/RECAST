package com.example.assetupgrade.messaging;

/**
 * Skeleton seam for MessageHeaders.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record MessageHeaders(String marker, java.util.Map<String,String> attributes) {}
