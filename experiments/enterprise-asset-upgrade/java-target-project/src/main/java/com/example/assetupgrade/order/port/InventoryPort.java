package com.example.assetupgrade.order.port;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.OrderRequest;
import com.example.assetupgrade.order.Reservation;

/**
 * Tenant-scoped inventory boundary.
 *
 * <p>{@link #reserve(OrderRequest)} atomically takes the requested quantities for the order and
 * returns the resulting {@link Reservation}. {@link #release(TenantId, String)} is an idempotent
 * compensation that releases a reservation; it must never release another tenant's reservation.
 * No provider type appears here.</p>
 */
public interface InventoryPort {

    /** Reserves inventory for {@code order} and returns the created reservation. */
    Reservation reserve(OrderRequest order);

    /** Idempotently releases the reservation for {@code tenantId}. */
    void release(TenantId tenantId, String reservationId);

    /** Compatibility seam; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof ReserveRequest request) {
            return reserve(request.order());
        }
        if (input instanceof ReleaseRequest request) {
            release(request.tenantId(), request.reservationId());
            return null;
        }
        throw new IllegalArgumentException("Expected a ReserveRequest or ReleaseRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record ReserveRequest(OrderRequest order) {
    }

    /** Request holder accepted by the compatibility seam. */
    record ReleaseRequest(TenantId tenantId, String reservationId) {
    }
}
