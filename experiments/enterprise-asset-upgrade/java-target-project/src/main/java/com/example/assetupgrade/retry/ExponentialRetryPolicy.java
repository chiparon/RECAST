package com.example.assetupgrade.retry;

import com.example.assetupgrade.common.TimeProvider;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.random.RandomGenerator;

/**
 * Bounded exponential-backoff {@link RetryPolicy}.
 *
 * <p>The history backoff strategy computed {@code delay * 2^(attemptsMade-1)} (optionally jittered);
 * this implementation generalises the base two to {@code options.multiplier()} and clamps the result
 * to {@code options.maximumDelay()}. All arithmetic is performed in milliseconds and overflow-clamped,
 * so a pathological multiplier or attempt number can never produce a negative or unbounded delay.</p>
 */
public final class ExponentialRetryPolicy implements RetryPolicy {

    private final RetryPolicyOptions options;
    private final TimeProvider clock;
    private final RandomGenerator random;

    public ExponentialRetryPolicy(RetryPolicyOptions options) {
        this(options, TimeProvider.system(), RandomGenerator.getDefault());
    }

    public ExponentialRetryPolicy(RetryPolicyOptions options, TimeProvider clock) {
        this(options, clock, RandomGenerator.getDefault());
    }

    public ExponentialRetryPolicy(RetryPolicyOptions options, TimeProvider clock, RandomGenerator random) {
        this.options = Objects.requireNonNull(options, "options");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.random = Objects.requireNonNull(random, "random");
    }

    /** @return the immutable configuration backing this policy. */
    public RetryPolicyOptions options() {
        return options;
    }

    @Override
    public boolean canRetry(int attempt) {
        return attempt < options.maximumAttempts();
    }

    @Override
    public boolean shouldDeadLetter(int attempt) {
        return !canRetry(attempt);
    }

    @Override
    public Instant nextAttempt(Instant now, int attempt) {
        return Objects.requireNonNull(now, "now").plus(delayFor(attempt));
    }

    /** @return the (possibly jittered) delay for the 1-based {@code attempt}. */
    public Duration delayFor(int attempt) {
        return computeDelay(options, attempt, random);
    }

    /** @return the current instant according to the injected clock. */
    public Instant now() {
        return clock.now();
    }

    /**
     * Computes the delay for {@code attempt} using the history strategy arithmetic.
     *
     * @param options the backoff configuration
     * @param attempt the 1-based attempt number; values below 1 are treated as the first attempt
     * @param random  the randomness source used only when jitter is enabled
     * @return a non-negative delay no greater than {@code options.maximumDelay()}
     */
    public static Duration computeDelay(RetryPolicyOptions options, int attempt, RandomGenerator random) {
        Objects.requireNonNull(options, "options");
        Objects.requireNonNull(random, "random");

        long maximumMillis = options.maximumDelay().toMillis();
        long baseMillis = Math.min(options.initialDelay().toMillis(), maximumMillis);

        double exponent = Math.max(0, attempt - 1);
        double growth = Math.pow(options.multiplier(), exponent);
        double computed = baseMillis * growth;

        long delay;
        if (!Double.isFinite(computed) || computed >= (double) maximumMillis) {
            delay = maximumMillis;
        } else {
            delay = Math.max(0L, Math.round(computed));
        }
        delay = Math.min(delay, maximumMillis);

        if (options.jitter()) {
            delay = applyJitter(delay, options.jitterFraction(), random);
        }
        return Duration.ofMillis(delay);
    }

    private static long applyJitter(long delay, double fraction, RandomGenerator random) {
        if (delay <= 0L || !(fraction > 0.0d)) {
            return delay;
        }
        double clamped = Math.min(fraction, 1.0d);
        long minimum = (long) Math.floor(delay * (1.0d - clamped));
        if (minimum < 0L) {
            minimum = 0L;
        }
        if (minimum > delay) {
            minimum = delay;
        }
        long span = delay - minimum;
        if (span <= 0L) {
            return delay;
        }
        long jittered = minimum + (long) Math.floor(random.nextDouble() * span);
        if (jittered < minimum) {
            jittered = minimum;
        } else if (jittered > delay) {
            jittered = delay;
        }
        return jittered;
    }
}
