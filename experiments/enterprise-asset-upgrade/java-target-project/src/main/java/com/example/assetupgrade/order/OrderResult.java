package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ServiceProblem;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Outcome of one order submission.
 *
 * <p>The record components {@code accepted, status, reservationId, problems, sideEffects} are the
 * public contract. {@code accepted} is {@code true} only when the order was reserved and committed
 * or when the command was an idempotent replay of an accepted order; a rejected or rolled-back
 * outcome is never accepted. {@code sideEffects} lists the reservation and commit markers that were
 * applied, and stays empty for a rejected or duplicate outcome.</p>
 */
public record OrderResult(boolean accepted, OrderStatus status, String reservationId,
                          List<ServiceProblem> problems, List<String> sideEffects) {

    public OrderResult {
        status = status == null ? (accepted ? OrderStatus.ACCEPTED : OrderStatus.REJECTED) : status;
        reservationId = reservationId == null || reservationId.isBlank() ? null : reservationId;
        problems = problems == null
                ? List.of()
                : Collections.unmodifiableList(new ArrayList<>(problems));
        sideEffects = sideEffects == null
                ? List.of()
                : Collections.unmodifiableList(new ArrayList<>(sideEffects));
    }

    /** Creates an accepted result carrying the reservation identity and applied side effects. */
    public static OrderResult accepted(String reservationId, List<String> sideEffects) {
        return new OrderResult(true, OrderStatus.ACCEPTED, reservationId, List.of(), sideEffects);
    }

    /** Creates an accepted result carrying a single side-effect marker. */
    public static OrderResult accepted(String reservationId, String sideEffect) {
        return accepted(reservationId, sideEffect == null ? List.of() : List.of(sideEffect));
    }

    /** Creates a rejected result carrying the supplied problems. */
    public static OrderResult rejected(List<ServiceProblem> problems) {
        return new OrderResult(false, OrderStatus.REJECTED, null, problems, List.of());
    }

    /** Creates a rejected result carrying a single problem. */
    public static OrderResult rejected(ServiceProblem problem) {
        return rejected(problem == null ? List.of() : List.of(problem));
    }

    /** Creates an accepted replay describing an already-completed order without new side effects. */
    public static OrderResult duplicate(OrderStatus status, String reservationId) {
        OrderStatus normalized = status == null || status.isFailure() ? OrderStatus.ACCEPTED : status;
        return new OrderResult(true, normalized, reservationId, List.of(), List.of());
    }

    /** Creates a rolled-back result carrying the released reservation and the explaining problems. */
    public static OrderResult rolledBack(String reservationId, List<ServiceProblem> problems,
                                         List<String> sideEffects) {
        return new OrderResult(false, OrderStatus.ROLLED_BACK, reservationId, problems, sideEffects);
    }

    /** @return {@code true} when the order was accepted or replayed. */
    public boolean isAccepted() {
        return accepted;
    }

    /** @return {@code true} when the order was rejected or rolled back. */
    public boolean isRejected() {
        return !accepted;
    }

    /** @return {@code true} when the outcome describes a released reservation. */
    public boolean isRolledBack() {
        return status == OrderStatus.ROLLED_BACK;
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
