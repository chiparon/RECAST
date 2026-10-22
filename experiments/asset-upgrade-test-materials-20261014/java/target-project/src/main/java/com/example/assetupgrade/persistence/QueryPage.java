package com.example.assetupgrade.persistence;

/**
 * Skeleton seam for QueryPage.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record QueryPage(String marker, java.util.Map<String,String> attributes) {}
