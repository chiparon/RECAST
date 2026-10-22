package com.example.assetupgrade.telemetry;

import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.HealthStatus;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Readiness aggregation over the enabled repository of health checks.
 *
 * <p>Translated from the Camel health {@code HealthCheckRegistryRepository} enabled-stream
 * pattern: only enabled checks participate, and an individual check failure is reported as
 * {@code DOWN} rather than thrown. Readiness is {@code UP} when no participating check
 * reports unhealthy, including the empty case, and never mutates business state.</p>
 */
public final class ReadinessProbe {

    private final HealthEndpoint endpoint;

    public ReadinessProbe() {
        this(new HealthEndpoint());
    }

    public ReadinessProbe(HealthEndpoint endpoint) {
        this.endpoint = endpoint == null ? new HealthEndpoint() : endpoint;
    }

    /** Creates a probe backed by a fresh endpoint registering every supplied check. */
    public ReadinessProbe(Collection<HealthCheck> checks) {
        this();
        if (checks != null) {
            checks.forEach(this::register);
        }
    }

    /** Registers a check, returning {@code true} when it was added. */
    public boolean register(HealthCheck check) {
        return endpoint.register(check);
    }

    /** Registers a check and returns this probe for fluent wiring. */
    public ReadinessProbe add(HealthCheck check) {
        endpoint.add(check);
        return this;
    }

    /** Streams the enabled, non-excluded checks participating in readiness. */
    public Stream<HealthCheck> stream() {
        return endpoint.stream();
    }

    /** @return {@code UP} when every participating check is up, otherwise {@code DOWN}. */
    public HealthStatus check() {
        Map<String, String> failures = new LinkedHashMap<>();
        var iterator = stream().iterator();
        while (iterator.hasNext()) {
            HealthCheck healthCheck = iterator.next();
            HealthStatus verdict;
            try {
                verdict = healthCheck.status();
            } catch (RuntimeException ex) {
                verdict = null;
                failures.put(healthCheck.id(), ex.getClass().getSimpleName());
            }
            if (verdict == null) {
                failures.putIfAbsent(healthCheck.id(), "no status");
            } else if (!verdict.isUp()) {
                failures.put(healthCheck.id(), verdict.marker());
            }
        }
        if (failures.isEmpty()) {
            return HealthStatus.up();
        }
        return HealthStatus.of(HealthStatus.DOWN, failures);
    }

    /** Alias of {@link #check()}. */
    public HealthStatus status() {
        return check();
    }

    /** Alias of {@link #check()}. */
    public HealthStatus probe() {
        return check();
    }

    /** Compatibility alias of {@link #check()}. */
    public HealthStatus call() {
        return check();
    }

    /** @return {@code true} when the probe reports ready. */
    public boolean isReady() {
        return check().isUp();
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #check()}. */
    public Object execute(Object input) {
        return check();
    }
}
