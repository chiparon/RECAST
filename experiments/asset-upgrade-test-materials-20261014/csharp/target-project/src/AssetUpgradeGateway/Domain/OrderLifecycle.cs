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
    public bool BelongsTo(string tenantId) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool IsSegment(string segment) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record PriceBreakdown(
    long MerchandiseMinor,
    long DiscountMinor,
    long ShippingMinor,
    long TaxMinor,
    string Currency)
{
    public long GrandTotalMinor => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public PriceBreakdown ApplyDiscount(long discountMinor)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record InventoryReservation(
    string ReservationId,
    string TenantId,
    string OrderId,
    IReadOnlyDictionary<string, int> Quantities,
    DateTimeOffset ExpiresAt,
    bool Released)
{
    public bool IsExpired(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public InventoryReservation Release() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool Contains(string sku, int quantity)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
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
    public bool IsTerminal => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public OrderSnapshot BeginValidation(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot AwaitInventory(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot Reserve(InventoryReservation reservation, DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot BeginCommit(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot Accept(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot Reject(string reason, DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot BeginRollback(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderSnapshot CompleteRollback(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private OrderSnapshot Transition(OrderLifecycleState next, DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record PluginDescriptor(
    string PluginId,
    string TenantId,
    string DisplayName,
    Version Version,
    IReadOnlySet<string> Capabilities,
    bool Enabled)
{
    public bool Supports(string capability) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public PluginDescriptor Disable() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public PluginDescriptor Enable() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
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
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record OrderDecision(
    bool Allowed,
    IReadOnlyList<ValidationIssue> Issues,
    PriceBreakdown? Price,
    PaymentRequirement PaymentRequirement,
    string DecisionCode)
{
    public bool HasBlockingIssue => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public static OrderDecision Deny(string code, params ValidationIssue[] issues)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public static OrderDecision Allow(PriceBreakdown price, PaymentRequirement payment)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record OrderOperationResult(
    string OperationId,
    bool Succeeded,
    OrderLifecycleState State,
    IReadOnlyList<string> SideEffects,
    IReadOnlyList<ValidationIssue> Issues)
{
    public static OrderOperationResult Rejected(string operationId, params ValidationIssue[] issues)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class OrderAggregate
{
    private readonly List<string> sideEffects = [];

    public OrderAggregate(OrderSnapshot snapshot)
    {
        Snapshot = snapshot;
    }
    public OrderSnapshot Snapshot { get; internal set; }

    public IReadOnlyList<string> SideEffects => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public void Validate(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public void Reserve(InventoryReservation reservation, DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public void Commit(DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public void Rollback(DateTimeOffset now, string reason)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record OrderBatch(
    string TenantId,
    IReadOnlyList<OrderRequest> Orders,
    string BatchId,
    DateTimeOffset CreatedAt)
{
    public int Count => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public bool ContainsTenantOnly()
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
