package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.reconciliation.port.ReconciliationMetricsPort;

/**
 * Emits tenant-scoped counters describing reconciliation outcomes.
 *
 * <p>Metric emission is deliberately best-effort: a metrics backend failure is swallowed so it can
 * never change the reconciliation, checkpoint or audit outcome. Counters are recorded per tenant
 * so the datastore's running-job/event-published observations remain attributable to the owning
 * scope.</p>
 */
public final class ReconciliationMetricsHandler {

    /** Counter incremented once per run. */
    public static final String RUNS = "reconciliation.runs";
    /** Counter incremented once per run that examined no events. */
    public static final String EMPTY_RUNS = "reconciliation.runs.empty";
    /** Counter incremented once per run skipped because the lease was not acquired. */
    public static final String SKIPPED = "reconciliation.runs.skipped";
    /** Counter incremented once per run denied by authorization. */
    public static final String DENIED = "reconciliation.runs.denied";
    /** Counter of events examined by the due-window scan. */
    public static final String EXAMINED = "reconciliation.events.examined";
    /** Counter of events left rerunnable after a failed dispatch. */
    public static final String RETRIED = "reconciliation.events.retried";
    /** Counter of events successfully delivered. */
    public static final String SUCCEEDED = "reconciliation.events.succeeded";
    /** Counter of events that reached a terminal failure. */
    public static final String FAILED = "reconciliation.events.failed";
    /** Counter of events closed as exhausted retry records. */
    public static final String CLEANED = "reconciliation.events.cleaned";

    private final ReconciliationMetricsPort metrics;

    /** Creates a handler with no metrics backend. */
    public ReconciliationMetricsHandler() {
        this(null);
    }

    /** Creates a handler writing through {@code metrics}. */
    public ReconciliationMetricsHandler(ReconciliationMetricsPort metrics) {
        this.metrics = metrics;
    }

    /** Records {@code amount} occurrences of {@code metric} for the tenant; best-effort. */
    public void count(TenantId tenantId, String metric, long amount) {
        if (metrics == null || metric == null || amount == 0) {
            return;
        }
        try {
            metrics.count(tenantId, metric, amount);
        } catch (RuntimeException ignored) {
            // metrics must never change the business outcome
        }
    }

    /** Records one run. */
    public void run(TenantId tenantId) {
        count(tenantId, RUNS, 1);
    }

    /** Records one run that examined no events. */
    public void emptyRun(TenantId tenantId) {
        run(tenantId);
        count(tenantId, EMPTY_RUNS, 1);
    }

    /** Records one skipped run. */
    public void skipped(TenantId tenantId) {
        count(tenantId, SKIPPED, 1);
    }

    /** Records one authorization denial. */
    public void denied(TenantId tenantId) {
        count(tenantId, DENIED, 1);
    }

    /** Records the number of events examined. */
    public void examined(TenantId tenantId, long amount) {
        count(tenantId, EXAMINED, amount);
    }

    /** Records the number of events left rerunnable. */
    public void retried(TenantId tenantId, long amount) {
        count(tenantId, RETRIED, amount);
    }

    /** Records the number of events successfully delivered. */
    public void succeeded(TenantId tenantId, long amount) {
        count(tenantId, SUCCEEDED, amount);
    }

    /** Records the number of events that terminated unsuccessfully. */
    public void failed(TenantId tenantId, long amount) {
        count(tenantId, FAILED, amount);
    }

    /** Records the number of exhausted retry records that were closed. */
    public void cleaned(TenantId tenantId, long amount) {
        count(tenantId, CLEANED, amount);
    }

    /** Records the full outcome counter set for one run. */
    public void record(TenantId tenantId, int examined, int retried, int succeeded, int failed) {
        run(tenantId);
        examined(tenantId, examined);
        retried(tenantId, retried);
        succeeded(tenantId, succeeded);
        failed(tenantId, failed);
        if (examined <= 0) {
            count(tenantId, EMPTY_RUNS, 1);
        }
    }

    /** @return the backing metric port, or {@code null} when none is configured. */
    public ReconciliationMetricsPort port() {
        return metrics;
    }

    /** Compatibility seam; accepts a tenant and records one run. */
    public Object execute(Object input) {
        if (input instanceof TenantId tenantId) {
            run(tenantId);
            return null;
        }
        throw new IllegalArgumentException("Expected a TenantId");
    }
}
