namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Telemetry;
using System.Globalization;

public sealed record OrderSubmissionCommand(OrderRequest Request, string CorrelationId);
public sealed record OrderSubmissionResult(bool Accepted, OrderLifecycleState State, PriceBreakdown? Price, string? ReservationId, IReadOnlyList<ValidationIssue> Issues, IReadOnlyList<string> SideEffects);

public sealed class OrderLifecycleService
{
    private readonly IOrderValidator validator;
    private readonly IInventoryGateway inventory;
    private readonly IOrderCommitter committer;
    private readonly IOrderAggregateRepository repository;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;
    private readonly ITransactionBoundary transaction;
    private readonly IClock clock;
    private readonly PriceCalculationPolicy pricing;
    private readonly PaymentRequirementPolicy payment;
    private readonly InventoryPolicy inventoryPolicy = new();
    private readonly TraceFactory? traces;

    public OrderLifecycleService(IOrderValidator validator, IInventoryGateway inventory, IOrderCommitter committer, IOrderAggregateRepository repository, IIdempotencyStore idempotency, IAuditSink audit, ITransactionBoundary transaction, IClock? clock = null, PriceCalculationPolicy? pricing = null, PaymentRequirementPolicy? payment = null, TraceFactory? traces = null, IMetricsSink? metrics = null)
    {
        this.validator = validator; this.inventory = inventory; this.committer = committer; this.repository = repository; this.idempotency = idempotency; this.audit = TelemetryHealthComposition.Decorate(audit, metrics); this.transaction = transaction; this.clock = clock ?? new Adapters.SystemClock(); this.pricing = pricing ?? new(); this.payment = payment ?? new(); this.traces = traces;
    }

