package com.example.assetupgrade.retry;

/**
 * Skeleton seam for RetryPolicyOptions.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record RetryPolicyOptions(int maximumAttempts, java.time.Duration initialDelay, java.time.Duration maximumDelay, double multiplier, boolean jitter) {}
