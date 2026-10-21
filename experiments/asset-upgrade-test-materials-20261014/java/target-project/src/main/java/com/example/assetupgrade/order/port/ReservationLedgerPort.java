package com.example.assetupgrade.order.port;

/**
 * Skeleton seam for ReservationLedgerPort.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ReservationLedgerPort {
    java.util.Optional<com.example.assetupgrade.order.Reservation> find(
            com.example.assetupgrade.common.TenantId tenantId, String reservationId);
    void save(com.example.assetupgrade.order.Reservation reservation);
    void release(com.example.assetupgrade.common.TenantId tenantId, String reservationId);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
