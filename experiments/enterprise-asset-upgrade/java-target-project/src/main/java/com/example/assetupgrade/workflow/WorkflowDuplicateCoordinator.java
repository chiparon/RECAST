package com.example.assetupgrade.workflow;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.workflow.port.EventEnvelopeRepository;
import com.example.assetupgrade.workflow.port.WorkflowStateStore;

import java.util.Optional;
import java.util.Set;

/**
 * Detects and coordinates duplicate tenant-scoped workflow deliveries.
 *
 * <p>A delivery is a duplicate when its tenant-qualified idempotency key has already completed
 * successfully, or when a terminal envelope ({@code DISPATCHED}, {@code COMPLETED} or
 * {@code DEAD_LETTERED}) already exists for the {@code (tenantId, eventId)} pair. The
 * orchestrator consults {@link #isDuplicate(TenantId, String)} before dispatching, marks the key
 * {@link #complete(IdempotencyKey) completed} only after a successful delivery and
 * {@link #release(IdempotencyKey) releases} it after a retryable failure so the attempt stays
 * rerunnable.</p>
 *
 * <p>Keys are always tenant-qualified: the same event id from two tenants is never treated as one
 * logical unit.</p>
 */
public final class WorkflowDuplicateCoordinator {

    /** Operation name used to build the tenant-qualified idempotency key. */
    public static final String OPERATION = "workflow-delivery";

    private static final Set<EventProcessingStage> TERMINAL_STAGES =
            Set.of(EventProcessingStage.DISPATCHED, EventProcessingStage.COMPLETED,
                    EventProcessingStage.DEAD_LETTERED);

    private final IdempotencyPort idempotency;
    private final EventEnvelopeRepository envelopes;
    private final WorkflowStateStore stateStore;

    /** Creates a coordinator with no store; nothing is ever considered a duplicate. */
    public WorkflowDuplicateCoordinator() {
        this(null, null, null);
    }

    /** Creates a coordinator backed by the idempotency store. */
    public WorkflowDuplicateCoordinator(IdempotencyPort idempotency) {
        this(idempotency, null, null);
    }

    /** Creates a coordinator able to re-read the persisted envelope. */
    public WorkflowDuplicateCoordinator(IdempotencyPort idempotency, EventEnvelopeRepository envelopes) {
        this(idempotency, envelopes, null);
    }

    /** Creates a coordinator using every available store. */
    public WorkflowDuplicateCoordinator(IdempotencyPort idempotency, EventEnvelopeRepository envelopes,
                                        WorkflowStateStore stateStore) {
        this.idempotency = idempotency;
        this.envelopes = envelopes;
        this.stateStore = stateStore;
    }

    /** @return the tenant-qualified key for a workflow delivery. */
    public IdempotencyKey key(TenantId tenantId, String eventId) {
        return IdempotencyKey.of(tenantId, OPERATION, eventId);
    }

    /** @return {@code true} when {@code key} has already completed successfully. */
    public boolean isDuplicate(IdempotencyKey key) {
        return idempotency != null && key != null && idempotency.isCompleted(key);
    }

    /** @return {@code true} when the tenant-qualified delivery is already completed or terminal. */
    public boolean isDuplicate(TenantId tenantId, String eventId) {
        if (tenantId == null || eventId == null) {
            return false;
        }
        return isDuplicate(key(tenantId, eventId)) || hasTerminalEnvelope(tenantId, eventId);
    }

    /** @return {@code true} when a terminal envelope already exists for the tenant-qualified event. */
    public boolean hasTerminalEnvelope(TenantId tenantId, String eventId) {
        return find(tenantId, eventId).map(WorkflowDuplicateCoordinator::isTerminal).orElse(false);
    }

    /** @return {@code true} when {@code envelope} reached a terminal processing stage. */
    public static boolean isTerminal(EventEnvelope envelope) {
        return envelope != null && TERMINAL_STAGES.contains(envelope.stage());
    }

    /**
     * Atomically claims {@code key}.
     *
     * @return {@code true} when the caller may proceed, {@code false} when it was already claimed
     */
    public boolean claim(IdempotencyKey key) {
        return idempotency == null || idempotency.tryMarkCompleted(key);
    }

    /** Marks {@code key} completed after a successful delivery. */
    public void complete(IdempotencyKey key) {
        if (idempotency != null && key != null) {
            idempotency.tryMarkCompleted(key);
        }
    }

    /** Releases the claim so a failed or retryable attempt remains rerunnable. */
    public void release(IdempotencyKey key) {
        if (idempotency != null && key != null) {
            idempotency.remove(key);
        }
    }

    /** @return the already-persisted envelope for the tenant-qualified event, if any. */
    public Optional<EventEnvelope> existing(TenantId tenantId, String eventId) {
        return find(tenantId, eventId);
    }

    /** @return the backing idempotency port, or {@code null} when none is configured. */
    public IdempotencyPort port() {
        return idempotency;
    }

    /**
     * Compatibility seam; accepts a {@link WorkflowDeliveryCommand} and reports whether it is a
     * duplicate of an already-completed delivery.
     */
    public Object execute(Object input) {
        if (input instanceof WorkflowDeliveryCommand command) {
            if (command.metadata() == null || command.event() == null) {
                return false;
            }
            return isDuplicate(command.metadata().tenantId(), command.event().eventId());
        }
        throw new IllegalArgumentException("Expected WorkflowDeliveryCommand");
    }

    private Optional<EventEnvelope> find(TenantId tenantId, String eventId) {
        if (tenantId == null || eventId == null) {
            return Optional.empty();
        }
        if (stateStore != null) {
            try {
                Optional<EventEnvelope> stored = stateStore.find(tenantId, eventId);
                if (stored != null && stored.isPresent()) {
                    return stored;
                }
            } catch (RuntimeException ignored) {
                // fall through to the envelope repository
            }
        }
        if (envelopes != null) {
            try {
                Optional<EventEnvelope> stored = envelopes.find(tenantId, eventId);
                if (stored != null) {
                    return stored;
                }
            } catch (RuntimeException ignored) {
                // treat a failing lookup as "not a duplicate"
            }
        }
        return Optional.empty();
    }
}
