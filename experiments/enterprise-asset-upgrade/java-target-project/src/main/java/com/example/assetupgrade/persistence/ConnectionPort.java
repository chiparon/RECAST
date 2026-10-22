package com.example.assetupgrade.persistence;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * Provider-neutral connection handle.
 *
 * <p>{@link #withConnection(Supplier)} lends an open handle to {@code operation} and never leaks a
 * closed handle; a provider failure surfaces as
 * {@link com.example.assetupgrade.error.StorageFailureException}. JDBC details stay out of the port
 * and belong to a provider adapter.</p>
 */
public interface ConnectionPort {

    /** @return {@code true} while the underlying connection is usable. */
    boolean isOpen();

    /** Runs {@code operation} against an open connection and returns its result. */
    <T> T withConnection(Supplier<T> operation);

    /** Releases the underlying connection. The default implementation is a no-op. */
    default void close() {
        // Provider adapters override; ports used only for lending need no closing.
    }

    /** Compatibility seam dispatching a {@link Supplier} or {@link Runnable} through the connection. */
    default Object execute(Object input) {
        if (input instanceof Supplier<?> supplier) {
            return withConnection(supplier::get);
        }
        if (input instanceof Runnable action) {
            Objects.requireNonNull(action, "action");
            withConnection(() -> {
                action.run();
                return null;
            });
            return null;
        }
        throw new IllegalArgumentException("expected a Supplier or Runnable but got "
                + (input == null ? "null" : input.getClass().getName()));
    }
}
