package com.example.assetupgrade.retry;

import java.time.Duration;
import java.util.Objects;

/**
 * Bounded exponential-backoff configuration.
 *
 * <p>Translated from the history backoff strategy: the delay for attempt {@code n} is
 * {@code initialDelay * multiplier^(n-1)} clamped to {@code maximumDelay}; when {@code jitter}
 * is enabled the delay is drawn uniformly from {@code [delay*(1-jitterFraction), delay]}.</p>
 *
 * @param maximumAttempts total attempts allowed, at least 1
 * @param initialDelay    delay applied to the first retry, strictly positive
 * @param maximumDelay    upper bound for any delay, strictly positive and not below {@code initialDelay}
 * @param multiplier      exponential growth factor, at least 1.0
 * @param jitter          whether the computed delay is randomised
 */
public record RetryPolicyOptions(int maximumAttempts, Duration initialDelay, Duration maximumDelay,
        double multiplier, boolean jitter) {

    /** Default fractional window removed from the top of a delayed attempt when jittering. */
    public static final double DEFAULT_JITTER_FRACTION = 0.2d;

    public RetryPolicyOptions {
        if (maximumAttempts < 1) {
            throw new IllegalArgumentException("maximumAttempts must be >= 1");
        }
        Objects.requireNonNull(initialDelay, "initialDelay");
        Objects.requireNonNull(maximumDelay, "maximumDelay");
        if (initialDelay.isZero() || initialDelay.isNegative()) {
            throw new IllegalArgumentException("initialDelay must be positive");
        }
        if (maximumDelay.isZero() || maximumDelay.isNegative()) {
            throw new IllegalArgumentException("maximumDelay must be positive");
        }
        if (initialDelay.compareTo(maximumDelay) > 0) {
            throw new IllegalArgumentException("initialDelay must not exceed maximumDelay");
        }
        if (!(multiplier >= 1.0d)) {
            throw new IllegalArgumentException("multiplier must be >= 1.0");
        }
    }

    /** Creates an exponential-backoff configuration. */
    public static RetryPolicyOptions exponential(int maximumAttempts, Duration initialDelay, Duration maximumDelay,
            double multiplier, boolean jitter) {
        return new RetryPolicyOptions(maximumAttempts, initialDelay, maximumDelay, multiplier, jitter);
    }

    /** @return the fraction of the computed delay that jitter may remove. */
    public double jitterFraction() {
        return DEFAULT_JITTER_FRACTION;
    }
}
