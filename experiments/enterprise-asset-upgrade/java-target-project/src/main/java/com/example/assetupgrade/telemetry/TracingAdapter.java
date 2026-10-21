package com.example.assetupgrade.telemetry;

import com.example.assetupgrade.observability.TracePort;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Best-effort {@link TracePort} adapter.
 *
 * <p>Starts spans and records their duration locally for inspection. Starting or finishing
 * a span never throws: on failure a no-op span is returned so that tracing can never
 * change the business or audit outcome.</p>
 */
public final class TracingAdapter implements TracePort {

    private static final System.Logger LOG = System.getLogger(TracingAdapter.class.getName());

    private final List<SpanRecord> spans = new CopyOnWriteArrayList<>();

    @Override
    public Span start(String name) {
        try {
            String spanName = name == null || name.isBlank() ? "span" : name.trim();
            long startedAt = System.nanoTime();
            return new Span() {
                private final AtomicBoolean finished = new AtomicBoolean();

                @Override
                public void finish() {
                    if (!finished.compareAndSet(false, true)) {
                        return;
                    }
                    try {
                        spans.add(new SpanRecord(spanName, Duration.ofNanos(System.nanoTime() - startedAt)));
                    } catch (RuntimeException ex) {
                        LOG.log(System.Logger.Level.WARNING, "failed to record span " + spanName, ex);
                    }
                }
            };
        } catch (RuntimeException ex) {
            LOG.log(System.Logger.Level.WARNING, "failed to start span", ex);
            return Span.noop();
        }
    }

    /** @return an immutable snapshot of finished spans, oldest first. */
    public List<SpanRecord> spans() {
        return List.copyOf(spans);
    }

    /** Clears all recorded spans. */
    public void reset() {
        spans.clear();
    }

    /** A finished span observation. */
    public record SpanRecord(String name, Duration duration) {
    }
}