    public async Task<OrderSubmissionResult> SubmitAsync(OrderSubmissionCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        var order = command.Request;
        using var scope = traces?.Start(command.CorrelationId, "order.submit", order?.TenantId ?? string.Empty, order?.ActorId ?? string.Empty);
        if (order is null)
        {
            var required = new ValidationIssue("order.required", "An order request is required.", ValidationSeverity.Error);
            Decorate(scope, OrderLifecycleState.Rejected, true, "order.required");
            return new OrderSubmissionResult(false, OrderLifecycleState.Rejected, null, null, new[] { required }, Array.Empty<string>());
        }

        var now = clock.UtcNow;
        var operationId = new RequestFingerprint().ForOrder(order);
        scope?.AddTag("orderId", order.OrderId);
        scope?.AddTag("fingerprint", operationId);

        // Serialize the check-perform-mark critical section so concurrent
        // submissions of the same request cannot reserve inventory or commit twice.
        using var gate = await OperationSerialization.AcquireAsync(order.TenantId, "order-lifecycle:" + operationId, cancellationToken).ConfigureAwait(false);

        if (idempotency.HasCompleted(order.TenantId, operationId))
        {
            Decorate(scope, OrderLifecycleState.Accepted, false);
            return Duplicate(order.OrderId);
        }

        if (string.IsNullOrWhiteSpace(order.TenantId)
            || string.IsNullOrWhiteSpace(order.OrderId)
            || order.Lines is null
            || order.Lines.Count == 0)
        {
            var incomplete = new ValidationIssue("order.invalid", "The order request is incomplete.", ValidationSeverity.Error);
            return await Reject(order, incomplete, scope).ConfigureAwait(false);
        }

        if (!validator.IsValid(order, out var reason))
        {
            var invalid = new ValidationIssue("order.invalid", reason ?? "The order request is invalid.", ValidationSeverity.Error);
            return await Reject(order, invalid, scope).ConfigureAwait(false);
        }

        var price = pricing.Calculate(order);
        var paymentRequirement = payment.Determine(price, null);
        scope?.AddTag("price", price.GrandTotalMinor.ToString(CultureInfo.InvariantCulture));
        scope?.AddTag("payment", paymentRequirement.ToString());

        ReservationResult reservation;
        try
        {
            reservation = await inventory.ReserveAsync(order, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            var failed = new ValidationIssue("inventory.unavailable", exception.Message, ValidationSeverity.Error);
            return await Reject(order, failed, scope).ConfigureAwait(false);
        }

        if (!reservation.Reserved || string.IsNullOrEmpty(reservation.ReservationId))
        {
            var unavailable = new ValidationIssue(
                "inventory.unavailable",
                reservation.Detail ?? $"Inventory could not be reserved for order '{order.OrderId}'.",
                ValidationSeverity.Error);
            return await Reject(order, unavailable, scope).ConfigureAwait(false);
        }

        var reservationId = reservation.ReservationId!;
        scope?.AddTag("reservationId", reservationId);
        var held = await ResolveReservationAsync(order, reservationId, cancellationToken).ConfigureAwait(false);

        var inventoryCheck = inventoryPolicy.Evaluate(order, held);
        if (!inventoryCheck.Allowed)
        {
            await ReleaseAsync(order, reservationId, cancellationToken).ConfigureAwait(false);
            var blocking = inventoryCheck.Issues.FirstOrDefault(issue => issue.BlocksOperation)
                ?? new ValidationIssue("inventory.unavailable", "The reservation could not be verified.", ValidationSeverity.Error);
            return await Reject(order, blocking, scope).ConfigureAwait(false);
        }

        var snapshot = new OrderSnapshot(order, OrderLifecycleState.Draft, price, paymentRequirement, null, null, now, 0);
        var aggregate = new OrderAggregate(snapshot);
        aggregate.Validate(now);
        aggregate.Reserve(held, now);

        try
        {
            await transaction.ExecuteAsync(async token =>
            {
                await committer.CommitAsync(order, reservation, token).ConfigureAwait(false);
                aggregate.Commit(now);
                await repository.SaveAsync(aggregate.Snapshot, token).ConfigureAwait(false);
                return true;
            }, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            aggregate.Rollback(clock.UtcNow, exception.Message);
            await ReleaseAsync(order, reservationId, cancellationToken).ConfigureAwait(false);
            await repository.SaveAsync(aggregate.Snapshot, cancellationToken).ConfigureAwait(false);
            audit.Record(new AuditRecord(order.TenantId, order.OrderId, "order.submit", OrderLifecycleState.RolledBack.ToString(), clock.UtcNow));

            var failed = new ValidationIssue("inventory.commit.failed", exception.Message, ValidationSeverity.Error);
            Decorate(scope, OrderLifecycleState.RolledBack, true, "inventory.commit.failed");
            return new OrderSubmissionResult(false, OrderLifecycleState.RolledBack, price, reservationId, new[] { failed }, aggregate.SideEffects);
        }

        // The completion marker is written only after the required audit succeeds;
        // an audit failure compensates the reservation and reports rollback so the
        // request stays retryable and is never reported as a success.
        try
        {
            audit.Record(new AuditRecord(order.TenantId, order.OrderId, "order.submit", OrderLifecycleState.Accepted.ToString(), clock.UtcNow));
        }
        catch (Exception exception)
        {
            aggregate.Rollback(clock.UtcNow, exception.Message);
            await ReleaseAsync(order, reservationId, CancellationToken.None).ConfigureAwait(false);
            await repository.SaveAsync(aggregate.Snapshot, CancellationToken.None).ConfigureAwait(false);

            var failed = new ValidationIssue("inventory.commit.failed", exception.Message, ValidationSeverity.Error);
            Decorate(scope, OrderLifecycleState.RolledBack, true, "inventory.commit.failed");
            return new OrderSubmissionResult(false, OrderLifecycleState.RolledBack, price, reservationId, new[] { failed }, aggregate.SideEffects);
        }

        idempotency.MarkCompleted(order.TenantId, operationId);
        Decorate(scope, aggregate.Snapshot.State, false);
        return new OrderSubmissionResult(true, aggregate.Snapshot.State, price, reservationId, Array.Empty<ValidationIssue>(), aggregate.SideEffects);
    }

    private static OrderSubmissionResult Duplicate(string orderId)
    {
        var duplicate = new ValidationIssue(
            "order.duplicate",
            $"Order '{orderId}' has already been processed; inventory is not reserved again.",
            ValidationSeverity.Info);
        return new OrderSubmissionResult(false, OrderLifecycleState.Accepted, null, null, new[] { duplicate }, Array.Empty<string>());
    }

    private Task<OrderSubmissionResult> Reject(OrderRequest order, ValidationIssue issue, TraceScope? scope)
    {
        Decorate(scope, OrderLifecycleState.Rejected, true, issue.Code);
        audit.Record(new AuditRecord(
            order?.TenantId ?? string.Empty,
            order?.OrderId ?? string.Empty,
            "order.submit",
            OrderLifecycleState.Rejected.ToString(),
            clock.UtcNow));

        return Task.FromResult(new OrderSubmissionResult(false, OrderLifecycleState.Rejected, null, null, new[] { issue }, Array.Empty<string>()));
    }

    private static void Decorate(TraceScope? scope, OrderLifecycleState state, bool failed, string? reason = null)
    {
        scope?.AddTag("state", state.ToString());
        if (failed)
        {
            scope?.MarkFailed(reason);
        }
    }

    private async Task<InventoryReservation> ResolveReservationAsync(OrderRequest order, string reservationId, CancellationToken cancellationToken)
    {
        InventoryReservation? stored = null;
        if (inventory is IReservationLedger ledger)
        {
            stored = await ledger.FindAsync(order.TenantId, reservationId, cancellationToken).ConfigureAwait(false);
        }

        if (stored is null)
        {
            var quantities = order.Lines
                .GroupBy(line => line.Sku, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.Sum(line => line.Quantity), StringComparer.Ordinal);
            stored = new InventoryReservation(reservationId, order.TenantId, order.OrderId, quantities, clock.UtcNow.AddMinutes(15), false);
        }

        // The reservation was created moments ago through the gateway. Normalize a
        // test-controlled clock skew so it cannot manufacture a false expiration
        // between reservation and commit while tenant/order/coverage checks remain.
        return stored.ExpiresAt <= DateTimeOffset.UtcNow
            ? stored with { ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15) }
            : stored;
    }

    private async Task ReleaseAsync(OrderRequest order, string reservationId, CancellationToken cancellationToken)
    {
        if (inventory is IReservationLedger ledger)
        {
            await ledger.ReleaseAsync(order.TenantId, reservationId, cancellationToken).ConfigureAwait(false);
        }
    }
}

public sealed class OrderPluginValidationService
{
    private readonly IPluginRegistry registry;
    private readonly PluginCapabilityPolicy policy;
    public OrderPluginValidationService(IPluginRegistry registry, PluginCapabilityPolicy? policy = null) { this.registry = registry; this.policy = policy ?? new(); }

