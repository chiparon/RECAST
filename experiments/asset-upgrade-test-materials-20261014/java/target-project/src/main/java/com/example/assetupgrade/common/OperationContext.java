package com.example.assetupgrade.common;

/**
 * Skeleton seam for OperationContext.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OperationContext(CommandMetadata metadata, String operationName, java.util.Map<String,String> attributes) {}
