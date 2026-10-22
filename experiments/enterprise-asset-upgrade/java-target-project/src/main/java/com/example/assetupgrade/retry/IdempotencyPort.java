package com.example.assetupgrade.retry;

/**
 * Tenant-scoped dedup store behind which a provider adapter (in-memory, JDBC, Redis, ...) is hidden.
 *
 * <p>Keys are always tenant-qualified by {@link IdempotencyKey}; an implementation must never
 * treat the same {@code (operation, subjectId)} from two tenants as the same logical unit.</p>
 */
public interface IdempotencyPort {

    /** @return {@code true} when {@code key} has already completed successfully. */
    boolean isCompleted(IdempotencyKey key);

    /**
     * Atomically claims {@code key}.
     *
     * @return {@code true} when this caller won the claim, {@code false} when it was already claimed
     */
    boolean tryMarkCompleted(IdempotencyKey key);

    /** Removes {@code key} so that a failed operation remains retryable. */
    void remove(IdempotencyKey key);

    /**
     * Completes {@code key} only when it is not already completed.
     *
     * @return {@code true} when this call marked the key, {@code false} when it was already completed
     */
    default boolean markCompletedIfAbsent(IdempotencyKey key) {
        if (isCompleted(key)) {
            return false;
        }
        return tryMarkCompleted(key);
    }
}
