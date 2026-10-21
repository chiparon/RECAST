package com.example.assetupgrade.observability;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * Vendor-neutral distributed-tracing seam exposing span start and finish operations.
 *
 * <p>The single abstract method {@link #start(String)} begins a named span and returns a
 * handle whose {@link Span#finish()} closes it. Implementations must be best-effort: a
 * tracing backend failure must never alter the business or audit outcome.</p>
 */
@FunctionalInterface
public interface TracePort {

    /** Starts a span with the supplied name. */
    Span start(String name);

    /** Alias of {@link #start(String)}. */
    default Span startSpan(String name) {
        return start(name);
    }

    /** Alias of {@link #start(String)}. */
    default Span begin(String name) {
        return start(name);
    }

    /** Runs {@code action} within a span, finishing the span even when the action fails. */
    default <T> T trace(String name, Supplier<T> action) {
        Objects.requireNonNull(action, "action");
        Span span = start(name);
        try {
            return action.get();
        } catch (RuntimeException ex) {
            span.error(ex);
            throw ex;
        } finally {
            span.finish();
        }
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #start(String)}. */
    default Object execute(Object input) {
        return input instanceof String name ? start(name) : Span.noop();
    }

    /**
     * A started span. The single abstract method {@link #finish()} closes the span; closing
     * is idempotent for well-behaved implementations.
     */
    @FunctionalInterface
    interface Span extends AutoCloseable {

        /** Finishes this span. */
        void finish();

        @Override
        default void close() {
            finish();
        }

        /** Attaches a string tag to the span; the default ignores it. */
        default void tag(String key, String value) {
            // best-effort default: no-op
        }

        /** Records that the span failed with {@code error}; the default ignores it. */
        default void error(Throwable error) {
            // best-effort default: no-op
        }

        /** @return a span that records nothing. */
        static Span noop() {
            return () -> {
                // intentionally empty
            };
        }
    }
}
