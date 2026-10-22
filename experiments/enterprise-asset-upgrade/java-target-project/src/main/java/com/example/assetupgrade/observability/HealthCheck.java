package com.example.assetupgrade.observability;

import java.util.Map;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * Vendor-neutral seam describing a single named health probe.
 *
 * <p>Translated from the Camel health {@code AbstractHealthCheck} contract (identifier,
 * enabled flag, meta-data and a call producing a state) without any Camel or logging
 * coupling. The single abstract method is {@link #status()} so that a probe can be
 * expressed as a lambda; {@link #call()}, {@link #check()} and {@link #execute(Object)}
 * are compatibility aliases that resolve to the same verdict. A disabled check reports
 * {@link #isEnabled()} as {@code false} and aggregators skip it.</p>
 */
@FunctionalInterface
public interface HealthCheck {

    /** @return the current verdict of this probe; never {@code null}. */
    HealthStatus status();

    /** @return the stable identifier used to register and report this probe. */
    default String id() {
        return "health-check";
    }

    /** @return {@code true} when the probe participates in health aggregation. */
    default boolean isEnabled() {
        return true;
    }

    /** Alias of {@link #isEnabled()} for callers that prefer bean-style naming. */
    default boolean enabled() {
        return isEnabled();
    }

    /** @return immutable provider-neutral meta-data describing the probe. */
    default Map<String, String> metadata() {
        return Map.of();
    }

    /** Alias of {@link #metadata()} matching the Camel accessor name. */
    default Map<String, String> metaData() {
        return metadata();
    }

    /** Compatibility alias of {@link #status()}. */
    default HealthStatus call() {
        return status();
    }

    /** Compatibility alias of {@link #status()}. */
    default HealthStatus check() {
        return status();
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #status()}. */
    default Object execute(Object input) {
        return status();
    }

    /** Creates a probe with the supplied identifier backed by {@code supplier}. */
    static HealthCheck of(String id, Supplier<HealthStatus> supplier) {
        Objects.requireNonNull(supplier, "supplier");
        String checkId = id == null || id.isBlank() ? "health-check" : id.trim();
        return new HealthCheck() {
            @Override
            public String id() {
                return checkId;
            }

            @Override
            public HealthStatus status() {
                HealthStatus verdict = supplier.get();
                return verdict == null ? HealthStatus.down("probe returned no status") : verdict;
            }
        };
    }

    /** Creates a probe that always reports {@link HealthStatus#up()}. */
    static HealthCheck alwaysUp(String id) {
        return of(id, HealthStatus::up);
    }

    /** Creates a disabled probe reporting the supplied verdict only when enabled. */
    static HealthCheck disabled(String id, HealthStatus status) {
        Objects.requireNonNull(status, "status");
        return new HealthCheck() {
            @Override
            public String id() {
                return id == null || id.isBlank() ? "health-check" : id.trim();
            }

            @Override
            public boolean isEnabled() {
                return false;
            }

            @Override
            public HealthStatus status() {
                return status;
            }
        };
    }
}
