package com.example.assetupgrade.common;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Objects;

/**
 * Clock seam used by the application layer so that time is injectable and testable.
 *
 * <p>The single abstract method {@link #now()} is part of the public contract; existing
 * implementors (for example the in-memory clock adapter) continue to compile unchanged.
 * Only static factories and default helpers are added.</p>
 */
@FunctionalInterface
public interface TimeProvider {

    /** @return the current instant according to this provider. */
    Instant now();

    /** @return a provider backed by the system clock. */
    static TimeProvider system() {
        return Instant::now;
    }

    /** @return a provider that always returns {@code instant}. */
    static TimeProvider fixed(Instant instant) {
        Instant fixed = Objects.requireNonNull(instant, "instant");
        return () -> fixed;
    }

    /** @return a snapshot {@link Clock} positioned at {@link #now()}. */
    default Clock asClock() {
        return Clock.fixed(now(), ZoneOffset.UTC);
    }

    /** @return {@link #now()} advanced by {@code duration}. */
    default Instant nowPlus(Duration duration) {
        return now().plus(Objects.requireNonNull(duration, "duration"));
    }
}
