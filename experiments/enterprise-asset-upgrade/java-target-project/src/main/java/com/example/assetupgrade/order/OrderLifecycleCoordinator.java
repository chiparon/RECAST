package com.example.assetupgrade.order;

import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.error.AssetUpgradeException;
import com.example.assetupgrade.order.port.InventoryPort;
import com.example.assetupgrade.order.port.OrderCommitPort;
import com.example.assetupgrade.order.port.OrderEventPort;
import com.example.assetupgrade.order.port.OrderLockPort;
import com.example.assetupgrade.order.port.OrderPricingPort;
import com.example.assetupgrade.order.port.OrderRepository;
import com.example.assetupgrade.order.port.PaymentPort;
import com.example.assetupgrade.order.port.PluginRegistryPort;
import com.example.assetupgrade.order.port.ReservationLedgerPort;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Tenant-aware order-plugin lifecycle boundary.
 *
 * <p>The coordinator validates the command metadata and every order line, resolves the plugin
 * capability, and only then reserves inventory, commits the order and writes its audit evidence -
 * all inside the caller's {@link TransactionPort} atomic boundary. A duplicate command returns the
 * stored outcome without reserving or committing again. If the commit or audit step fails the
 * reservation is released, the payment authorization reversed, the idempotency key left incomplete
 * and a {@code ROLLED_BACK} outcome is recorded so a later retry can proceed.</p>
 *
 * <p>Every provider interaction goes through a typed, tenant-scoped port; no provider type is
 * referenced here.</p>
 */
public final class OrderLifecycleCoordinator implements OrderPluginBridge {

    private final OrderValidator validator;
    private final InventoryPort inventory;
    private final OrderCommitPort committer;
    private final ReservationLedgerPort ledger;
    private final OrderRepository orders;
    private final PluginRegistryPort plugins;
    private final AuditPort audit;
    private final IdempotencyPort idempotency;
    private final TransactionPort transaction;
    private final OrderLockPort locks;
    private final PaymentPort payment;
    private final OrderPricingPort pricing;
    private final OrderEventPort events;
    private final TimeProvider clock;

    private final OrderInventoryPolicy inventoryPolicy;
    private final OrderPricingPolicy pricingPolicy;
    private final PluginCapabilityPolicy capabilityPolicy;
    private final OrderReservationCoordinator reservationCoordinator;
    private final OrderCommitCoordinator commitCoordinator;
    private final OrderRollbackCoordinator rollbackCoordinator;
    private final OrderDuplicateHandler duplicateHandler;
    private final OrderAuditHandler auditHandler;
    private final PluginInvocationHandler invocationHandler;

    /** Creates an unconfigured coordinator; every submission fails closed. */
    public OrderLifecycleCoordinator() {
        this(null, null, null, null, null, null, null, null, null);
    }

    /** Creates the coordinator with the collaborators declared by the order-plugin bridge. */
    public OrderLifecycleCoordinator(
            OrderValidator validator,
            InventoryPort inventory,
            OrderCommitPort committer,
            ReservationLedgerPort ledger,
            OrderRepository orders,
            PluginRegistryPort plugins,
            AuditPort audit,
            IdempotencyPort idempotency,
            TransactionPort transaction) {
        this(validator, inventory, committer, ledger, orders, plugins, audit, idempotency, transaction,
                null, null, null, null, null);
    }

    /** Creates the coordinator with the locking, payment, pricing and event ports supplied. */
    public OrderLifecycleCoordinator(
            OrderValidator validator,
            InventoryPort inventory,
            OrderCommitPort committer,
            ReservationLedgerPort ledger,
            OrderRepository orders,
            PluginRegistryPort plugins,
            AuditPort audit,
            IdempotencyPort idempotency,
            TransactionPort transaction,
            OrderLockPort locks,
            PaymentPort payment,
            OrderPricingPort pricing,
            OrderEventPort events) {
        this(validator, inventory, committer, ledger, orders, plugins, audit, idempotency, transaction,
                locks, payment, pricing, events, null);
    }

