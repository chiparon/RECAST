package com.example.assetupgrade.common;

/**
 * Skeleton seam for TimeProvider.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface TimeProvider { java.time.Instant now(); }
