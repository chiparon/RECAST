package com.example.assetupgrade.workflow;

import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.RetryableTransportException;
import com.example.assetupgrade.retry.RetryPolicy;

import java.time.Instant;
import java.util.Objects;

/**
 * Applies the retry policy to a failed workflow delivery attempt.
 *
 * <p>Attempt numbers are 1-based. A failed attempt {@code n} is retryable while the configured
 * {@link RetryPolicy} still permits it ({@code policy.canRetry(n)}); the next attempt is then
 * scheduled at {@code policy.nextAttempt(now, n + 1)}. When the policy is exhausted - or no policy
 * is configured at all - the failure is classified as dead-lettered.</p>
 */
public final class WorkflowRetryCoordinator {

    private final RetryPolicy policy;
    private final TimeProvider clock;

    /** Creates a coordinator with no policy; every failure is treated as exhausted. */
    public WorkflowRetryCoordinator() {
        this(null, null);
    }

    /** Creates a coordinator using {@code policy} and the system clock. */
    public WorkflowRetryCoordinator(RetryPolicy policy) {
        this(policy, null);
    }

    /** Creates a coordinator using {@code policy} and {@code clock}. */
    public WorkflowRetryCoordinator(RetryPolicy policy, TimeProvider clock) {
        this.policy = policy;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** @return {@code true} when a failed attempt numbered {@code attemptNumber} may be retried. */
    public boolean canRetry(int attemptNumber) {
        int attempt = Math.max(1, attemptNumber);
        return policy != null && policy.canRetry(attempt) && !policy.shouldDeadLetter(attempt);
    }

    /** @return {@code true} when a failed attempt numbered {@code attemptNumber} is exhausted. */
    public boolean shouldDeadLetter(int attemptNumber) {
        return !canRetry(attemptNumber);
    }

    /** @return the instant of the attempt following failed attempt {@code attemptNumber}. */
    public Instant nextAttempt(int attemptNumber) {
        int next = Math.max(1, attemptNumber) + 1;
        return policy == null ? null : policy.nextAttempt(clock.now(), next);
    }

    /**
     * Classifies the failure of attempt {@code attemptNumber}.
     *
     * @param attemptNumber the 1-based number of the just-failed attempt
     * @param failure       the failure that occurred; {@code null} means an unsuccessful dispatch
     * @param reason        the human-readable reason, defaulted when blank
     * @return a retry decision carrying the next-attempt instant, or a dead-letter decision
     */
    public RetryDecision onFailure(int attemptNumber, Throwable failure, String reason) {
        int attempt = Math.max(1, attemptNumber);
        String effectiveReason = (reason == null || reason.isBlank()) ? defaultReason(failure) : reason;
        if (canRetry(attempt)) {
            return RetryDecision.retry(attempt, nextAttempt(attempt), effectiveReason);
        }
        return RetryDecision.deadLetter(attempt, effectiveReason);
    }

    /** Classifies the failure of a concrete {@code event}; the event is not mutated. */
    public RetryDecision onFailure(WorkflowEvent event, int attemptNumber, Throwable failure, String reason) {
        Objects.requireNonNull(event, "event");
        return onFailure(attemptNumber, failure, reason);
    }

    /** @return the injected retry policy, or {@code null} when none is configured. */
    public RetryPolicy policy() {
        return policy;
    }

    /** @return the injected time source. */
    public TimeProvider clock() {
        return clock;
    }

    /**
     * Compatibility seam; accepts an attempt number (as {@link Integer}) and classifies its failure.
     */
    public Object execute(Object input) {
        if (input instanceof Integer attemptNumber) {
            return onFailure(attemptNumber, null, null);
        }
        throw new IllegalArgumentException("Expected an Integer attempt number");
    }

    private static String defaultReason(Throwable failure) {
        if (failure == null) {
            return "dispatch failed";
        }
        if (failure instanceof RetryableTransportException) {
            String message = failure.getMessage();
            return (message == null || message.isBlank()) ? "retryable transport failure" : message;
        }
        String message = failure.getMessage();
        return (message == null || message.isBlank()) ? failure.getClass().getSimpleName() : message;
    }

    /**
     * Immutable retry-versus-dead-letter decision.
     *
     * @param retry        whether a further attempt should be scheduled
     * @param deadLettered whether the attempt is exhausted and must be dead-lettered
     * @param nextAttemptAt the instant of the next attempt, {@code null} when dead-lettered
     * @param attemptNumber the 1-based number of the just-failed attempt
     * @param reason        the retained failure reason
     */
    public record RetryDecision(boolean retry, boolean deadLettered, Instant nextAttemptAt,
                                int attemptNumber, String reason) {

        /** @return a retry decision for the given next attempt. */
        public static RetryDecision retry(int attemptNumber, Instant nextAttemptAt, String reason) {
            return new RetryDecision(true, false, Objects.requireNonNull(nextAttemptAt, "nextAttemptAt"),
                    attemptNumber, reason);
        }

        /** @return a dead-letter decision for the exhausted attempt. */
        public static RetryDecision deadLetter(int attemptNumber, String reason) {
            return new RetryDecision(false, true, null, attemptNumber, reason);
        }
    }
}
