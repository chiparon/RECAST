package com.example.assetupgrade.observability;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * Wraps a business action with best-effort observation.
 *
 * <p>The single abstract method {@link #execute(Object)} receives the action (or its
 * description) and returns the observation result. Implementations must never change the
 * business outcome: observation failures are swallowed and the wrapped action is the only
 * thing that determines success. The typed {@link #decorate(Supplier)} helper adapts the
 * generic seam to a supplier-based call site.</p>
 */
@FunctionalInterface
public interface AuditDecorator {

    /** Observes {@code input}, returning a provider-specific observation result. */
    Object execute(Object input);

    /** Observes the supplied action, returning its result untouched. */
    @SuppressWarnings("unchecked")
    default <T> T decorate(Supplier<T> action) {
        Objects.requireNonNull(action, "action");
        return (T) execute(action);
    }
}
