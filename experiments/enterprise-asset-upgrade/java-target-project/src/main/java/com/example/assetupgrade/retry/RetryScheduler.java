package com.example.assetupgrade.retry;

import com.example.assetupgrade.common.TimeProvider;
import java.time.Instant;
import java.util.Objects;

/**
 * Clock-aware decision helper that turns a {@link RetryBudget} and a {@link RetryPolicy} into a
 * retry-versus-dead-letter decision.
 *
 * <p>Actual timer execution belongs to provider adapters (for example a Quartz or queue adapter);
 * this type only computes the next run instant and the dead-letter verdict.</p>
 */
public final class RetryScheduler {

    private final RetryPolicy policy;
    private final TimeProvider clock;

    public RetryScheduler(RetryPolicy policy, TimeProvider clock) {
        this.policy = Objects.requireNonNull(policy, "policy");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** @return the instant of the next attempt, or {@code null} when no attempt remains. */
    public Instant nextRun(RetryBudget budget) {
        return decide(budget).nextAttempt();
    }

    /** @return {@code true} when the budget forces the operation into the dead-letter path. */
    public boolean shouldDeadLetter(RetryBudget budget) {
        return decide(budget).deadLetter();
    }

    /**
     * Computes the full decision for {@code budget} without mutating it.
     *
     * @param budget the remaining retry budget
     * @return the retry/next-attempt/dead-letter decision
     */
    public RetryDecision decide(RetryBudget budget) {
        Objects.requireNonNull(budget, "budget");
        if (!budget.hasRemaining()) {
            return new RetryDecision(false, null, true);
        }
        int attempt = budget.consumed() + 1;
        if (!policy.canRetry(attempt) || policy.shouldDeadLetter(attempt)) {
            return new RetryDecision(false, null, true);
        }
        return new RetryDecision(true, policy.nextAttempt(clock.now(), attempt), false);
    }

    /** @return the injected policy. */
    public RetryPolicy policy() {
        return policy;
    }

    /**
     * Immutable outcome of a scheduler decision.
     *
     * @param retry       whether a further attempt should be scheduled
     * @param nextAttempt the instant of the next attempt, {@code null} when not retrying
     * @param deadLetter  whether the exhausted operation must be dead-lettered
     */
    public record RetryDecision(boolean retry, Instant nextAttempt, boolean deadLetter) {}
}
