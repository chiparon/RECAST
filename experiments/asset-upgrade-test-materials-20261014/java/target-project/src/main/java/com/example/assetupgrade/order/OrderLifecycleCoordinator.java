package com.example.assetupgrade.order;

/**
 * Skeleton seam for OrderLifecycleCoordinator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public final class OrderLifecycleCoordinator implements OrderPluginBridge {
    private final OrderValidator validator;
    private final com.example.assetupgrade.order.port.InventoryPort inventory;
    private final com.example.assetupgrade.order.port.OrderCommitPort committer;
    private final com.example.assetupgrade.order.port.ReservationLedgerPort ledger;
    private final com.example.assetupgrade.order.port.OrderRepository orders;
    private final com.example.assetupgrade.order.port.PluginRegistryPort plugins;
    private final com.example.assetupgrade.audit.AuditPort audit;
    private final com.example.assetupgrade.retry.IdempotencyPort idempotency;
    private final com.example.assetupgrade.persistence.TransactionPort transaction;

    public OrderLifecycleCoordinator() {
        this(null, null, null, null, null, null, null, null, null);
    }

    public OrderLifecycleCoordinator(
            OrderValidator validator,
            com.example.assetupgrade.order.port.InventoryPort inventory,
            com.example.assetupgrade.order.port.OrderCommitPort committer,
            com.example.assetupgrade.order.port.ReservationLedgerPort ledger,
            com.example.assetupgrade.order.port.OrderRepository orders,
            com.example.assetupgrade.order.port.PluginRegistryPort plugins,
            com.example.assetupgrade.audit.AuditPort audit,
            com.example.assetupgrade.retry.IdempotencyPort idempotency,
            com.example.assetupgrade.persistence.TransactionPort transaction) {
        this.validator = validator;
        this.inventory = inventory;
        this.committer = committer;
        this.ledger = ledger;
        this.orders = orders;
        this.plugins = plugins;
        this.audit = audit;
        this.idempotency = idempotency;
        this.transaction = transaction;
    }

    @Override
    public OrderResult submit(OrderCommand command) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) return submit(command);
        throw new IllegalArgumentException("Expected OrderCommand");
    }
}
