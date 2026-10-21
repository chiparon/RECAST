package com.example.assetupgrade.telemetry;

import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.HealthStatus;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Pattern;

/**
 * Tenant-neutral aggregation point for {@link HealthCheck} instances.
 *
 * <p>Translated from the Camel health {@code DefaultHealthCheckRegistry}: checks are
 * registered and unregistered, disabled or pattern-excluded checks are skipped, and the
 * aggregate verdict starts from a {@link HealthStatus#DOWN down} initial state and takes
 * the worst state reported by the streamed checks. A check that fails to report is treated
 * as {@code DOWN} rather than propagating, so health evaluation never throws.</p>
 */
public final class HealthEndpoint {

    private final List<HealthCheck> checks = new CopyOnWriteArrayList<>();
    private final String excludePattern;

    public HealthEndpoint() {
        this(null);
    }

    public HealthEndpoint(String excludePattern) {
        this.excludePattern = excludePattern;
    }

    /**
     * Registers a check, returning {@code true} when it was added and {@code false} when it
     * is {@code null} or already registered. Mirrors the Camel registry's boolean contract.
     */
    public boolean register(HealthCheck check) {
        if (check == null || checks.contains(check)) {
            return false;
        }
        return checks.add(check);
    }

    /** Registers a check and returns this endpoint for fluent wiring. */
    public HealthEndpoint add(HealthCheck check) {
        register(check);
        return this;
    }

    /** Removes every check whose identifier equals {@code id}. */
    public boolean unregister(String id) {
        return id != null && checks.removeIf(check -> id.equals(check.id()));
    }

    /** Removes a specific check instance. */
    public boolean unregister(HealthCheck check) {
        return check != null && checks.remove(check);
    }

    /** Removes a specific check instance. */
    public boolean remove(HealthCheck check) {
        return unregister(check);
    }

    /** @return an immutable snapshot of every registered check, included or not. */
    public List<HealthCheck> checks() {
        return List.copyOf(checks);
    }

    /** Streams the enabled checks that are not excluded by the configured pattern. */
    public java.util.stream.Stream<HealthCheck> stream() {
        return checks.stream().filter(this::isIncluded);
    }

    /** @return {@code true} when the check is enabled and not excluded. */
    public boolean isIncluded(HealthCheck check) {
        return check != null && check.isEnabled() && !isExcluded(check);
    }

    /** @return {@code true} when {@code check} matches the exclude pattern. */
    public boolean isExcluded(HealthCheck check) {
        if (check == null || excludePattern == null || excludePattern.isBlank()) {
            return false;
        }
        String id = check.id();
        if (id == null) {
            return false;
        }
        for (String token : excludePattern.trim().split("\\s*,\\s*")) {
            if (!token.isEmpty() && globMatches(token, id)) {
                return true;
            }
        }
        return false;
    }

    /**
     * @return the aggregate verdict: the worst state reported by the participating checks,
     *         or {@code DOWN} when no check participates (the default initial state).
     */
    public HealthStatus status() {
        java.util.List<HealthStatus> reported = new java.util.ArrayList<>();
        for (HealthCheck check : checks) {
            if (isIncluded(check)) {
                reported.add(evaluate(check));
            }
        }
        return HealthStatus.worst(reported);
    }

    /** Alias of {@link #status()}. */
    public HealthStatus overall() {
        return status();
    }

    /** Alias of {@link #status()}. */
    public HealthStatus overallStatus() {
        return status();
    }

    /** Alias of {@link #status()}. */
    public HealthStatus health() {
        return status();
    }

    /** Compatibility alias of {@link #status()}. */
    public HealthStatus call() {
        return status();
    }

    /** @return {@code true} when the aggregate verdict is {@code UP}. */
    public boolean isUp() {
        return status().isUp();
    }

    /** @return per-check verdicts keyed by check identifier, skipping disabled/excluded checks. */
    public Map<String, HealthStatus> statuses() {
        Map<String, HealthStatus> result = new LinkedHashMap<>();
        for (HealthCheck check : checks) {
            if (isIncluded(check)) {
                result.put(check.id(), evaluate(check));
            }
        }
        return Map.copyOf(result);
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #status()}. */
    public Object execute(Object input) {
        return status();
    }

    private static HealthStatus evaluate(HealthCheck check) {
        try {
            HealthStatus verdict = check.status();
            return verdict == null ? HealthStatus.down("check " + check.id() + " returned no status") : verdict;
        } catch (RuntimeException ex) {
            return HealthStatus.of(HealthStatus.DOWN, Map.of(
                    "check", String.valueOf(check.id()),
                    "error", ex.getClass().getSimpleName()));
        }
    }

    private static boolean globMatches(String pattern, String value) {
        StringBuilder regex = new StringBuilder();
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            switch (c) {
                case '*' -> regex.append(".*");
                case '?' -> regex.append('.');
                default -> regex.append(Pattern.quote(String.valueOf(c)));
            }
        }
        return value.matches(regex.toString());
    }
}
