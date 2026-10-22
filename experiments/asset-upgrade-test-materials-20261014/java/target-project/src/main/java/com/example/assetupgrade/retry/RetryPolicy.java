package com.example.assetupgrade.retry;

/**
 * Skeleton seam for RetryPolicy.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface RetryPolicy { boolean canRetry(int attempt); java.time.Instant nextAttempt(java.time.Instant now, int attempt); boolean shouldDeadLetter(int attempt); }
