package com.example.assetupgrade.retry;

import java.util.Objects;

/**
 * Bounded, mutable attempt counter for a single logical operation.
 *
 * <p>The budget is deliberately small and side-effect free apart from counting: callers advance it
 * with {@link #nextAttemptNumber()} and may {@link #reset()} it between independent windows. It is
 * not thread-safe; coordination across threads belongs to the surrounding lock or idempotency port.</p>
 */
public final class RetryBudget {

    private final int maximumAttempts;
    private int consumed;

    /** Creates a budget allowing {@code maximumAttempts} total attempts. */
    public RetryBudget(int maximumAttempts) {
        if (maximumAttempts < 1) {
            throw new IllegalArgumentException("maximumAttempts must be >= 1");
        }
        this.maximumAttempts = maximumAttempts;
    }

    /** Creates a budget from the {@code maximumAttempts} of {@code options}. */
    public RetryBudget(RetryPolicyOptions options) {
        this(Objects.requireNonNull(options, "options").maximumAttempts());
    }

    /** @return the total number of attempts this budget permits. */
    public int maximumAttempts() {
        return maximumAttempts;
    }

    /** @return the number of attempts not yet consumed, never negative. */
    public int remaining() {
        return Math.max(0, maximumAttempts - consumed);
    }

    /** @return the number of attempts already consumed. */
    public int consumed() {
        return consumed;
    }

    /** @return {@code true} while at least one attempt remains. */
    public boolean hasRemaining() {
        return consumed < maximumAttempts;
    }

    /** @return {@code true} when no attempt remains. */
    public boolean exhausted() {
        return !hasRemaining();
    }

    /**
     * Consumes the next attempt.
     *
     * @return the 1-based number of the attempt just consumed
     * @throws IllegalStateException when the budget is exhausted
     */
    public int nextAttemptNumber() {
        if (!hasRemaining()) {
            throw new IllegalStateException("retry budget exhausted");
        }
        return ++consumed;
    }

    /** Returns the counter to its initial state. */
    public void reset() {
        consumed = 0;
    }

    @Override
    public String toString() {
        return "RetryBudget[consumed=" + consumed + ", maximumAttempts=" + maximumAttempts + ']';
    }
}
