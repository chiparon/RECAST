package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderStatus.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum OrderStatus { DRAFT, VALIDATING, RESERVED, COMMITTING, ACCEPTED, REJECTED, ROLLED_BACK }
