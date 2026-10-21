package com.example.assetupgrade.telemetry;

import com.example.assetupgrade.observability.MetricPort;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Best-effort {@link MetricPort} adapter that records counters and timings locally.
 *
 * <p>Every operation catches its own failures so that a metrics backend (or this adapter)
 * can never change the business or audit outcome; failures are logged with the correlation
 * identity when one is available. An optional delegate forwards observations to a real
 * backend while the in-memory counters remain available for inspection and tests.</p>
 */
public final class MetricsAdapter implements MetricPort {

    private static final System.Logger LOG = System.getLogger(MetricsAdapter.class.getName());

    private final MetricPort delegate;
    private final ConcurrentMap<String, Long> counters = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Long> timings = new ConcurrentHashMap<>();

    public MetricsAdapter() {
        this(null);
    }

    public MetricsAdapter(MetricPort delegate) {
        this.delegate = delegate;
    }

    @Override
    public void increment(String name) {
        increment(name, 1L);
    }

    @Override
    public void increment(String name, long amount) {
        if (name == null || name.isBlank() || amount == 0L) {
            return;
        }
        try {
            counters.merge(name, amount, Long::sum);
        } catch (RuntimeException ex) {
            logFailure("increment", name, ex);
        }
        forwardIncrement(name, amount);
    }

    @Override
    public void increment(String name, Map<String, String> tags) {
        increment(name);
    }

    @Override
    public void timing(String name, Duration duration) {
        if (name == null || name.isBlank() || duration == null) {
            return;
        }
        try {
            timings.merge(name, duration.toNanos(), Long::sum);
        } catch (RuntimeException ex) {
            logFailure("timing", name, ex);
        }
        if (delegate != null) {
            try {
                delegate.timing(name, duration);
            } catch (RuntimeException ex) {
                logFailure("timing", name, ex);
            }
        }
    }

    private void forwardIncrement(String name, long amount) {
        if (delegate == null) {
            return;
        }
        try {
            delegate.increment(name, amount);
        } catch (RuntimeException ex) {
            logFailure("increment", name, ex);
        }
    }

    private static void logFailure(String operation, String name, RuntimeException ex) {
        LOG.log(System.Logger.Level.WARNING, "metrics " + operation + " failed for " + name, ex);
    }

    /** @return the accumulated counter value for {@code name}, or {@code 0}. */
    public long counter(String name) {
        return counters.getOrDefault(name, 0L);
    }

    /** @return an immutable snapshot of the recorded counters. */
    public Map<String, Long> counters() {
        return Map.copyOf(counters);
    }

    /** @return an immutable snapshot of recorded timings, in duration units. */
    public Map<String, Duration> timings() {
        Map<String, Duration> snapshot = new java.util.LinkedHashMap<>();
        timings.forEach((key, nanos) -> snapshot.put(key, Duration.ofNanos(nanos)));
        return Map.copyOf(snapshot);
    }

    /** Clears all locally recorded observations. */
    public void reset() {
        counters.clear();
        timings.clear();
    }
}
