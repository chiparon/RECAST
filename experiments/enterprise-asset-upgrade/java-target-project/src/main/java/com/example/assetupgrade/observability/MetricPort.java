package com.example.assetupgrade.observability;

import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * Vendor-neutral metrics seam exposing counter increments and timing observations.
 *
 * <p>The single abstract method {@link #increment(String)} records one occurrence of a
 * named counter; the remaining operations are convenience defaults so that an adapter may
 * implement only the surface it supports. Implementations are expected to be best-effort:
 * a metrics backend failure must never propagate into the business or audit outcome.</p>
 */
@FunctionalInterface
public interface MetricPort {

    /** Records a single occurrence of the named counter. */
    void increment(String name);

    /** Records {@code amount} occurrences of the named counter. */
    default void increment(String name, long amount) {
        for (long i = 0; i < amount; i++) {
            increment(name);
        }
    }

    /** Records a single occurrence of the named counter with dimensional tags. */
    default void increment(String name, Map<String, String> tags) {
        increment(name);
    }

    /** Alias of {@link #increment(String)}. */
    default void count(String name) {
        increment(name);
    }

    /** Alias of {@link #increment(String, long)}. */
    default void count(String name, long amount) {
        increment(name, amount);
    }

    /** Records a timing observation of {@code duration} for the named metric. */
    default void timing(String name, Duration duration) {
        // best-effort default: no-op for adapters that do not support timing
    }

    /** Alias of {@link #timing(String, Duration)}. */
    default void record(String name, Duration duration) {
        timing(name, duration);
    }

    /** Times the supplied action, recording its duration and returning its result. */
    default <T> T time(String name, Supplier<T> action) {
        Objects.requireNonNull(action, "action");
        long start = System.nanoTime();
        try {
            return action.get();
        } finally {
            timing(name, Duration.ofNanos(System.nanoTime() - start));
        }
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #increment(String)}. */
    default Object execute(Object input) {
        if (input instanceof String name) {
            increment(name);
            return null;
        }
        return null;
    }
}
