package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.ConflictException;
import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.error.TenantAccessException;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.order.port.InventoryPort;
import com.example.assetupgrade.order.port.OrderLockPort;
import com.example.assetupgrade.order.port.OrderRepository;
import com.example.assetupgrade.order.port.ReservationLedgerPort;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Reserves inventory for an order under a tenant-scoped lock and records the reservation in the
 * ledger.
 *
 * <p>{@link #reserve(OrderRequest)} is a no-op when a non-released reservation already exists for
 * the order: the existing reservation is returned instead of taking new inventory. The lock is
 * always scoped to {@code (tenantId, orderId)} so two tenants never contend for the same order
 * identity and compensation can never cross a tenant boundary.</p>
 */
public final class OrderReservationCoordinator {

    private final InventoryPort inventory;
    private final ReservationLedgerPort ledger;
    private final OrderLockPort locks;
    private final OrderRepository orders;
    private final TimeProvider clock;

    private final ConcurrentHashMap<String, ReentrantLock> fallbackLocks = new ConcurrentHashMap<>();

    /** Creates an unconfigured coordinator; a reservation attempt fails closed. */
    public OrderReservationCoordinator() {
        this(null, null, null, null, null);
    }

    /** Creates a coordinator backed by {@code inventory}. */
    public OrderReservationCoordinator(InventoryPort inventory) {
        this(inventory, null, null, null, null);
    }

    /** Creates a coordinator backed by {@code inventory} and {@code ledger}. */
    public OrderReservationCoordinator(InventoryPort inventory, ReservationLedgerPort ledger) {
        this(inventory, ledger, null, null, null);
    }

    /** Creates a coordinator backed by {@code inventory}, {@code ledger} and {@code locks}. */
    public OrderReservationCoordinator(InventoryPort inventory, ReservationLedgerPort ledger, OrderLockPort locks) {
        this(inventory, ledger, locks, null, null);
    }

    /** Creates a fully configured coordinator. */
    public OrderReservationCoordinator(InventoryPort inventory, ReservationLedgerPort ledger, OrderLockPort locks,
                                       OrderRepository orders, TimeProvider clock) {
        this.inventory = inventory;
        this.ledger = ledger;
        this.locks = locks;
        this.orders = orders;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /**
     * Reserves inventory for {@code order}.
     *
     * @return the existing active reservation or the newly created one
     */
    public Reservation reserve(OrderRequest order) {
        if (order == null) {
            throw new ValidationException("order request is required to reserve inventory");
        }
        TenantId tenantId = order.tenantId();
        String orderId = order.orderId();
        if (tenantId == null) {
            throw new TenantAccessException("inventory reservation requires a tenant");
        }
        if (orderId == null || orderId.isBlank()) {
            throw new ValidationException("inventory reservation requires an orderId");
        }
        Lock handle = lockFor(tenantId, orderId);
        handle.lock();
        try {
            Reservation existing = existingActive(tenantId, orderId);
            if (existing != null) {
                return existing;
            }
            if (inventory == null) {
                throw new StorageFailureException("inventory port is not configured");
            }
            Reservation reservation = inventory.reserve(order);
            if (reservation == null) {
                throw new ConflictException("inventory reservation was not created for order " + orderId);
            }
            Reservation normalized = normalize(reservation, tenantId, orderId);
            if (normalized.released()) {
                throw new ConflictException("inventory reservation was already released for order " + orderId);
            }
            if (ledger != null) {
                ledger.save(normalized);
            }
            return normalized;
        } finally {
            handle.unlock();
        }
    }

    /** @return the active reservation for {@code (tenantId, orderId)}, if one exists. */
    public Optional<Reservation> existing(TenantId tenantId, String orderId) {
        return Optional.ofNullable(existingActive(tenantId, orderId));
    }

    /** @return the deterministic ledger identity used when no reservation id can be derived. */
    public static String reservationIdFor(String orderId) {
        return orderId == null ? null : "reservation:" + orderId;
    }

    /** @return the inventory port, or {@code null} when none is configured. */
    public InventoryPort inventory() {
        return inventory;
    }

    /** @return the reservation ledger port, or {@code null} when none is configured. */
    public ReservationLedgerPort ledger() {
        return ledger;
    }

    /** Compatibility seam; accepts an {@link OrderRequest} and returns the reservation. */
    public Object execute(Object input) {
        if (input instanceof OrderRequest order) {
            return reserve(order);
        }
        throw new IllegalArgumentException("Expected an OrderRequest");
    }

    private Reservation existingActive(TenantId tenantId, String orderId) {
        if (tenantId == null || orderId == null) {
            return null;
        }
        if (ledger != null) {
            for (String candidateId : new String[] {reservationIdFor(orderId), orderId}) {
                if (candidateId == null) {
                    continue;
                }
                try {
                    Optional<Reservation> found = ledger.find(tenantId, candidateId);
                    if (found != null && found.isPresent() && !found.get().released()) {
                        return found.get();
                    }
                } catch (RuntimeException ignored) {
                    // treat a failing ledger lookup as absent
                }
            }
        }
        if (orders != null) {
            try {
                Optional<OrderSnapshot> snapshot = orders.find(tenantId, orderId);
                if (snapshot != null && snapshot.isPresent()) {
                    Reservation reservation = snapshot.get().reservation();
                    if (reservation != null && !reservation.released()) {
                        return reservation;
                    }
                }
            } catch (RuntimeException ignored) {
                // treat a failing order lookup as absent
            }
        }
        return null;
    }

    private static Reservation normalize(Reservation reservation, TenantId tenantId, String orderId) {
        TenantId owningTenant = reservation.tenantId() == null ? tenantId : reservation.tenantId();
        String owningOrder = reservation.orderId() == null ? orderId : reservation.orderId();
        if (owningTenant.equals(reservation.tenantId()) && owningOrder.equals(reservation.orderId())) {
            return reservation;
        }
        return new Reservation(reservation.reservationId(), owningTenant, owningOrder, reservation.quantities(),
                reservation.expiresAt(), reservation.released());
    }

    private Lock lockFor(TenantId tenantId, String orderId) {
        if (locks != null) {
            try {
                Lock lock = locks.lock(tenantId, orderId);
                if (lock != null) {
                    return lock;
                }
            } catch (RuntimeException ignored) {
                // fall back to an in-process lock
            }
        }
        return fallbackLocks.computeIfAbsent(tenantId.value() + ':' + orderId, key -> new ReentrantLock());
    }
}
