namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed record OrderPolicyOptions(long MaximumOrderTotalMinor, int MaximumLineCount, int MaximumQuantity, IReadOnlySet<string> SupportedCurrencies);

public sealed class OrderValidationPolicy : IOrderValidator
{
    private readonly OrderPolicyOptions? options;
    public OrderValidationPolicy(OrderPolicyOptions? options = null) => this.options = options;

    public bool IsValid(OrderRequest order, out string? reason)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public PolicyResult Evaluate(OrderRequest order)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class PriceCalculationPolicy
{
    public PriceBreakdown Calculate(OrderRequest order, CustomerAccount? customer = null)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class PaymentRequirementPolicy
{
    public PaymentRequirement Determine(PriceBreakdown price, CustomerAccount? customer)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class InventoryPolicy
{
    public PolicyResult Evaluate(OrderRequest order, InventoryReservation? reservation)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class OrderStateMachine
{
    public bool CanTransition(OrderLifecycleState from, OrderLifecycleState to) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderLifecycleState Transition(OrderLifecycleState from, OrderLifecycleState to) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class PluginCapabilityPolicy
{
    public PolicyResult Evaluate(PluginDescriptor plugin, PluginInvocation invocation)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class OrderIdempotencyPolicy
{
    public PolicyResult Evaluate(bool alreadyCompleted, string operationId)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
