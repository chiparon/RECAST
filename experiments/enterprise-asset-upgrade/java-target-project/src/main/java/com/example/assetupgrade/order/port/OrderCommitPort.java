package com.example.assetupgrade.order.port;

import com.example.assetupgrade.order.OrderRequest;
import com.example.assetupgrade.order.Reservation;

/**
 * Boundary that commits an order against its reservation.
 *
 * <p>{@link #commit(OrderRequest, Reservation)} performs the durable order write inside the
 * caller's transaction boundary. No provider type appears here.</p>
 */
public interface OrderCommitPort {

    /** Commits {@code order} against {@code reservation}. */
    void commit(OrderRequest order, Reservation reservation);

    /** Compatibility seam; the typed method defines the contract. */
    default Object execute(Object input) {
        if (input instanceof CommitRequest request) {
            commit(request.order(), request.reservation());
            return null;
        }
        throw new IllegalArgumentException("Expected a CommitRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record CommitRequest(OrderRequest order, Reservation reservation) {
    }
}
