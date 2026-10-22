package com.example.assetupgrade.order;

import java.util.EnumSet;
import java.util.Set;

/**
 * Lifecycle of an order as it moves from draft through validation and inventory reservation to
 * commit, rejection or rollback.
 *
 * <p>The constant set and declaration order are part of the public contract and must not change.
 * Behavioural helpers added here describe the transitions the order boundary is allowed to
 * perform; a rollback deliberately remains non-terminal so a failed attempt can be retried.</p>
 */
public enum OrderStatus {
    DRAFT,
    VALIDATING,
    RESERVED,
    COMMITTING,
    ACCEPTED,
    REJECTED,
    ROLLED_BACK;

    private static final Set<OrderStatus> TERMINAL = EnumSet.of(ACCEPTED, REJECTED);

    /**
     * @return {@code true} when the order may no longer change state. A {@link #ROLLED_BACK}
     *         order is not terminal: its reservation was released and the command may be retried.
     */
    public boolean isTerminal() {
        return TERMINAL.contains(this);
    }

    /** @return {@code true} when the order reached a successful outcome. */
    public boolean isSuccessful() {
        return this == ACCEPTED;
    }

    /** @return {@code true} when the order was rejected or rolled back. */
    public boolean isFailure() {
        return this == REJECTED || this == ROLLED_BACK;
    }

    /** @return {@code true} when the order already holds a reservation. */
    public boolean isReserved() {
        return this == RESERVED || this == COMMITTING || this == ACCEPTED;
    }

    /** @return {@code true} when the status represents pre-commit work. */
    public boolean isInProgress() {
        return this == DRAFT || this == VALIDATING || this == RESERVED || this == COMMITTING;
    }

    /**
     * @return {@code true} when an order currently in this state may move to {@code next}. A
     *         {@code ROLLED_BACK} order may be retried; an {@code ACCEPTED} or {@code REJECTED}
     *         order is terminal and may not transition further.
     */
    public boolean canTransitionTo(OrderStatus next) {
        if (next == null || next == this) {
            return false;
        }
        if (isTerminal()) {
            return false;
        }
        return switch (this) {
            case DRAFT -> next == VALIDATING || next == REJECTED;
            case VALIDATING -> next == RESERVED || next == REJECTED;
            case RESERVED -> next == COMMITTING || next == ACCEPTED || next == ROLLED_BACK;
            case COMMITTING -> next == ACCEPTED || next == ROLLED_BACK || next == REJECTED;
            case ROLLED_BACK -> next == DRAFT || next == VALIDATING || next == RESERVED;
            case ACCEPTED, REJECTED -> false;
        };
    }
}
