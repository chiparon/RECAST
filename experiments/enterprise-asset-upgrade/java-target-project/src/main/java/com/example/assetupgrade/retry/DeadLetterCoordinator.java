package com.example.assetupgrade.retry;

import com.example.assetupgrade.workflow.WorkflowEvent;
import com.example.assetupgrade.workflow.WorkflowState;
import com.example.assetupgrade.workflow.port.DeadLetterPort;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;

/**
 * Tenant-scoped boundary that emits exhausted work to the {@link DeadLetterPort}.
 *
 * <p>A dead letter is emitted exactly once per exhausted event, carrying the original reason and the
 * number of attempts made. Provider-specific transport lives behind {@link DeadLetterPort}.</p>
 */
public final class DeadLetterCoordinator {

    private final DeadLetterPort port;

    public DeadLetterCoordinator(DeadLetterPort port) {
        this.port = Objects.requireNonNull(port, "port");
    }

    /** Publishes {@code event} as a dead letter with the original reason and attempt count. */
    public void deliver(WorkflowEvent event, String reason, int attempts) {
        Objects.requireNonNull(event, "event");
        port.publish(event, reason == null ? "" : reason, attempts);
    }

    /**
     * Publishes the exhausted idempotency key as a dead letter.
     *
     * <p>The key carries no workflow payload, so a deterministic dead-letter event is derived from it
     * (tenant-qualified id, operation, subject) and published through the same port.</p>
     */
    public void deliver(IdempotencyKey key, String reason, int attempts) {
        Objects.requireNonNull(key, "key");
        String effectiveReason = reason == null ? "" : reason;
        WorkflowEvent event = new WorkflowEvent(
                key.asString(),
                key.tenantId(),
                key.subjectId(),
                key.operation(),
                WorkflowState.DEAD_LETTERED,
                Instant.now(),
                Map.of("reason", effectiveReason));
        deliver(event, effectiveReason, attempts);
    }

    /** @return whether {@code policy} dead-letters an attempt numbered {@code attempt}. */
    public boolean shouldDeadLetter(RetryPolicy policy, int attempt) {
        return Objects.requireNonNull(policy, "policy").shouldDeadLetter(attempt);
    }

    /** @return the backing port. */
    public DeadLetterPort port() {
        return port;
    }

    /** Compatibility seam: accepts a {@link WorkflowEvent} and dead-letters it. */
    public Object execute(Object input) {
        if (input instanceof WorkflowEvent event) {
            deliver(event, "dead-letter", 0);
            return null;
        }
        throw new IllegalArgumentException("Expected WorkflowEvent");
    }
}
