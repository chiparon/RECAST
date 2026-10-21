package com.example.assetupgrade.workflow;

import com.example.assetupgrade.common.ServiceProblem;

import java.util.List;

/**
 * Outcome of one workflow-event delivery attempt.
 *
 * <p>The record components {@code accepted, status, finalState, attemptNumber, problems} are the
 * public contract. {@code accepted} is {@code true} when the delivery succeeded or was an
 * idempotent replay; a retryable, dead-lettered or rejected outcome is not accepted. The
 * {@code finalState} is the workflow state reached by the attempt and {@code problems} carries the
 * typed failures that explain a non-accepted outcome.</p>
 */
public record WorkflowDeliveryResult(
        boolean accepted,
        DeliveryStatus status,
        WorkflowState finalState,
        int attemptNumber,
        List<ServiceProblem> problems) {

    public WorkflowDeliveryResult {
        status = status == null ? DeliveryStatus.REJECTED : status;
        finalState = finalState == null ? WorkflowState.NEW : finalState;
        attemptNumber = Math.max(0, attemptNumber);
        problems = problems == null ? List.of() : List.copyOf(problems);
    }

    /** Creates an accepted result that reached {@code COMPLETED} on {@code attemptNumber}. */
    public static WorkflowDeliveryResult accepted(int attemptNumber) {
        return new WorkflowDeliveryResult(true, DeliveryStatus.ACCEPTED, WorkflowState.COMPLETED, attemptNumber,
                List.of());
    }

    /** Creates an accepted duplicate replay result. */
    public static WorkflowDeliveryResult duplicate(WorkflowState finalState, int attemptNumber) {
        return new WorkflowDeliveryResult(true, DeliveryStatus.DUPLICATE, finalState, attemptNumber, List.of());
    }

    /** Creates a retryable result pending the next attempt. */
    public static WorkflowDeliveryResult retryable(int attemptNumber, List<ServiceProblem> problems) {
        return new WorkflowDeliveryResult(false, DeliveryStatus.RETRYABLE, WorkflowState.RETRY_PENDING, attemptNumber,
                problems);
    }

    /** Creates a dead-lettered result. */
    public static WorkflowDeliveryResult deadLettered(int attemptNumber, List<ServiceProblem> problems) {
        return new WorkflowDeliveryResult(false, DeliveryStatus.DEAD_LETTERED, WorkflowState.DEAD_LETTERED, attemptNumber,
                problems);
    }

    /** Creates a rejected result ending in {@code finalState}. */
    public static WorkflowDeliveryResult rejected(WorkflowState finalState, List<ServiceProblem> problems) {
        return new WorkflowDeliveryResult(false, DeliveryStatus.REJECTED, finalState, 0, problems);
    }

    /** Creates a rejected result carrying a single problem. */
    public static WorkflowDeliveryResult rejected(WorkflowState finalState, ServiceProblem problem) {
        return rejected(finalState, problem == null ? List.of() : List.of(problem));
    }

    /** @return {@code true} when the delivery succeeded or was an idempotent replay. */
    public boolean isAccepted() {
        return accepted;
    }

    /** @return {@code true} when the delivery did not succeed. */
    public boolean isRejected() {
        return !accepted;
    }

    /** @return {@code true} when the attempt was short-circuited as a duplicate. */
    public boolean isDuplicate() {
        return status == DeliveryStatus.DUPLICATE;
    }

    /** @return {@code true} when a further attempt has been scheduled. */
    public boolean isRetryable() {
        return status == DeliveryStatus.RETRYABLE;
    }

    /** @return {@code true} when the event was dead-lettered. */
    public boolean isDeadLettered() {
        return status == DeliveryStatus.DEAD_LETTERED;
    }

    /** @return {@code true} when at least one problem is reported. */
    public boolean hasProblems() {
        return !problems.isEmpty();
    }

    /** @return the first problem, or {@code null} when none was reported. */
    public ServiceProblem firstProblem() {
        return problems.isEmpty() ? null : problems.get(0);
    }
}
