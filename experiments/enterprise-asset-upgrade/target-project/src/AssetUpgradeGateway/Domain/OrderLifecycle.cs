namespace AssetUpgradeGateway.Domain;

using AssetUpgradeGateway;

public enum OrderLifecycleState
{
    Draft,
    Validating,
    AwaitingInventory,
    Reserved,
    Committing,
    Accepted,
    Rejected,
    RollingBack,
    RolledBack,
}

public enum PaymentRequirement
{
    None,
    PreAuthorization,
    CaptureOnCommit,
}

public sealed record CustomerAccount(
    string CustomerId,
    string TenantId,
    string? Email,
    string Currency,
    IReadOnlySet<string> Segments)
{
    public bool BelongsTo(string tenantId)
        => string.Equals(TenantId, tenantId, StringComparison.Ordinal);
    public bool IsSegment(string segment) => Segments.Contains(segment);
}

public sealed record PriceBreakdown(
    long MerchandiseMinor,
    long DiscountMinor,
    long ShippingMinor,
    long TaxMinor,
    string Currency)
{
    public long GrandTotalMinor => MerchandiseMinor - DiscountMinor + ShippingMinor + TaxMinor;

    public PriceBreakdown ApplyDiscount(long discountMinor)
        => this with { DiscountMinor = discountMinor };
}

public sealed record InventoryReservation(
    string ReservationId,
    string TenantId,
    string OrderId,
    IReadOnlyDictionary<string, int> Quantities,
    DateTimeOffset ExpiresAt,
    bool Released)
{
    public bool IsExpired(DateTimeOffset now) => now >= ExpiresAt;
    public InventoryReservation Release()
        => Released ? this : this with { Released = true };
    public bool Contains(string sku, int quantity)
        => !Released && Quantities.TryGetValue(sku, out var reserved) && reserved >= quantity;
}

public sealed record OrderSnapshot(
    OrderRequest Request,
    OrderLifecycleState State,
    PriceBreakdown Price,
    PaymentRequirement PaymentRequirement,
    InventoryReservation? Reservation,
    string? RejectionReason,
    DateTimeOffset UpdatedAt,
    int Version)
{
    public bool IsTerminal
        => State is OrderLifecycleState.Accepted
            or OrderLifecycleState.Rejected
            or OrderLifecycleState.RolledBack;

    public OrderSnapshot BeginValidation(DateTimeOffset now)
        => Transition(OrderLifecycleState.Validating, now);
    public OrderSnapshot AwaitInventory(DateTimeOffset now)
        => Transition(OrderLifecycleState.AwaitingInventory, now);
    public OrderSnapshot Reserve(InventoryReservation reservation, DateTimeOffset now)
        => (this with { Reservation = reservation })
            .Transition(OrderLifecycleState.Reserved, now);
    public OrderSnapshot BeginCommit(DateTimeOffset now)
        => Transition(OrderLifecycleState.Committing, now);
    public OrderSnapshot Accept(DateTimeOffset now)
        => Transition(OrderLifecycleState.Accepted, now);
    public OrderSnapshot Reject(string reason, DateTimeOffset now)
        => (this with { RejectionReason = reason })
            .Transition(OrderLifecycleState.Rejected, now);
    public OrderSnapshot BeginRollback(DateTimeOffset now)
        => Transition(OrderLifecycleState.RollingBack, now);
    public OrderSnapshot CompleteRollback(DateTimeOffset now)
        => Transition(OrderLifecycleState.RolledBack, now);
    private OrderSnapshot Transition(OrderLifecycleState next, DateTimeOffset now)
        => this with { State = next, UpdatedAt = now, Version = Version + 1 };
}

public sealed record PluginDescriptor(
    string PluginId,
    string TenantId,
    string DisplayName,
    Version Version,
    IReadOnlySet<string> Capabilities,
    bool Enabled)
{
    public bool Supports(string capability) => Capabilities.Contains(capability);
    public PluginDescriptor Disable() => this with { Enabled = false };
    public PluginDescriptor Enable() => this with { Enabled = true };
}

public sealed record PluginInvocation(
    string PluginId,
    string TenantId,
    string Operation,
    string RequestId,
    IReadOnlyDictionary<string, string> Parameters,
    DateTimeOffset RequestedAt)
{
    public PluginInvocation WithParameter(string key, string value)
    {
        var merged = new Dictionary<string, string>(Parameters, StringComparer.Ordinal)
        {
            [key] = value,
        };
        return this with { Parameters = merged };
    }
}

