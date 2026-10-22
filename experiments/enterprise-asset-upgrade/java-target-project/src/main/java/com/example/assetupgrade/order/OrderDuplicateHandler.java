package com.example.assetupgrade.order;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.port.OrderRepository;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;

import java.util.Optional;

/**
 * Detects and coordinates duplicate tenant-scoped order commands.
 *
 * <p>A command is a duplicate when its tenant-qualified {@link IdempotencyKey} has already
 * completed successfully. The lifecycle coordinator consults {@link #isDuplicate(IdempotencyKey)}
 * before any side effect, {@link #claim(IdempotencyKey) claims} the key before work begins,
 * {@link #complete(IdempotencyKey) completes} it on success and {@link #release(IdempotencyKey)
 * releases} it after a commit or audit failure so a later retry is permitted. A duplicate replays
 * the stored outcome through {@link #duplicateResult(TenantId, String)} without reserving or
 * committing again.</p>
 *
 * <p>Keys are always tenant-qualified: the same order id from two tenants is never treated as one
 * logical unit.</p>
 */
public final class OrderDuplicateHandler {

    /** Operation name used to build the tenant-qualified order idempotency key. */
    public static final String ORDER_OPERATION = "order-submit";

    /** Operation name used to build the tenant-qualified plugin invocation idempotency key. */
    public static final String PLUGIN_INVOCATION_OPERATION = "plugin-invocation";

    private final IdempotencyPort idempotency;
    private final OrderRepository orders;

    /** Creates a handler with no idempotency store; nothing is ever considered a duplicate. */
    public OrderDuplicateHandler() {
        this(null, null);
    }

    /** Creates a handler backed by {@code idempotency}. */
    public OrderDuplicateHandler(IdempotencyPort idempotency) {
        this(idempotency, null);
    }

    /** Creates a handler backed by {@code idempotency} able to re-read the stored snapshot. */
    public OrderDuplicateHandler(IdempotencyPort idempotency, OrderRepository orders) {
        this.idempotency = idempotency;
        this.orders = orders;
    }

    /** @return the tenant-qualified key for an order submission. */
    public IdempotencyKey key(TenantId tenantId, String orderId) {
        return IdempotencyKey.of(tenantId, ORDER_OPERATION, orderId);
    }

    /** @return the tenant-qualified key for a plugin invocation. */
    public IdempotencyKey pluginKey(TenantId tenantId, String commandId) {
        return IdempotencyKey.of(tenantId, PLUGIN_INVOCATION_OPERATION, commandId);
    }

    /** @return {@code true} when {@code key} has already completed successfully. */
    public boolean isDuplicate(IdempotencyKey key) {
        return idempotency != null && key != null && idempotency.isCompleted(key);
    }

    /** @return {@code true} when the tenant-qualified order has already completed. */
    public boolean isDuplicate(TenantId tenantId, String orderId) {
        if (tenantId == null || orderId == null) {
            return false;
        }
        return isDuplicate(key(tenantId, orderId));
    }

    /**
     * Atomically claims {@code key}.
     *
     * @return {@code true} when the caller may proceed, {@code false} when a concurrent or earlier
     *         caller already holds the claim
     */
    public boolean claim(IdempotencyKey key) {
        return idempotency == null || idempotency.tryMarkCompleted(key);
    }

    /** Marks {@code key} completed after a successful operation. */
    public void complete(IdempotencyKey key) {
        if (idempotency != null && key != null) {
            idempotency.tryMarkCompleted(key);
        }
    }

    /** Releases the claim so a failed or rolled-back command remains retryable. */
    public void release(IdempotencyKey key) {
        if (idempotency != null && key != null) {
            idempotency.remove(key);
        }
    }

    /** @return an already-stored order snapshot for the tenant, if present. */
    public Optional<OrderSnapshot> existing(TenantId tenantId, String orderId) {
        if (orders == null || tenantId == null || orderId == null) {
            return Optional.empty();
        }
        try {
            Optional<OrderSnapshot> stored = orders.find(tenantId, orderId);
            return stored == null ? Optional.empty() : stored;
        } catch (RuntimeException ignored) {
            return Optional.empty();
        }
    }

    /**
     * Rebuilds the stored outcome for a duplicate command without any new side effects.
     *
     * @return an accepted replay carrying the stored status and reservation identity
     */
    public OrderResult duplicateResult(TenantId tenantId, String orderId) {
        Optional<OrderSnapshot> stored = existing(tenantId, orderId);
        OrderStatus status = stored.map(OrderSnapshot::status).orElse(OrderStatus.ACCEPTED);
        String reservationId = stored.map(OrderSnapshot::reservationId).orElse(null);
        return OrderResult.duplicate(status, reservationId);
    }

    /** @return the backing idempotency port, or {@code null} when none is configured. */
    public IdempotencyPort port() {
        return idempotency;
    }

    /** @return the backing order repository, or {@code null} when none is configured. */
    public OrderRepository repository() {
        return orders;
    }

    /** Compatibility seam; accepts an {@link OrderCommand}, {@link IdempotencyKey} or {@link OrderRequest}. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) {
            TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
            return isDuplicate(tenantId, command.orderId());
        }
        if (input instanceof IdempotencyKey key) {
            return isDuplicate(key);
        }
        if (input instanceof OrderRequest order) {
            return isDuplicate(order.tenantId(), order.orderId());
        }
        throw new IllegalArgumentException("Expected an OrderCommand, IdempotencyKey or OrderRequest");
    }
}
