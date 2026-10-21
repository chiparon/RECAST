package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderValidator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface OrderValidator { java.util.List<com.example.assetupgrade.common.ServiceProblem> validate(OrderRequest order); }
