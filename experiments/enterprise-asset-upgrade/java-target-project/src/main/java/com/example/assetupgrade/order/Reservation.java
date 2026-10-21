package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Tenant-scoped inventory reservation held for an order.
 *
 * <p>The record components {@code reservationId, tenantId, orderId, quantities, expiresAt,
 * released} are the public contract. {@code quantities} is defensively copied into an unmodifiable
 * map keyed by SKU. A reservation always belongs to exactly one tenant; compensation must never
 * release a reservation held by another tenant.</p>
 *
 * @param reservationId the reservation identity
 * @param tenantId      the owning tenant
 * @param orderId       the order the reservation was taken for
 * @param quantities    the reserved quantity keyed by SKU
 * @param expiresAt     the instant the reservation lapses, or {@code null} when it never does
 * @param released      whether the reservation has already been released
 */
public record Reservation(String reservationId, TenantId tenantId, String orderId,
                          Map<String, Integer> quantities, Instant expiresAt, boolean released) {

    public Reservation {
        quantities = quantities == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(quantities));
    }

    /** @return the reserved quantity for {@code sku}, or {@code 0} when none was reserved. */
    public int quantityFor(String sku) {
        Integer quantity = quantities.get(sku);
        return quantity == null ? 0 : quantity;
    }

    /** @return {@code true} when {@code tenantId} owns this reservation. */
    public boolean belongsTo(TenantId tenantId) {
        return tenantId != null && tenantId.equals(this.tenantId);
    }

    /** @return {@code true} when the reservation has lapsed at {@code now}. */
    public boolean isExpired(Instant now) {
        return expiresAt != null && now != null && !now.isBefore(expiresAt);
    }

    /** @return {@code true} when this reservation can still be released. */
    public boolean isActive() {
        return !released;
    }

    /** @return a copy of this reservation marked released. */
    public Reservation release() {
        return released ? this : new Reservation(reservationId, tenantId, orderId, quantities, expiresAt, true);
    }

    /** @return a copy of this reservation with the supplied released flag. */
    public Reservation withReleased(boolean newReleased) {
        return released == newReleased
                ? this
                : new Reservation(reservationId, tenantId, orderId, quantities, expiresAt, newReleased);
    }

    /** Creates a reservation from its parts. */
    public static Reservation of(String reservationId, TenantId tenantId, String orderId,
                                 Map<String, Integer> quantities, Instant expiresAt, boolean released) {
        return new Reservation(reservationId, tenantId, orderId, quantities, expiresAt, released);
    }
}
