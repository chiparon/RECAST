package com.example.assetupgrade.attachment;

import com.example.assetupgrade.observability.MetricPort;

/**
 * Emits best-effort counters describing attachment intake outcomes.
 *
 * <p>Metric emission is deliberately best-effort: a metrics backend failure is swallowed so
 * it can never change the intake, quarantine, release or audit outcome. All counters are
 * tenant-agnostic names; dimensional tagging is left to the adapter when required.</p>
 */
public final class AttachmentMetricsHandler {

    /** Counter incremented for every intake attempt. */
    public static final String INTAKE_ATTEMPTS = "attachment.intake.attempts";
    /** Counter incremented when an attachment is received and stored. */
    public static final String INTAKE_ACCEPTED = "attachment.intake.accepted";
    /** Counter incremented when an attachment is rejected or quarantined. */
    public static final String INTAKE_REJECTED = "attachment.intake.rejected";
    /** Counter incremented when a duplicate command is detected. */
    public static final String INTAKE_DUPLICATE = "attachment.intake.duplicate";
    /** Counter incremented for every quarantine decision. */
    public static final String QUARANTINED = "attachment.quarantine";
    /** Counter incremented for every successful release. */
    public static final String RELEASED = "attachment.release";
    /** Counter incremented for every security denial. */
    public static final String DENIED = "attachment.denied";

    private final MetricPort metrics;

    /** Creates a handler with no metrics backend. */
    public AttachmentMetricsHandler() {
        this(null);
    }

    /** Creates a handler writing through {@code metrics}. */
    public AttachmentMetricsHandler(MetricPort metrics) {
        this.metrics = metrics;
    }

    /** Records an intake attempt. */
    public void intakeAttempt() {
        increment(INTAKE_ATTEMPTS);
    }

    /** Records an accepted intake. */
    public void accepted() {
        increment(INTAKE_ACCEPTED);
    }

    /** Records a rejected or quarantined intake. */
    public void rejected() {
        increment(INTAKE_REJECTED);
    }

    /** Records a detected duplicate. */
    public void duplicate() {
        increment(INTAKE_DUPLICATE);
    }

    /** Records a quarantine decision. */
    public void quarantined() {
        increment(QUARANTINED);
    }

    /** Records a successful release. */
    public void released() {
        increment(RELEASED);
    }

    /** Records a security denial. */
    public void denied() {
        increment(DENIED);
    }

    /** Records the supplied counter name. */
    public void increment(String name) {
        if (metrics == null || name == null) {
            return;
        }
        try {
            metrics.increment(name);
        } catch (RuntimeException ignored) {
            // metrics must never change the business outcome
        }
    }

    /** @return the backing metric port, or {@code null} when none is configured. */
    public MetricPort port() {
        return metrics;
    }

    /** Compatibility seam; accepts a counter name. */
    public Object execute(Object input) {
        if (input instanceof String name) {
            increment(name);
            return null;
        }
        throw new IllegalArgumentException("Expected a metric name String");
    }
}
