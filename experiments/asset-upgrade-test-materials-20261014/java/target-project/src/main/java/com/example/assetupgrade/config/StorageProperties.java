package com.example.assetupgrade.config;

/**
 * Skeleton seam for StorageProperties.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record StorageProperties(String marker, java.util.Map<String,String> attributes) {}
