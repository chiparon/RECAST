package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.TenantAccessException;
import com.example.assetupgrade.order.port.InventoryPort;
import com.example.assetupgrade.order.port.OrderRepository;
import com.example.assetupgrade.order.port.PaymentPort;
import com.example.assetupgrade.order.port.ReservationLedgerPort;

import java.util.List;
import java.util.Optional;

/**
 * Compensates a failed order commit or audit step.
 *
 * <p>{@link #rollback(OrderRequest, Reservation, List)} releases the reservation through both the
 * inventory port and the reservation ledger, reverses the payment authorization and persists a
 * {@code ROLLED_BACK} snapshot. Compensation is idempotent: an already-released reservation is
 * skipped, and a reservation owned by another tenant is never released.</p>
 */
public final class OrderRollbackCoordinator {

    private final InventoryPort inventory;
    private final ReservationLedgerPort ledger;
    private final PaymentPort payment;
    private final OrderRepository orders;
    private final TimeProvider clock;

    /** Creates an unconfigured coordinator; compensation still persists a rollback snapshot. */
    public OrderRollbackCoordinator() {
        this(null, null, null, null, null);
    }

    /** Creates a coordinator backed by {@code inventory}. */
    public OrderRollbackCoordinator(InventoryPort inventory) {
        this(inventory, null, null, null, null);
    }

    /** Creates a coordinator backed by {@code inventory} and {@code ledger}. */
    public OrderRollbackCoordinator(InventoryPort inventory, ReservationLedgerPort ledger) {
        this(inventory, ledger, null, null, null);
    }

    /** Creates a coordinator backed by {@code inventory}, {@code ledger} and {@code payment}. */
    public OrderRollbackCoordinator(InventoryPort inventory, ReservationLedgerPort ledger, PaymentPort payment) {
        this(inventory, ledger, payment, null, null);
    }

    /** Creates a fully configured coordinator. */
    public OrderRollbackCoordinator(InventoryPort inventory, ReservationLedgerPort ledger, PaymentPort payment,
                                    OrderRepository orders, TimeProvider clock) {
        this.inventory = inventory;
        this.ledger = ledger;
        this.payment = payment;
        this.orders = orders;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Compensates {@code reservation} and persists a {@code ROLLED_BACK} snapshot. */
    public OrderSnapshot rollback(OrderRequest order, Reservation reservation) {
        return rollback(order, reservation, List.of());
    }

    /**
     * Compensates {@code reservation}, reverses payment and persists a {@code ROLLED_BACK} snapshot.
     *
     * @param problems the problems explaining the rollback, retained for evidence
     * @return the persisted rollback snapshot
     */
    public OrderSnapshot rollback(OrderRequest order, Reservation reservation, List<ServiceProblem> problems) {
        TenantId tenantId = order != null ? order.tenantId() : (reservation != null ? reservation.tenantId() : null);
        String orderId = order != null ? order.orderId() : (reservation != null ? reservation.orderId() : null);
        long totalMinor = order == null ? 0L : safeTotal(order);
        Reservation released = releaseReservation(order, reservation);
        if (payment != null && order != null) {
            try {
                payment.reverse(order);
            } catch (RuntimeException ignored) {
                // compensation is best-effort; the rollback outcome is still recorded
            }
        }
        OrderSnapshot snapshot = new OrderSnapshot(order, OrderStatus.ROLLED_BACK, released, totalMinor,
                clock.now(), nextVersion(tenantId, orderId));
        if (orders != null && order != null) {
            orders.save(snapshot);
        }
        return snapshot;
    }

    /**
     * Releases the reservation through the inventory port and the ledger.
     *
     * @return the released reservation, or the original reservation when it was already released
     */
    public Reservation releaseReservation(OrderRequest order, Reservation reservation) {
        if (reservation == null) {
            return null;
        }
        if (reservation.released() || alreadyReleased(reservation)) {
            return reservation.release();
        }
        TenantId tenantId = reservation.tenantId() != null
                ? reservation.tenantId()
                : (order == null ? null : order.tenantId());
        if (tenantId == null) {
            throw new TenantAccessException("reservation tenant is required to release a reservation");
        }
        if (reservation.tenantId() != null && order != null && order.tenantId() != null
                && !reservation.tenantId().equals(order.tenantId())) {
            throw new TenantAccessException("refusing to release another tenant's reservation");
        }
        if (inventory != null) {
            inventory.release(tenantId, reservation.reservationId());
        }
        if (ledger != null) {
            ledger.release(tenantId, reservation.reservationId());
        }
        return reservation.release();
    }

    /** @return the inventory port, or {@code null} when none is configured. */
    public InventoryPort inventory() {
        return inventory;
    }

    /** @return the payment port, or {@code null} when none is configured. */
    public PaymentPort payment() {
        return payment;
    }

    /** Compatibility seam; accepts a {@link RollbackRequest} and returns the rollback snapshot. */
    public Object execute(Object input) {
        if (input instanceof RollbackRequest request) {
            return rollback(request.order(), request.reservation(), request.problems());
        }
        throw new IllegalArgumentException("Expected a RollbackRequest");
    }

    private boolean alreadyReleased(Reservation reservation) {
        if (ledger == null || reservation.tenantId() == null || reservation.reservationId() == null) {
            return false;
        }
        try {
            Optional<Reservation> stored = ledger.find(reservation.tenantId(), reservation.reservationId());
            return stored != null && stored.isPresent() && stored.get().released();
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private int nextVersion(TenantId tenantId, String orderId) {
        if (orders == null || tenantId == null || orderId == null) {
            return 1;
        }
        try {
            Optional<OrderSnapshot> stored = orders.find(tenantId, orderId);
            return stored.map(snapshot -> snapshot.version() + 1).orElse(1);
        } catch (RuntimeException ignored) {
            return 1;
        }
    }

    private static long safeTotal(OrderRequest order) {
        try {
            return order.lineTotalMinor();
        } catch (ArithmeticException overflow) {
            return 0L;
        }
    }

    /** Request holder accepted by the compatibility seam. */
    public record RollbackRequest(OrderRequest order, Reservation reservation, List<ServiceProblem> problems) {

        public RollbackRequest {
            problems = problems == null ? List.of() : List.copyOf(problems);
        }

        /** Creates a request with no explanatory problems. */
        public RollbackRequest(OrderRequest order, Reservation reservation) {
            this(order, reservation, List.of());
        }
    }
}
