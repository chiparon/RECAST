package com.example.assetupgrade.order.port;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.Reservation;

import java.util.Optional;

/**
 * Tenant-scoped reservation ledger.
 *
 * <p>{@link #find(TenantId, String)} and {@link #release(TenantId, String)} are scoped to the
 * owning tenant; a release must never touch another tenant's reservation. No provider type
 * appears here.</p>
 */
public interface ReservationLedgerPort {

    /** @return the reservation for {@code reservationId} owned by {@code tenantId}, if present. */
    Optional<Reservation> find(TenantId tenantId, String reservationId);

    /** Persists {@code reservation}. */
    void save(Reservation reservation);

    /** Idempotently marks the tenant's reservation released. */
    void release(TenantId tenantId, String reservationId);

    /** Compatibility seam; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof FindRequest request) {
            return find(request.tenantId(), request.reservationId());
        }
        if (input instanceof Reservation reservation) {
            save(reservation);
            return null;
        }
        if (input instanceof ReleaseRequest request) {
            release(request.tenantId(), request.reservationId());
            return null;
        }
        throw new IllegalArgumentException("Expected a FindRequest, Reservation or ReleaseRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record FindRequest(TenantId tenantId, String reservationId) {
    }

    /** Request holder accepted by the compatibility seam. */
    record ReleaseRequest(TenantId tenantId, String reservationId) {
    }
}
