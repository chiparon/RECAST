package com.example.assetupgrade.retry;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * Duplicate coordination around an {@link IdempotencyPort}.
 *
 * <p>The coordinator guarantees that a successful operation runs its side effect exactly once for a
 * given {@link IdempotencyKey}: a replayed command returns {@link IdempotentResult#duplicated()} and
 * never invokes the action again. A failed action releases the claim with
 * {@link IdempotencyPort#remove(IdempotencyKey)}, leaving the operation retryable. Transient work is
 * never marked completed.</p>
 */
public final class IdempotencyCoordinator {

    private final IdempotencyPort port;

    public IdempotencyCoordinator(IdempotencyPort port) {
        this.port = Objects.requireNonNull(port, "port");
    }

    /**
     * Runs {@code action} once for {@code key}.
     *
     * @param key    the tenant-qualified idempotency key
     * @param action the side effect to run at most once
     * @param <T>    the action result type
     * @return a duplicate result when the key was already completed, otherwise the action result
     */
    public <T> IdempotentResult<T> execute(IdempotencyKey key, Supplier<T> action) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(action, "action");

        if (port.isCompleted(key)) {
            return IdempotentResult.duplicated();
        }
        if (!port.tryMarkCompleted(key)) {
            // Lost the claim to a concurrent caller: re-read the completion state and return a
            // duplicate either way, so the business side effect is never repeated whether the
            // winner is still in flight or has already finished.
            port.isCompleted(key);
            return IdempotentResult.duplicated();
        }

        T value;
        try {
            value = action.get();
        } catch (RuntimeException failure) {
            // Leave idempotency incomplete so a later retry of the same key is permitted.
            port.remove(key);
            throw failure;
        }
        return IdempotentResult.completed(value);
    }

    /** @return {@code true} when {@code key} has already completed. */
    public boolean isDuplicate(IdempotencyKey key) {
        return port.isCompleted(Objects.requireNonNull(key, "key"));
    }

    /** Marks {@code key} completed when it is not already completed. */
    public void complete(IdempotencyKey key) {
        port.tryMarkCompleted(Objects.requireNonNull(key, "key"));
    }

    /** @return the backing port. */
    public IdempotencyPort port() {
        return port;
    }

    /**
     * Outcome of an idempotent execution.
     *
     * @param duplicate whether the action was skipped because the key was already completed
     * @param value     the action result, {@code null} for a duplicate
     * @param <T>       the action result type
     */
    public record IdempotentResult<T>(boolean duplicate, T value) {

        /** @return a result indicating the operation was already completed. */
        public static <T> IdempotentResult<T> duplicated() {
            return new IdempotentResult<>(true, null);
        }

        /** @return a result carrying the value produced by the single successful invocation. */
        public static <T> IdempotentResult<T> completed(T value) {
            return new IdempotentResult<>(false, value);
        }
    }
}
