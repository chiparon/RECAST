package com.example.assetupgrade.adapters;

import com.example.assetupgrade.common.TimeProvider;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Injectable {@link TimeProvider} backed by the system clock or a controllable fixed instant.
 *
 * <p>The no-argument constructor delegates to the system clock, so production wiring behaves exactly
 * like {@link TimeProvider#system()}. Named {@link #fixed(Instant)} / {@link #at(Instant)} factories
 * create a deterministic clock for retry, lease and scheduler tests. The held instant is stored in an
 * {@link AtomicReference} so the adapter is thread-safe; {@link #now()} never returns {@code null}.</p>
 */
public final class InMemoryClockAdapter implements TimeProvider {

    private final AtomicReference<Instant> override;

    /** Creates a clock backed by the system clock. */
    public InMemoryClockAdapter() {
        this.override = new AtomicReference<>(null);
    }

    /** Creates a clock frozen at {@code fixed} until it is advanced. */
    public InMemoryClockAdapter(Instant fixed) {
        this.override = new AtomicReference<>(Objects.requireNonNull(fixed, "fixed"));
    }

    /** @return a clock backed by the system clock. */
    public static InMemoryClockAdapter system() {
        return new InMemoryClockAdapter();
    }

    /** @return a deterministic clock fixed at {@code instant}. */
    public static InMemoryClockAdapter fixed(Instant instant) {
        return new InMemoryClockAdapter(instant);
    }

    /** Alias of {@link #fixed(Instant)} for call sites that prefer "starting at". */
    public static InMemoryClockAdapter at(Instant instant) {
        return fixed(instant);
    }

    @Override
    public Instant now() {
        Instant held = override.get();
        return held != null ? held : Instant.now();
    }

    /** @return {@code true} while this clock is pinned to an explicit instant. */
    public boolean isFrozen() {
        return override.get() != null;
    }

    /** Pins the clock at its current instant; idempotent. */
    public InMemoryClockAdapter freeze() {
        override.compareAndSet(null, Instant.now());
        return this;
    }

    /** Pins the clock at {@code instant}. */
    public InMemoryClockAdapter freeze(Instant instant) {
        override.set(Objects.requireNonNull(instant, "instant"));
        return this;
    }

    /** Alias of {@link #freeze(Instant)}. */
    public InMemoryClockAdapter set(Instant instant) {
        return freeze(instant);
    }

    /** Advances the held instant by {@code duration}, pinning the clock first when necessary. */
    public InMemoryClockAdapter advance(Duration duration) {
        Objects.requireNonNull(duration, "duration");
        override.updateAndGet(current -> (current == null ? Instant.now() : current).plus(duration));
        return this;
    }

    /** Advances the clock to exactly {@code instant}. */
    public InMemoryClockAdapter advanceTo(Instant instant) {
        return freeze(instant);
    }

    /** Releases the fixed instant and returns to system-clock behavior. */
    public InMemoryClockAdapter reset() {
        override.set(null);
        return this;
    }

    /** Compatibility seam used by adapters that accepted a generic {@code invoke(Object)} placeholder. */
    public Object invoke(Object input) {
        return now();
    }

    /** Compatibility seam exposing {@link #now()} for {@code execute(Object)} call sites. */
    public Object execute(Object input) {
        return now();
    }
}
