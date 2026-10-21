package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderLine.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OrderLine(String sku, int quantity, long unitPriceMinor) {}
