package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderRequest.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OrderRequest(String orderId, com.example.assetupgrade.common.TenantId tenantId, com.example.assetupgrade.common.ActorId actorId, java.util.List<OrderLine> lines, String currency) {}
