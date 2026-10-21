package com.example.assetupgrade.audit;

import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.observability.MetricPort;
import com.example.assetupgrade.observability.TracePort;

import java.util.List;
import java.util.Objects;

/**
 * Makes audit-persistence failures observable and applies the failure policy.
 *
 * <p>Wraps an {@link AuditPort}: on a successful append the entry is simply persisted. When
 * the append fails, the handler emits an observable failure signal (a metric increment, a
 * trace span and a log line), consults
 * {@link AuditFailurePolicy#completionMayBeReportedWhenAuditFails(AuditEntry)}, and - when
 * the policy forbids reporting completion - rethrows a {@link StorageFailureException}. A
 * failed audit is therefore never silently converted into success. Telemetry emission is
 * best-effort and can never itself break the handler.</p>
 */
public final class AuditFailureHandler implements AuditPort {

    /** Metric name incremented for every observable audit failure. */
    public static final String AUDIT_FAILURE_METRIC = "audit.failure";

    private static final System.Logger LOG = System.getLogger(AuditFailureHandler.class.getName());

    private final AuditPort delegate;
    private final AuditFailurePolicy policy;
    private final MetricPort metrics;
    private final TracePort tracer;

    public AuditFailureHandler() {
        this(null, null, null, null);
    }

    public AuditFailureHandler(AuditPort delegate) {
        this(delegate, null, null, null);
    }

    public AuditFailureHandler(AuditPort delegate, AuditFailurePolicy policy) {
        this(delegate, policy, null, null);
    }

    public AuditFailureHandler(AuditPort delegate, AuditFailurePolicy policy, MetricPort metrics) {
        this(delegate, policy, metrics, null);
    }

    public AuditFailureHandler(AuditPort delegate, AuditFailurePolicy policy, MetricPort metrics, TracePort tracer) {
        this.delegate = delegate;
        this.policy = policy;
        this.metrics = metrics;
        this.tracer = tracer;
    }

    @Override
    public void append(AuditEntry entry) {
        Objects.requireNonNull(entry, "entry");
        try {
            if (delegate != null) {
                delegate.append(entry);
            }
        } catch (RuntimeException failure) {
            signal(entry, failure);
            boolean mayReport = policy != null && policy.completionMayBeReportedWhenAuditFails(entry);
            if (!mayReport) {
                throw new StorageFailureException("audit append failed; completion must not be reported", failure);
            }
        }
    }

    /** Alias of {@link #append(AuditEntry)}. */
    public void handle(AuditEntry entry) {
        append(entry);
    }

    /** @return {@code true} when the configured policy allows reporting completion after a failure. */
    public boolean completionMayBeReported(AuditEntry entry) {
        return policy != null && policy.completionMayBeReportedWhenAuditFails(entry);
    }

    @Override
    public List<AuditEntry> query(AuditQuery query) {
        Objects.requireNonNull(query, "query");
        return delegate == null ? List.of() : delegate.query(query);
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #append(AuditEntry)}. */
    public Object execute(Object input) {
        if (input instanceof AuditEntry entry) {
            append(entry);
            return entry;
        }
        if (input instanceof AuditQuery query) {
            return query(query);
        }
        throw new IllegalArgumentException("expected an AuditEntry or AuditQuery but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    private void signal(AuditEntry entry, RuntimeException failure) {
        if (metrics != null) {
            try {
                metrics.increment(AUDIT_FAILURE_METRIC);
            } catch (RuntimeException ignored) {
                // telemetry must never change the outcome
            }
        }
        if (tracer != null) {
            try {
                TracePort.Span span = tracer.start("audit.append.failure");
                span.error(failure);
                span.finish();
            } catch (RuntimeException ignored) {
                // telemetry must never change the outcome
            }
        }
        try {
            LOG.log(System.Logger.Level.WARNING, "audit append failed for tenant "
                    + (entry.tenantId() == null ? "?" : entry.tenantId().value())
                    + " action " + entry.action() + " status " + entry.status(), failure);
        } catch (RuntimeException ignored) {
            // logging must never change the outcome
        }
    }
}
