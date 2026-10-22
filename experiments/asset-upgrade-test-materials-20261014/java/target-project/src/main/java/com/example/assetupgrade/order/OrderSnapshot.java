package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderSnapshot.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OrderSnapshot(OrderRequest request, OrderStatus status, Reservation reservation, long totalMinor, java.time.Instant updatedAt, int version) {}
