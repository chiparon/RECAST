package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.order.port.OrderCommitPort;
import com.example.assetupgrade.order.port.OrderRepository;

import java.time.Instant;
import java.util.Optional;

/**
 * Commits an order against its reservation and persists the accepted snapshot.
 *
 * <p>{@link #commit(OrderRequest, Reservation, long)} first marks the order {@code COMMITTING},
 * then invokes {@link OrderCommitPort#commit(OrderRequest, Reservation)} inside the caller's
 * transaction boundary, then persists the {@code ACCEPTED} snapshot. A failure at any step
 * propagates so the boundary can roll back and the reservation can be compensated.</p>
 */
public final class OrderCommitCoordinator {

    private final OrderCommitPort committer;
    private final OrderRepository orders;
    private final TimeProvider clock;

    /** Creates an unconfigured coordinator; a commit attempt fails closed. */
    public OrderCommitCoordinator() {
        this(null, null, null);
    }

    /** Creates a coordinator backed by {@code committer}. */
    public OrderCommitCoordinator(OrderCommitPort committer) {
        this(committer, null, null);
    }

    /** Creates a coordinator backed by {@code committer} and {@code orders}. */
    public OrderCommitCoordinator(OrderCommitPort committer, OrderRepository orders) {
        this(committer, orders, null);
    }

    /** Creates a fully configured coordinator. */
    public OrderCommitCoordinator(OrderCommitPort committer, OrderRepository orders, TimeProvider clock) {
        this.committer = committer;
        this.orders = orders;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /**
     * Commits {@code order} against {@code reservation}.
     *
     * @return the persisted {@code ACCEPTED} snapshot
     */
    public OrderSnapshot commit(OrderRequest order, Reservation reservation) {
        return commit(order, reservation, order == null ? 0L : order.lineTotalMinor());
    }

    /**
     * Commits {@code order} against {@code reservation} using a pre-computed total.
     *
     * @return the persisted {@code ACCEPTED} snapshot
     */
    public OrderSnapshot commit(OrderRequest order, Reservation reservation, long totalMinor) {
        if (order == null) {
            throw new ValidationException("order request is required to commit");
        }
        if (reservation == null) {
            throw new ValidationException("a reservation is required to commit order " + order.orderId());
        }
        if (committer == null) {
            throw new StorageFailureException("order commit port is not configured");
        }
        int baseVersion = currentVersion(order);
        Instant now = clock.now();
        OrderSnapshot committing = new OrderSnapshot(order, OrderStatus.COMMITTING, reservation, totalMinor, now,
                baseVersion + 1);
        if (orders != null) {
            orders.save(committing);
        }
        committer.commit(order, reservation);
        OrderSnapshot accepted = new OrderSnapshot(order, OrderStatus.ACCEPTED, reservation, totalMinor, clock.now(),
                baseVersion + 2);
        if (orders != null) {
            orders.save(accepted);
        }
        return accepted;
    }

    /** @return the current snapshot version for the order, or {@code 0} when none is stored. */
    public int currentVersion(OrderRequest order) {
        if (orders == null || order == null || order.tenantId() == null) {
            return 0;
        }
        try {
            Optional<OrderSnapshot> stored = orders.find(order.tenantId(), order.orderId());
            return stored.map(OrderSnapshot::version).orElse(0);
        } catch (RuntimeException ignored) {
            return 0;
        }
    }

    /** @return the commit port, or {@code null} when none is configured. */
    public OrderCommitPort committer() {
        return committer;
    }

    /** Compatibility seam; accepts a {@link CommitRequest} and returns the accepted snapshot. */
    public Object execute(Object input) {
        if (input instanceof CommitRequest request) {
            return commit(request.order(), request.reservation(), request.totalMinor());
        }
        throw new IllegalArgumentException("Expected a CommitRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    public record CommitRequest(OrderRequest order, Reservation reservation, long totalMinor) {

        /** Creates a request priced from the order lines. */
        public CommitRequest(OrderRequest order, Reservation reservation) {
            this(order, reservation, order == null ? 0L : order.lineTotalMinor());
        }
    }
}