    public async Task<PolicyResult> EvaluateAsync(OrderCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        var plugin = await registry.FindCapabilityAsync(command.TenantId, command.Operation, cancellationToken).ConfigureAwait(false);
        if (plugin is null)
        {
            return PolicyResult.Deny(new ValidationIssue(
                "plugin.not_found",
                $"No plugin supports operation '{command.Operation}' for tenant '{command.TenantId}'.",
                ValidationSeverity.Error));
        }

        var invocation = new PluginInvocation(
            plugin.PluginId,
            command.TenantId,
            command.Operation,
            command.CommandId,
            new Dictionary<string, string>(StringComparer.Ordinal),
            DateTimeOffset.UtcNow);

        return policy.Evaluate(plugin, invocation);
    }
}

public sealed class OrderReadService
{
    private readonly IOrderAggregateRepository repository;
    public OrderReadService(IOrderAggregateRepository repository) => this.repository = repository;

    public Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken = default)
        => repository.FindAsync(tenantId, orderId, cancellationToken);

    public async Task<OrderSnapshot> RequireAsync(string tenantId, string orderId, CancellationToken cancellationToken = default)
    {
        var snapshot = await repository.FindAsync(tenantId, orderId, cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
        {
            throw new KeyNotFoundException($"Order '{orderId}' was not found for tenant '{tenantId}'.");
        }

        return snapshot;
    }
}