    /** Creates a fully configured coordinator using {@code clock} for snapshot timestamps. */
    public OrderLifecycleCoordinator(
            OrderValidator validator,
            InventoryPort inventory,
            OrderCommitPort committer,
            ReservationLedgerPort ledger,
            OrderRepository orders,
            PluginRegistryPort plugins,
            AuditPort audit,
            IdempotencyPort idempotency,
            TransactionPort transaction,
            OrderLockPort locks,
            PaymentPort payment,
            OrderPricingPort pricing,
            OrderEventPort events,
            TimeProvider clock) {
        this.validator = validator;
        this.inventory = inventory;
        this.committer = committer;
        this.ledger = ledger;
        this.orders = orders;
        this.plugins = plugins;
        this.audit = audit;
        this.idempotency = idempotency;
        this.transaction = transaction;
        this.locks = locks;
        this.payment = payment;
        this.pricing = pricing;
        this.events = events;
        this.clock = clock == null ? TimeProvider.system() : clock;

        this.inventoryPolicy = new OrderInventoryPolicy(inventory);
        this.pricingPolicy = new OrderPricingPolicy(pricing);
        this.capabilityPolicy = new PluginCapabilityPolicy(plugins);
        this.reservationCoordinator = new OrderReservationCoordinator(inventory, ledger, locks, orders, this.clock);
        this.commitCoordinator = new OrderCommitCoordinator(committer, orders, this.clock);
        this.rollbackCoordinator = new OrderRollbackCoordinator(inventory, ledger, payment, orders, this.clock);
        this.duplicateHandler = new OrderDuplicateHandler(idempotency, orders);
        this.auditHandler = new OrderAuditHandler(audit, this.clock);
        this.invocationHandler = new PluginInvocationHandler(plugins);
    }

    @Override
    public OrderResult submit(OrderCommand command) {
        if (command == null || command.metadata() == null || command.order() == null) {
            return OrderResult.rejected(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                    "order command, metadata and order are required"));
        }
        CommandMetadata metadata = command.metadata();
        TenantId tenantId = metadata.tenantId();
        ActorId actorId = metadata.actorId();
        CorrelationId correlationId = metadata.correlationId();
        if (tenantId == null || actorId == null || correlationId == null) {
            return OrderResult.rejected(ServiceProblem.of(ProblemCode.TENANT_DENIED,
                    "command metadata must carry tenant, actor and correlation identity"));
        }

        OrderRequest order = command.order();
        if (order.tenantId() != null && !order.tenantId().equals(tenantId)) {
            return OrderResult.rejected(ServiceProblem.of(ProblemCode.TENANT_DENIED,
                    "order tenant does not match the command tenant", order.orderId()));
        }
        String orderId = order.orderId();

        List<ServiceProblem> problems = new ArrayList<>();
        problems.addAll(effectiveValidator().validate(order));
        problems.addAll(inventoryPolicy.validate(order));
        if (!problems.isEmpty()) {
            return OrderResult.rejected(problems);
        }

        ServiceProblem capabilityProblem = capabilityPolicy.resolve(tenantId, command.pluginId(),
                PluginInvocationHandler.OPERATION);
        if (capabilityProblem != null) {
            return OrderResult.rejected(List.of(capabilityProblem));
        }
        PluginDescriptor descriptor = capabilityPolicy.descriptor(tenantId, command.pluginId()).orElse(null);
        PluginInvocation invocation = invocationHandler.invocation(descriptor, PluginInvocationHandler.OPERATION,
                orderId, tenantId, Map.of());

        IdempotencyKey key = duplicateHandler.key(tenantId, orderId);
        if (duplicateHandler.isDuplicate(key)) {
            return duplicateHandler.duplicateResult(tenantId, orderId);
        }

