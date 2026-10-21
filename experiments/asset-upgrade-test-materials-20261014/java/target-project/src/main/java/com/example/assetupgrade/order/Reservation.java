package com.example.assetupgrade.order;

/**
 * Skeleton seam for Reservation.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record Reservation(String reservationId, com.example.assetupgrade.common.TenantId tenantId, String orderId, java.util.Map<String,Integer> quantities, java.time.Instant expiresAt, boolean released) {}
