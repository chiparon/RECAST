package com.example.assetupgrade.workflow;

import com.example.assetupgrade.retry.DeadLetterCoordinator;
import com.example.assetupgrade.workflow.port.DeadLetterPort;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Publishes an exhausted workflow event to the dead-letter boundary exactly once.
 *
 * <p>The handler wraps the shared {@link DeadLetterCoordinator}; a repeated
 * {@link #deliver(WorkflowEvent, String, int)} for the same tenant-qualified event is a no-op, so
 * the provider never observes a duplicate dead letter for one exhausted event.</p>
 */
public final class WorkflowDeadLetterHandler {

    private final DeadLetterCoordinator coordinator;
    private final Set<String> published = ConcurrentHashMap.newKeySet();

    /** Creates a handler with no sink; delivery is a no-op. */
    public WorkflowDeadLetterHandler() {
        this((DeadLetterCoordinator) null);
    }

    /** Creates a handler publishing through {@code port}. */
    public WorkflowDeadLetterHandler(DeadLetterPort port) {
        this(port == null ? null : new DeadLetterCoordinator(port));
    }

    /** Creates a handler delegating to {@code coordinator}. */
    public WorkflowDeadLetterHandler(DeadLetterCoordinator coordinator) {
        this.coordinator = coordinator;
    }

    /** Publishes {@code event} as a dead letter once, carrying {@code reason} and the attempt count. */
    public void deliver(WorkflowEvent event, String reason, int attempts) {
        if (coordinator == null || event == null) {
            return;
        }
        String key = key(event);
        if (!published.add(key)) {
            return;
        }
        try {
            coordinator.deliver(event, reason == null ? "" : reason, Math.max(0, attempts));
        } catch (RuntimeException failure) {
            published.remove(key);
            throw failure;
        }
    }

    /** @return {@code true} when the tenant-qualified event has already been published. */
    public boolean isPublished(WorkflowEvent event) {
        return event != null && published.contains(key(event));
    }

    /** @return the backing coordinator, or {@code null} when none is configured. */
    public DeadLetterCoordinator coordinator() {
        return coordinator;
    }

    /** @return the backing port, or {@code null} when none is configured. */
    public DeadLetterPort port() {
        return coordinator == null ? null : coordinator.port();
    }

    /** Compatibility seam; accepts a {@link WorkflowEvent} and dead-letters it. */
    public Object execute(Object input) {
        if (input instanceof WorkflowEvent event) {
            deliver(event, "dead-letter", 0);
            return null;
        }
        throw new IllegalArgumentException("Expected WorkflowEvent");
    }

    private static String key(WorkflowEvent event) {
        String tenant = event.tenantId() == null ? "" : event.tenantId().value();
        String eventId = event.eventId() == null ? "" : event.eventId();
        return tenant + ':' + eventId;
    }
}
