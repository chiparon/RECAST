package com.example.assetupgrade.workflow;

/**
 * Skeleton seam for DeliveryStatus.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum DeliveryStatus { ACCEPTED, REJECTED, RETRYABLE, DUPLICATE, DEAD_LETTERED }
