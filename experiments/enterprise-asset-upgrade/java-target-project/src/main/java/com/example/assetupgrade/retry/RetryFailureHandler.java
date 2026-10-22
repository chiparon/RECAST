package com.example.assetupgrade.retry;

import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.RetryableTransportException;
import com.example.assetupgrade.workflow.WorkflowEvent;
import java.time.Instant;
import java.util.Objects;

/**
 * Converts a failed operation into either a retryable state or a dead letter.
 *
 * <p>A {@link RetryableTransportException} (or, while budget remains, any recoverable
 * {@link RuntimeException}) advances the {@link RetryBudget} and yields the instant of the next
 * attempt. Once the budget is exhausted the failure is published through the
 * {@link DeadLetterCoordinator}. The handler never marks the idempotency key completed, so a failed
 * operation stays retryable.</p>
 */
public final class RetryFailureHandler {

    private final RetryPolicy policy;
    private final DeadLetterCoordinator deadLetters;
    private final TimeProvider clock;

    public RetryFailureHandler(RetryPolicy policy, DeadLetterCoordinator deadLetters, TimeProvider clock) {
        this.policy = Objects.requireNonNull(policy, "policy");
        this.deadLetters = Objects.requireNonNull(deadLetters, "deadLetters");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * Classifies the failure identified by {@code key}.
     *
     * @param key     the tenant-qualified idempotency key of the failed operation
     * @param budget  the operation's remaining retry budget
     * @param failure the failure that occurred
     * @param reason  the human-readable reason, defaulted when blank
     * @return the retry or dead-letter outcome
     */
    public RetryOutcome onFailure(IdempotencyKey key, RetryBudget budget, Throwable failure, String reason) {
        Objects.requireNonNull(key, "key");
        RetryOutcome outcome = evaluate(budget, failure, reason);
        if (outcome.deadLettered()) {
            deadLetters.deliver(key, outcome.reason(), attemptsOf(budget));
        }
        return outcome;
    }

    /**
     * Classifies the failure of a concrete workflow {@code event}, publishing it to the dead-letter
     * boundary when the budget is exhausted.
     */
    public RetryOutcome onFailure(WorkflowEvent event, RetryBudget budget, Throwable failure, String reason) {
        Objects.requireNonNull(event, "event");
        RetryOutcome outcome = evaluate(budget, failure, reason);
        if (outcome.deadLettered()) {
            deadLetters.deliver(event, outcome.reason(), attemptsOf(budget));
        }
        return outcome;
    }

    private RetryOutcome evaluate(RetryBudget budget, Throwable failure, String reason) {
        Objects.requireNonNull(budget, "budget");
        Objects.requireNonNull(failure, "failure");
        String effectiveReason = (reason == null || reason.isBlank()) ? defaultReason(failure) : reason;

        int failedAttempt = Math.max(1, budget.consumed());
        boolean recoverable = failure instanceof RetryableTransportException || failure instanceof RuntimeException;

        if (recoverable && budget.hasRemaining() && policy.canRetry(failedAttempt)) {
            int nextAttemptNumber = budget.nextAttemptNumber();
            Instant next = policy.nextAttempt(clock.now(), nextAttemptNumber);
            return RetryOutcome.retry(next, effectiveReason);
        }
        return RetryOutcome.deadLettered(effectiveReason, failedAttempt);
    }

    private static int attemptsOf(RetryBudget budget) {
        return Math.max(1, budget.consumed());
    }

    private static String defaultReason(Throwable failure) {
        String message = failure.getMessage();
        return (message == null || message.isBlank()) ? failure.getClass().getSimpleName() : message;
    }

    /** @return the injected retry policy. */
    public RetryPolicy policy() {
        return policy;
    }

    /**
     * Immutable outcome of a failure classification.
     *
     * @param retry        whether the operation should be retried
     * @param deadLettered whether the operation was dead-lettered
     * @param nextAttempt  the instant of the next attempt, {@code null} when dead-lettered
     * @param reason       the retained failure reason
     */
    public record RetryOutcome(boolean retry, boolean deadLettered, Instant nextAttempt, String reason) {

        /** @return a retry outcome for {@code nextAttempt}. */
        public static RetryOutcome retry(Instant nextAttempt) {
            return retry(nextAttempt, null);
        }

        /** @return a retry outcome for {@code nextAttempt} carrying {@code reason}. */
        public static RetryOutcome retry(Instant nextAttempt, String reason) {
            return new RetryOutcome(true, false, Objects.requireNonNull(nextAttempt, "nextAttempt"), reason);
        }

        /** @return a dead-letter outcome retaining {@code reason}; {@code attempts} is conveyed to the port. */
        public static RetryOutcome deadLettered(String reason, int attempts) {
            if (attempts < 0) {
                throw new IllegalArgumentException("attempts must not be negative");
            }
            return new RetryOutcome(false, true, null, reason);
        }
    }
}
