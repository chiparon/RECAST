package com.example.assetupgrade.retry;

/**
 * Caller-bound retry policy contract.
 *
 * <p>Attempt numbers are 1-based: the first delivery attempt is {@code 1}. A {@code canRetry}
 * result of {@code true} for the just-failed attempt means the operation may run again; the next
 * wall-clock instant is obtained from {@link #nextAttempt(java.time.Instant, int)}.</p>
 */
public interface RetryPolicy {

    /** @return {@code true} when an attempt numbered {@code attempt} may be retried. */
    boolean canRetry(int attempt);

    /** @return the instant at which attempt {@code attempt} should be scheduled after {@code now}. */
    java.time.Instant nextAttempt(java.time.Instant now, int attempt);

    /** @return {@code true} when an attempt numbered {@code attempt} has exhausted its budget. */
    boolean shouldDeadLetter(int attempt);
}
