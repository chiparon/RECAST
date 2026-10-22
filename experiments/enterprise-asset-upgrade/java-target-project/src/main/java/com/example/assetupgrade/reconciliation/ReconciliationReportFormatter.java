package com.example.assetupgrade.reconciliation;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Renders a {@link ReconciliationReport} as the run summary.
 *
 * <p>The formatter is provider-neutral and side-effect free: it turns the examined/retried/
 * succeeded/failed counts, the dispatched event identities and the persisted checkpoint id into a
 * compact textual summary plus a string-keyed field map, mirroring the historical datastore's
 * marshalled-result rendering.</p>
 */
public final class ReconciliationReportFormatter {

    /** Creates a stateless formatter. */
    public ReconciliationReportFormatter() {
    }

    /** @return the compact textual summary of {@code report}. */
    public String format(ReconciliationReport report) {
        if (report == null) {
            return "reconciliation report: unavailable";
        }
        String checkpoint = report.checkpoint() == null ? "none" : report.checkpoint();
        int dispatched = report.eventIds() == null ? 0 : report.eventIds().size();
        return "reconciliation examined=" + report.examined()
                + " retried=" + report.retried()
                + " succeeded=" + report.succeeded()
                + " failed=" + report.failed()
                + " dispatched=" + dispatched
                + " checkpoint=" + checkpoint;
    }

    /** Alias of {@link #format(ReconciliationReport)}. */
    public String summary(ReconciliationReport report) {
        return format(report);
    }

    /** Renders the report as a string-keyed field map. */
    public Map<String, String> toMap(ReconciliationReport report) {
        Map<String, String> fields = new LinkedHashMap<>();
        if (report == null) {
            fields.put("status", "unavailable");
            return fields;
        }
        fields.put("examined", Integer.toString(report.examined()));
        fields.put("retried", Integer.toString(report.retried()));
        fields.put("succeeded", Integer.toString(report.succeeded()));
        fields.put("failed", Integer.toString(report.failed()));
        fields.put("dispatched", Integer.toString(report.eventIds() == null ? 0 : report.eventIds().size()));
        if (report.checkpoint() != null) {
            fields.put("checkpoint", report.checkpoint());
        }
        if (report.eventIds() != null && !report.eventIds().isEmpty()) {
            fields.put("eventIds", String.join(",", report.eventIds()));
        }
        return fields;
    }

    /** Compatibility seam; renders a report or passes through a pre-rendered summary. */
    public Object execute(Object input) {
        if (input == null) {
            return format(null);
        }
        if (input instanceof ReconciliationReport report) {
            return format(report);
        }
        if (input instanceof String text) {
            return text;
        }
        throw new IllegalArgumentException("Expected a ReconciliationReport");
    }
}
