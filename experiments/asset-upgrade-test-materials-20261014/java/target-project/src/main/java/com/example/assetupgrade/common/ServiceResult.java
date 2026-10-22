package com.example.assetupgrade.common;

/**
 * Skeleton seam for ServiceResult.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record ServiceResult<T>(boolean successful, T value, java.util.List<ServiceProblem> problems) {}
