package com.example.assetupgrade.persistence;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * Atomic transaction boundary.
 *
 * <p>The supplier passed to {@link #inTransaction(Supplier)} runs exactly once inside a single atomic
 * boundary; a {@link RuntimeException} thrown by the supplier rolls the boundary back, and no partial
 * write is visible outside it. The typed method
 * {@code <T> T inTransaction(Supplier<T>)} is the fixed public contract (invariant
 * {@code invariant-07fafb3be4037994}) and must not be changed. No JDBC or provider type appears here;
 * a provider adapter implements this port elsewhere.</p>
 */
public interface TransactionPort {

    /** Runs {@code operation} exactly once within a single atomic boundary and returns its result. */
    <T> T inTransaction(Supplier<T> operation);

    /** Runs {@code action} within a single atomic boundary. */
    default void inTransaction(Runnable action) {
        Objects.requireNonNull(action, "action");
        inTransaction(() -> {
            action.run();
            return null;
        });
    }

    /** Compatibility seam dispatching a {@link Supplier} or {@link Runnable} through the boundary. */
    default Object execute(Object input) {
        if (input instanceof Supplier<?> supplier) {
            return inTransaction(supplier::get);
        }
        if (input instanceof Runnable action) {
            inTransaction(action);
            return null;
        }
        throw new IllegalArgumentException("expected a Supplier or Runnable but got "
                + (input == null ? "null" : input.getClass().getName()));
    }
}
