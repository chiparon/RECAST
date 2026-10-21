package com.example.assetupgrade.common;

/**
 * Skeleton seam for ServiceProblem.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record ServiceProblem(ProblemCode code, String message, String subjectId, java.util.Map<String,String> attributes) {}
