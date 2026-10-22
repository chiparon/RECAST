package com.example.assetupgrade.common;

/**
 * Skeleton seam for PageResult.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record PageResult<T>(java.util.List<T> items, String nextCursor, boolean hasMore) {}
