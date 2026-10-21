package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;

import java.time.Instant;

/**
 * Persisted view of an order at a point in its lifecycle.
 *
 * <p>The record components {@code request, status, reservation, totalMinor, updatedAt, version}
 * are the public contract. A missing status defaults to {@link OrderStatus#DRAFT} and a missing
 * timestamp to {@link Instant#EPOCH} so a partially populated snapshot can still be read back.
 * {@code reservation} is {@code null} for a rejected order that never held inventory.</p>
 *
 * @param request     the originating order request
 * @param status      the lifecycle status captured by this snapshot
 * @param reservation the inventory reservation, or {@code null} when none was taken
 * @param totalMinor  the priced order total in minor currency units
 * @param updatedAt   the instant the snapshot was written
 * @param version     the optimistic-lock version of the snapshot
 */
public record OrderSnapshot(OrderRequest request, OrderStatus status, Reservation reservation, long totalMinor,
                            Instant updatedAt, int version) {

    public OrderSnapshot {
        status = status == null ? OrderStatus.DRAFT : status;
        updatedAt = updatedAt == null ? Instant.EPOCH : updatedAt;
        version = Math.max(0, version);
    }

    /** @return the owning tenant, or {@code null} when the request is absent. */
    public TenantId tenantId() {
        return request == null ? null : request.tenantId();
    }

    /** @return the order identity, or {@code null} when the request is absent. */
    public String orderId() {
        return request == null ? null : request.orderId();
    }

    /** @return the reservation identity, or {@code null} when no reservation was taken. */
    public String reservationId() {
        return reservation == null ? null : reservation.reservationId();
    }

    /** @return a copy of this snapshot with the supplied status. */
    public OrderSnapshot withStatus(OrderStatus newStatus) {
        return new OrderSnapshot(request, newStatus, reservation, totalMinor, updatedAt, version);
    }

    /** @return a copy of this snapshot with the supplied reservation. */
    public OrderSnapshot withReservation(Reservation newReservation) {
        return new OrderSnapshot(request, status, newReservation, totalMinor, updatedAt, version);
    }

    /** @return a copy of this snapshot with the supplied version. */
    public OrderSnapshot withVersion(int newVersion) {
        return new OrderSnapshot(request, status, reservation, totalMinor, updatedAt, newVersion);
    }

    /** Creates a snapshot from its parts. */
    public static OrderSnapshot of(OrderRequest request, OrderStatus status, Reservation reservation, long totalMinor,
                                   Instant updatedAt, int version) {
        return new OrderSnapshot(request, status, reservation, totalMinor, updatedAt, version);
    }
}