        Reservation[] holder = new Reservation[1];
        Supplier<OrderResult> boundary =
                () -> executeBoundary(metadata, order, invocation, key, holder);
        try {
            OrderResult result = transaction != null ? transaction.inTransaction(boundary) : boundary.get();
            if (result == null) {
                duplicateHandler.release(key);
                return compensate(order, tenantId, orderId, correlationId, holder[0],
                        new IllegalStateException("transaction boundary returned no order result"));
            }
            if (result.accepted()) {
                duplicateHandler.complete(key);
            } else {
                duplicateHandler.release(key);
            }
            return result;
        } catch (RuntimeException failure) {
            duplicateHandler.release(key);
            return compensate(order, tenantId, orderId, correlationId, holder[0], failure);
        }
    }

    /** Runs the mutation set inside the atomic boundary after the duplicate pre-check. */
    private OrderResult executeBoundary(CommandMetadata metadata, OrderRequest order, PluginInvocation invocation,
                                        IdempotencyKey key, Reservation[] holder) {
        TenantId tenantId = metadata.tenantId();
        String orderId = order.orderId();
        CorrelationId correlationId = metadata.correlationId();
        if (duplicateHandler.isDuplicate(key)) {
            return duplicateHandler.duplicateResult(tenantId, orderId);
        }
        if (!duplicateHandler.claim(key)) {
            return duplicateHandler.duplicateResult(tenantId, orderId);
        }

        auditHandler.recordPluginInvocation(tenantId, invocation.pluginId(), orderId, correlationId,
                invocation.operation(), true);

        Reservation reservation = reservationCoordinator.reserve(order);
        holder[0] = reservation;
        long totalMinor = pricingPolicy.totalMinor(order);
        if (payment != null) {
            payment.authorize(order, totalMinor);
        }
        commitCoordinator.commit(order, reservation, totalMinor);

        String reservationId = reservation == null ? null : reservation.reservationId();
        List<String> sideEffects = new ArrayList<>();
        sideEffects.add("reserved:" + reservationId);
        sideEffects.add("committed:" + orderId);
        OrderResult accepted = OrderResult.accepted(reservationId, sideEffects);

        auditHandler.recordOrderSubmission(tenantId, orderId, AuditStatus.ACCEPTED, correlationId, reservationId,
                invocation.pluginId(), "accepted");
        if (events != null) {
            events.publish(accepted, correlationId);
        }
        return accepted;
    }

    /** Releases the reservation, reverses payment and reports the rollback outcome. */
    private OrderResult compensate(OrderRequest order, TenantId tenantId, String orderId,
                                   CorrelationId correlationId, Reservation reservation, RuntimeException failure) {
        ServiceProblem problem = problemFor(failure, orderId);
        try {
            rollbackCoordinator.rollback(order, reservation, List.of(problem));
        } catch (RuntimeException rollbackFailure) {
            // compensation is best-effort; the rollback outcome is still reported
        }
        String reservationId = reservation == null ? null : reservation.reservationId();
        List<String> sideEffects = new ArrayList<>();
        if (reservation != null) {
            sideEffects.add("released:" + reservationId);
        }
        try {
            auditHandler.recordRollback(tenantId, orderId, correlationId, reservationId, describe(failure));
        } catch (RuntimeException ignored) {
            // audit is best-effort during compensation and must not mask the rollback outcome
        }
        return OrderResult.rolledBack(reservationId, List.of(problem), sideEffects);
    }

    private OrderValidator effectiveValidator() {
        return validator != null ? validator : OrderValidator.defaults();
    }

    private static ServiceProblem problemFor(Throwable failure, String orderId) {
        if (failure instanceof AssetUpgradeException typed && typed.problemCode() != null) {
            return ServiceProblem.of(typed.problemCode(), describe(failure), orderId);
        }
        return ServiceProblem.of(ProblemCode.RETRYABLE, describe(failure), orderId);
    }

    private static String describe(Throwable failure) {
        if (failure == null) {
            return "unspecified failure";
        }
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    /** @return the backing validator, or {@code null} when the default validator is used. */
    public OrderValidator validator() {
        return validator;
    }

    /** @return the transaction boundary, or {@code null} when the boundary runs inline. */
    public TransactionPort transaction() {
        return transaction;
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) {
            return submit(command);
        }
        throw new IllegalArgumentException("Expected OrderCommand");
    }
}
