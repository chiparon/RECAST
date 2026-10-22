package com.example.assetupgrade.common;

/**
 * Skeleton seam for PageRequest.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record PageRequest(int offset, int limit, String cursor) {}
