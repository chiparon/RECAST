package com.example.assetupgrade.workflow;

import com.example.assetupgrade.error.ConflictException;

import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/**
 * Legal-transition table for approved-event delivery.
 *
 * <p>Only the transitions required to take an approved event to a terminal delivery state are
 * recognised: {@code NEW -> APPROVED}; {@code APPROVED -> DISPATCHED | RETRY_PENDING | FAILED};
 * {@code DISPATCHED -> COMPLETED | FAILED | RETRY_PENDING};
 * {@code RETRY_PENDING -> DISPATCHED | DEAD_LETTERED | FAILED}. {@code COMPLETED}, {@code FAILED}
 * and {@code DEAD_LETTERED} are terminal. An illegal transition is rejected with a
 * {@link ConflictException} (classified as {@code ProblemCode.CONFLICT}) rather than being
 * silently coerced.</p>
 *
 * <p>The same policy projects a {@link WorkflowState} onto the coarser
 * {@link EventProcessingStage} carried by an {@code EventEnvelope}.</p>
 */
public final class WorkflowStatePolicy {

    private static final Map<WorkflowState, Set<WorkflowState>> LEGAL = buildLegal();

    /** Creates the standard delivery policy. */
    public WorkflowStatePolicy() {
    }

    /** @return the standard delivery policy. */
    public static WorkflowStatePolicy standard() {
        return new WorkflowStatePolicy();
    }

    private static Map<WorkflowState, Set<WorkflowState>> buildLegal() {
        Map<WorkflowState, Set<WorkflowState>> table = new EnumMap<>(WorkflowState.class);
        table.put(WorkflowState.NEW, EnumSet.of(WorkflowState.APPROVED));
        table.put(WorkflowState.APPROVED,
                EnumSet.of(WorkflowState.DISPATCHED, WorkflowState.RETRY_PENDING, WorkflowState.FAILED));
        table.put(WorkflowState.DISPATCHED,
                EnumSet.of(WorkflowState.COMPLETED, WorkflowState.FAILED, WorkflowState.RETRY_PENDING));
        table.put(WorkflowState.RETRY_PENDING,
                EnumSet.of(WorkflowState.DISPATCHED, WorkflowState.DEAD_LETTERED, WorkflowState.FAILED));
        table.put(WorkflowState.COMPLETED, EnumSet.noneOf(WorkflowState.class));
        table.put(WorkflowState.FAILED, EnumSet.noneOf(WorkflowState.class));
        table.put(WorkflowState.DEAD_LETTERED, EnumSet.noneOf(WorkflowState.class));
        return table;
    }

    /** @return {@code true} when {@code from -> to} is a legal delivery transition. */
    public boolean canTransition(WorkflowState from, WorkflowState to) {
        if (from == null || to == null) {
            return false;
        }
        return LEGAL.getOrDefault(from, Set.of()).contains(to);
    }

    /**
     * Applies {@code from -> to}.
     *
     * @return {@code to}
     * @throws ConflictException when the transition is not legal
     */
    public WorkflowState transition(WorkflowState from, WorkflowState to) {
        if (!canTransition(from, to)) {
            throw new ConflictException("illegal workflow transition: "
                    + (from == null ? "null" : from.name()) + " -> " + (to == null ? "null" : to.name()));
        }
        return to;
    }

    /** @return {@code true} when {@code state} no longer changes. */
    public boolean isTerminal(WorkflowState state) {
        return state == WorkflowState.COMPLETED
                || state == WorkflowState.FAILED
                || state == WorkflowState.DEAD_LETTERED;
    }

    /** @return {@code true} when an event in {@code state} may be handed to the dispatcher. */
    public boolean isDispatchable(WorkflowState state) {
        return canTransition(state, WorkflowState.DISPATCHED);
    }

    /**
     * Projects a workflow state onto the envelope stage that represents it.
     *
     * @return the matching {@link EventProcessingStage}; {@code RECEIVED} for {@code NEW} and
     *         {@code DEAD_LETTERED} for a terminal failure
     */
    public static EventProcessingStage stageOf(WorkflowState state) {
        if (state == null) {
            return EventProcessingStage.RECEIVED;
        }
        return switch (state) {
            case NEW -> EventProcessingStage.RECEIVED;
            case APPROVED -> EventProcessingStage.VALIDATED;
            case RETRY_PENDING -> EventProcessingStage.RETRY_PENDING;
            case DISPATCHED -> EventProcessingStage.DISPATCHED;
            case COMPLETED -> EventProcessingStage.COMPLETED;
            case FAILED, DEAD_LETTERED -> EventProcessingStage.DEAD_LETTERED;
        };
    }

    /** @return the workflow state implied by an envelope {@code stage}. */
    public static WorkflowState stateOf(EventProcessingStage stage) {
        if (stage == null) {
            return WorkflowState.NEW;
        }
        return switch (stage) {
            case RECEIVED -> WorkflowState.NEW;
            case VALIDATED -> WorkflowState.APPROVED;
            case RETRY_PENDING -> WorkflowState.RETRY_PENDING;
            case DISPATCHED -> WorkflowState.DISPATCHED;
            case COMPLETED -> WorkflowState.COMPLETED;
            case DEAD_LETTERED -> WorkflowState.DEAD_LETTERED;
        };
    }

    /** @return a {@link WorkflowStateMachine} backed by this table. */
    public static WorkflowStateMachine machine() {
        return machine(new WorkflowStatePolicy());
    }

    /** @return a {@link WorkflowStateMachine} backed by {@code policy}. */
    public static WorkflowStateMachine machine(WorkflowStatePolicy policy) {
        WorkflowStatePolicy effective = policy == null ? new WorkflowStatePolicy() : policy;
        return new WorkflowStateMachine() {
            @Override
            public boolean canTransition(WorkflowState from, WorkflowState to) {
                return effective.canTransition(from, to);
            }

            @Override
            public WorkflowState transition(WorkflowState from, WorkflowState to) {
                return effective.transition(from, to);
            }
        };
    }

    /**
     * Compatibility seam; accepts a {@link WorkflowState} and returns its projected stage.
     */
    public Object execute(Object input) {
        if (input instanceof WorkflowState state) {
            return stageOf(state);
        }
        throw new IllegalArgumentException("Expected WorkflowState");
    }
}
