package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderResult.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OrderResult(boolean accepted, OrderStatus status, String reservationId, java.util.List<com.example.assetupgrade.common.ServiceProblem> problems, java.util.List<String> sideEffects) {}
