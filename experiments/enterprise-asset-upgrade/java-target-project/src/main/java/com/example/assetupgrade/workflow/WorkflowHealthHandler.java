package com.example.assetupgrade.workflow;

import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.HealthStatus;
import com.example.assetupgrade.workflow.port.DeadLetterPort;
import com.example.assetupgrade.workflow.port.WorkflowDispatcher;
import com.example.assetupgrade.workflow.port.WorkflowOutboxPort;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reports the health of the workflow delivery pipeline.
 *
 * <p>The probe is {@link HealthStatus#UP} only when the dispatcher, outbox and dead-letter
 * boundary are all configured; otherwise it is {@link HealthStatus#DOWN} and the missing
 * collaborators are reported as attributes. Evaluation is best-effort and never throws.</p>
 */
public final class WorkflowHealthHandler implements HealthCheck {

    private final WorkflowDispatcher dispatcher;
    private final WorkflowOutboxPort outbox;
    private final DeadLetterPort deadLetters;

    /** Creates a probe with no collaborators; it reports DOWN. */
    public WorkflowHealthHandler() {
        this(null, null, null);
    }

    /** Creates a probe over the workflow delivery collaborators. */
    public WorkflowHealthHandler(WorkflowDispatcher dispatcher, WorkflowOutboxPort outbox,
                                 DeadLetterPort deadLetters) {
        this.dispatcher = dispatcher;
        this.outbox = outbox;
        this.deadLetters = deadLetters;
    }

    @Override
    public HealthStatus status() {
        try {
            List<String> missing = new ArrayList<>();
            if (dispatcher == null) {
                missing.add("dispatcher");
            }
            if (outbox == null) {
                missing.add("outbox");
            }
            if (deadLetters == null) {
                missing.add("deadLetters");
            }
            if (!missing.isEmpty()) {
                Map<String, String> attributes = new LinkedHashMap<>();
                attributes.put("missing", String.join(",", missing));
                attributes.put("reason", "workflow collaborators are not configured");
                return HealthStatus.of(HealthStatus.DOWN, attributes);
            }
            return HealthStatus.up(Map.of("checks", "dispatcher,outbox,deadLetters"));
        } catch (RuntimeException failure) {
            return HealthStatus.down("workflow health evaluation failed");
        }
    }

    @Override
    public String id() {
        return "workflow-health";
    }

    /** @return the dispatcher under evaluation, or {@code null} when none is configured. */
    public WorkflowDispatcher dispatcher() {
        return dispatcher;
    }

    /** @return the outbox under evaluation, or {@code null} when none is configured. */
    public WorkflowOutboxPort outbox() {
        return outbox;
    }

    /** @return the dead-letter boundary under evaluation, or {@code null} when none is configured. */
    public DeadLetterPort deadLetters() {
        return deadLetters;
    }

    /** Compatibility seam; returns the current health verdict. */
    public Object execute(Object input) {
        return status();
    }
}
