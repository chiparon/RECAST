package com.example.assetupgrade.retry;

/**
 * Skeleton seam for IdempotencyPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface IdempotencyPort { boolean isCompleted(IdempotencyKey key); boolean tryMarkCompleted(IdempotencyKey key); void remove(IdempotencyKey key); }
