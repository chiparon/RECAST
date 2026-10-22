package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for DeliveryAttempt.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record DeliveryAttempt(String eventId, com.example.assetupgrade.common.TenantId tenantId, int attemptNumber, boolean accepted, DeliveryStatus status, String detail, java.time.Instant startedAt, java.time.Instant finishedAt) {}
