package com.example.assetupgrade.workflow;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.workflow.port.WorkflowEventStore;

import java.util.ArrayList;
import java.util.List;

/**
 * Dispatches the tenant-scoped due workflow envelopes through the delivery boundary.
 *
 * <p>{@link #dispatchDue(TenantId, int)} reads only the requested tenant's due envelopes via
 * {@link WorkflowEventStore#findDue}, dispatches each one through the
 * {@link WorkflowDeliveryService}, skips duplicates and isolates per-item failures so a single
 * failing event never aborts the batch. The requested limit is honoured and the per-item outcomes
 * are aggregated.</p>
 */
public final class WorkflowBatchDispatcher {

    /** Default number of due envelopes examined when a caller does not supply a limit. */
    public static final int DEFAULT_LIMIT = 100;

    private final WorkflowEventStore eventStore;
    private final WorkflowDeliveryService delivery;
    private final ActorId actorId;
    private final TimeProvider clock;

    /** Creates a batch dispatcher with no due store; no envelopes are ever examined. */
    public WorkflowBatchDispatcher() {
        this(null, new WorkflowDeliveryCoordinator(), null, null);
    }

    /** Creates a batch dispatcher delegating to {@code delivery} with no due store. */
    public WorkflowBatchDispatcher(WorkflowDeliveryService delivery) {
        this(null, delivery, null, null);
    }

    /** Creates a batch dispatcher reading due envelopes from {@code eventStore}. */
    public WorkflowBatchDispatcher(WorkflowEventStore eventStore) {
        this(eventStore, null, null, null);
    }

    /** Creates a batch dispatcher reading due envelopes from {@code eventStore}. */
    public WorkflowBatchDispatcher(WorkflowEventStore eventStore, WorkflowDeliveryService delivery) {
        this(eventStore, delivery, null, null);
    }

    /** Creates a batch dispatcher using {@code actorId} for the dispatched commands. */
    public WorkflowBatchDispatcher(WorkflowEventStore eventStore, WorkflowDeliveryService delivery, ActorId actorId) {
        this(eventStore, delivery, actorId, null);
    }

    /** Creates a batch dispatcher with an explicit time source. */
    public WorkflowBatchDispatcher(WorkflowEventStore eventStore, WorkflowDeliveryService delivery, ActorId actorId,
                                   TimeProvider clock) {
        this.eventStore = eventStore;
        this.delivery = delivery == null ? new WorkflowDeliveryCoordinator() : delivery;
        this.actorId = actorId == null ? ActorId.of("workflow-batch") : actorId;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Dispatches up to {@code limit} due envelopes for {@code tenantId}. */
    public BatchDispatchResult dispatchDue(TenantId tenantId, int limit) {
        int effectiveLimit = Math.max(0, limit);
        if (tenantId == null || effectiveLimit == 0) {
            return new BatchDispatchResult(tenantId, effectiveLimit, 0, 0, 0, 0, List.of());
        }

        List<EventEnvelope> due = List.of();
        if (eventStore != null) {
            try {
                List<EventEnvelope> found = eventStore.findDue(tenantId, clock.now(), effectiveLimit);
                if (found != null) {
                    due = found;
                }
            } catch (RuntimeException ignored) {
                due = List.of();
            }
        }

        List<WorkflowDeliveryResult> results = new ArrayList<>();
        int examined = 0;
        int dispatched = 0;
        int duplicated = 0;
        int failed = 0;

        for (EventEnvelope envelope : due) {
            if (examined >= effectiveLimit) {
                break;
            }
            examined++;
            if (envelope == null || envelope.event() == null) {
                failed++;
                results.add(WorkflowDeliveryResult.rejected(WorkflowState.NEW,
                        ServiceProblem.of(ProblemCode.INVALID_INPUT, "due envelope carries no workflow event")));
                continue;
            }
            try {
                CorrelationId correlationId = envelope.correlationId() == null
                        ? CorrelationId.generate() : envelope.correlationId();
                CommandMetadata metadata = CommandMetadata.of(tenantId, actorId, correlationId, clock.now());
                WorkflowDeliveryCommand command = new WorkflowDeliveryCommand(metadata, envelope.event(),
                        envelope.routeKey());
                WorkflowDeliveryResult result = delivery.deliver(command);
                results.add(result);
                if (result == null) {
                    failed++;
                } else if (result.status() == DeliveryStatus.DUPLICATE) {
                    duplicated++;
                } else if (result.accepted()) {
                    dispatched++;
                } else {
                    failed++;
                }
            } catch (RuntimeException itemFailure) {
                failed++;
                results.add(WorkflowDeliveryResult.rejected(envelope.event().state(),
                        ServiceProblem.of(ProblemCode.STORAGE_FAILURE,
                                "batch item failed: " + describe(itemFailure), envelope.event().eventId())));
            }
        }

        return new BatchDispatchResult(tenantId, effectiveLimit, examined, dispatched, duplicated, failed, results);
    }

    /** Alias of {@link #dispatchDue(TenantId, int)} with the {@link #DEFAULT_LIMIT}. */
    public BatchDispatchResult dispatchDue(TenantId tenantId) {
        return dispatchDue(tenantId, DEFAULT_LIMIT);
    }

    /** @return the backing due-envelope store, or {@code null} when none is configured. */
    public WorkflowEventStore store() {
        return eventStore;
    }

    /** @return the delivery boundary used for each envelope. */
    public WorkflowDeliveryService delivery() {
        return delivery;
    }

    /**
     * Compatibility seam; accepts a {@link TenantId} (using {@link #DEFAULT_LIMIT}) or an
     * {@code Object[]} of {@code {TenantId, Integer limit}}.
     */
    public Object execute(Object input) {
        if (input instanceof TenantId tenantId) {
            return dispatchDue(tenantId, DEFAULT_LIMIT);
        }
        if (input instanceof Object[] args && args.length >= 1 && args[0] instanceof TenantId tenantId) {
            int limit = args.length >= 2 && args[1] instanceof Integer value ? value : DEFAULT_LIMIT;
            return dispatchDue(tenantId, limit);
        }
        throw new IllegalArgumentException("Expected a TenantId or {TenantId, Integer}");
    }

    private static String describe(RuntimeException failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    /**
     * Aggregated outcome of one batch run.
     *
     * @param tenantId       the tenant that was reconciled
     * @param requestedLimit the limit requested by the caller
     * @param examined       the number of due envelopes examined
     * @param dispatched     the number of successful deliveries
     * @param duplicated     the number of duplicate replays
     * @param failed         the number of retryable, dead-lettered or rejected items
     * @param results        the per-item delivery outcomes
     */
    public record BatchDispatchResult(TenantId tenantId, int requestedLimit, int examined, int dispatched,
                                      int duplicated, int failed, List<WorkflowDeliveryResult> results) {

        public BatchDispatchResult {
            results = results == null ? List.of() : List.copyOf(results);
        }

        /** @return {@code true} when the whole batch succeeded without a failed item. */
        public boolean isClean() {
            return failed == 0;
        }

        /** @return the number of items examined. */
        public int processed() {
            return results.size();
        }
    }
}