public sealed record OrderDecision(
    bool Allowed,
    IReadOnlyList<ValidationIssue> Issues,
    PriceBreakdown? Price,
    PaymentRequirement PaymentRequirement,
    string DecisionCode)
{
    public bool HasBlockingIssue => Issues.Any(issue => issue.BlocksOperation);

    public static OrderDecision Deny(string code, params ValidationIssue[] issues)
        => new(false, issues ?? Array.Empty<ValidationIssue>(), null, PaymentRequirement.None, code);
    public static OrderDecision Allow(PriceBreakdown price, PaymentRequirement payment)
        => new(true, Array.Empty<ValidationIssue>(), price, payment, "Allowed");
}

public sealed record OrderOperationResult(
    string OperationId,
    bool Succeeded,
    OrderLifecycleState State,
    IReadOnlyList<string> SideEffects,
    IReadOnlyList<ValidationIssue> Issues)
{
    public static OrderOperationResult Rejected(string operationId, params ValidationIssue[] issues)
        => new(
            operationId,
            false,
            OrderLifecycleState.Rejected,
            Array.Empty<string>(),
            issues ?? Array.Empty<ValidationIssue>());
}

public sealed class OrderAggregate
{
    private readonly List<string> sideEffects = [];

    public OrderAggregate(OrderSnapshot snapshot)
    {
        Snapshot = snapshot;
    }
    public OrderSnapshot Snapshot { get; internal set; }

    public IReadOnlyList<string> SideEffects => sideEffects;

    public void Validate(DateTimeOffset now)
    {
        if (Snapshot.State != OrderLifecycleState.Draft)
        {
            return;
        }

        var request = Snapshot.Request;
        if (request is null || request.Lines is null || request.Lines.Count == 0)
        {
            return;
        }

        Snapshot = Snapshot.BeginValidation(now);
        sideEffects.Add("validated");
    }

    public void Reserve(InventoryReservation reservation, DateTimeOffset now)
    {
        if (reservation is null)
        {
            return;
        }

        if (Snapshot.State is not (OrderLifecycleState.Validating or OrderLifecycleState.AwaitingInventory))
        {
            return;
        }

        var request = Snapshot.Request;
        if (request is null
            || !string.Equals(reservation.TenantId, request.TenantId, StringComparison.Ordinal)
            || !string.Equals(reservation.OrderId, request.OrderId, StringComparison.Ordinal))
        {
            return;
        }

        var attached = Snapshot.Reservation;
        if (attached is not null
            && string.Equals(attached.ReservationId, reservation.ReservationId, StringComparison.Ordinal))
        {
            return;
        }

        Snapshot = Snapshot.Reserve(reservation, now);
        sideEffects.Add($"reserved:{reservation.ReservationId}");
    }

    public void Commit(DateTimeOffset now)
    {
        if (Snapshot.State == OrderLifecycleState.Accepted)
        {
            return;
        }

        if (Snapshot.State != OrderLifecycleState.Reserved)
        {
            return;
        }

        Snapshot = Snapshot.BeginCommit(now).Accept(now);
        sideEffects.Add("committed");
    }

    public void Rollback(DateTimeOffset now, string reason)
    {
        if (Snapshot.State is not (OrderLifecycleState.Validating
            or OrderLifecycleState.AwaitingInventory
            or OrderLifecycleState.Reserved
            or OrderLifecycleState.Committing))
        {
            return;
        }

        var rolling = Snapshot.BeginRollback(now);

        var reservation = rolling.Reservation;
        if (reservation is not null && !reservation.Released)
        {
            rolling = rolling with { Reservation = reservation.Release() };
        }

        rolling = rolling with { RejectionReason = reason };
        Snapshot = rolling.CompleteRollback(now);
        sideEffects.Add($"rolled-back:{reason}");
    }
}

public sealed record OrderBatch(
    string TenantId,
    IReadOnlyList<OrderRequest> Orders,
    string BatchId,
    DateTimeOffset CreatedAt)
{
    public int Count => Orders.Count;

    public bool ContainsTenantOnly()
        => Orders.All(order => string.Equals(order.TenantId, TenantId, StringComparison.Ordinal));
}
