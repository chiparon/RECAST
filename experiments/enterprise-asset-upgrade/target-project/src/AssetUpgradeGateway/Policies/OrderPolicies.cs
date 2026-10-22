namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed record OrderPolicyOptions(long MaximumOrderTotalMinor, int MaximumLineCount, int MaximumQuantity, IReadOnlySet<string> SupportedCurrencies);

public sealed class OrderValidationPolicy : IOrderValidator
{
    private static readonly OrderPolicyOptions Fallback = new(
        long.MaxValue,
        1000,
        1000,
        new HashSet<string>(StringComparer.OrdinalIgnoreCase));

    private readonly OrderPolicyOptions? options;
    public OrderValidationPolicy(OrderPolicyOptions? options = null) => this.options = options;

    private OrderPolicyOptions Options => options ?? Fallback;

    public bool IsValid(OrderRequest order, out string? reason)
    {
        var blocking = Collect(order).FirstOrDefault(issue => issue.BlocksOperation);
        if (blocking is null)
        {
            reason = null;
            return true;
        }

        reason = blocking.Message;
        return false;
    }

    public PolicyResult Evaluate(OrderRequest order)
    {
        var issues = Collect(order);
        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    private List<ValidationIssue> Collect(OrderRequest? order)
    {
        var issues = new List<ValidationIssue>();

        if (order is null)
        {
            issues.Add(Error("order.required", "An order request is required."));
            return issues;
        }

        if (string.IsNullOrWhiteSpace(order.OrderId))
        {
            issues.Add(Error("order.id.empty", "Order identifier is required."));
        }

        if (string.IsNullOrWhiteSpace(order.TenantId))
        {
            issues.Add(Error("order.tenant.empty", "Order tenant is required."));
        }

        if (string.IsNullOrWhiteSpace(order.ActorId))
        {
            issues.Add(Error("order.actor.empty", "Order actor is required."));
        }

        var current = Options;
        var lines = order.Lines;

        if (lines is null || lines.Count == 0)
        {
            issues.Add(Error("order.lines.empty", "An order requires at least one line."));
        }
        else
        {
            if (current.MaximumLineCount > 0 && lines.Count > current.MaximumLineCount)
            {
                issues.Add(Error("order.lines.max", $"Order has {lines.Count} lines which exceeds maximum {current.MaximumLineCount}."));
            }

            foreach (var line in lines)
            {
                if (line is null)
                {
                    issues.Add(Error("order.line.required", "Order lines must not be null."));
                    continue;
                }

                if (line.Quantity <= 0)
                {
                    issues.Add(Error("order.line.quantity", $"Line '{line.Sku}' quantity {line.Quantity} must be positive."));
                }
                else if (current.MaximumQuantity > 0 && line.Quantity > current.MaximumQuantity)
                {
                    issues.Add(Error("order.line.quantity.max", $"Line '{line.Sku}' quantity {line.Quantity} exceeds maximum {current.MaximumQuantity}."));
                }
            }

            var total = order.MerchandiseTotal();
            if (current.MaximumOrderTotalMinor > 0 && total > current.MaximumOrderTotalMinor)
            {
                issues.Add(Error("order.total.max", $"Order total {total} exceeds maximum {current.MaximumOrderTotalMinor}."));
            }
        }

        if (string.IsNullOrWhiteSpace(order.Currency))
        {
            issues.Add(Error("order.currency.empty", "Order currency is required."));
        }
        else if (current.SupportedCurrencies.Count > 0 && !ContainsCurrency(current.SupportedCurrencies, order.Currency))
        {
            issues.Add(Error("order.currency.unsupported", $"Currency '{order.Currency}' is not supported."));
        }

        return issues;
    }

    private static bool ContainsCurrency(IReadOnlySet<string> supported, string currency)
    {
        foreach (var candidate in supported)
        {
            if (string.Equals(candidate, currency, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class PriceCalculationPolicy
{
    private const long EmployeeDiscountPercent = 20;
    private const long VipDiscountPercent = 10;
    private const long PremiumDiscountPercent = 5;

    public PriceBreakdown Calculate(OrderRequest order, CustomerAccount? customer = null)
    {
        ArgumentNullException.ThrowIfNull(order);

        var merchandise = order.Lines is null ? 0 : order.MerchandiseTotal();
        long discount = 0;

        if (customer is not null)
        {
            if (HasSegment(customer, "employee"))
            {
                discount = merchandise * EmployeeDiscountPercent / 100;
            }
            else if (HasSegment(customer, "vip"))
            {
                discount = merchandise * VipDiscountPercent / 100;
            }
            else if (HasSegment(customer, "premium"))
            {
                discount = merchandise * PremiumDiscountPercent / 100;
            }
        }

        return new PriceBreakdown(
            merchandise,
            discount,
            0,
            0,
            string.IsNullOrWhiteSpace(order.Currency) ? string.Empty : order.Currency);
    }

    private static bool HasSegment(CustomerAccount customer, string segment)
    {
        foreach (var candidate in customer.Segments)
        {
            if (string.Equals(candidate, segment, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }
}

public sealed class PaymentRequirementPolicy
{
    private const long HighValueThresholdMinor = 100_000;

    public PaymentRequirement Determine(PriceBreakdown price, CustomerAccount? customer)
    {
        if (price is null)
        {
            return PaymentRequirement.None;
        }

        var total = price.GrandTotalMinor;
        if (total <= 0)
        {
            return PaymentRequirement.None;
        }

        var trusted = customer is not null && (HasSegment(customer, "vip") || HasSegment(customer, "premium"));
        return total >= HighValueThresholdMinor && !trusted
            ? PaymentRequirement.PreAuthorization
            : PaymentRequirement.CaptureOnCommit;
    }

    private static bool HasSegment(CustomerAccount customer, string segment)
    {
        foreach (var candidate in customer.Segments)
        {
            if (string.Equals(candidate, segment, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }
}

public sealed class InventoryPolicy
{
    public PolicyResult Evaluate(OrderRequest order, InventoryReservation? reservation)
    {
        if (order is null)
        {
            return PolicyResult.Deny(Error("inventory.order.required", "An order is required."));
        }

        if (reservation is null)
        {
            return PolicyResult.Deny(Error(
                "inventory.reservation.required",
                $"Order '{order.OrderId}' requires an inventory reservation."));
        }

        if (!string.Equals(reservation.TenantId, order.TenantId, StringComparison.Ordinal))
        {
            return PolicyResult.Deny(Error(
                "inventory.tenant",
                $"Reservation '{reservation.ReservationId}' belongs to tenant '{reservation.TenantId}' and not to '{order.TenantId}'."));
        }

        if (!string.Equals(reservation.OrderId, order.OrderId, StringComparison.Ordinal))
        {
            return PolicyResult.Deny(Error(
                "inventory.order.mismatch",
                $"Reservation '{reservation.ReservationId}' belongs to order '{reservation.OrderId}' and not to '{order.OrderId}'."));
        }

        if (reservation.Released)
        {
            return PolicyResult.Deny(Error(
                "inventory.released",
                $"Reservation '{reservation.ReservationId}' has been released."));
        }

        if (reservation.IsExpired(DateTimeOffset.UtcNow))
        {
            return PolicyResult.Deny(Error(
                "inventory.expired",
                $"Reservation '{reservation.ReservationId}' has expired."));
        }

        var lines = order.Lines ?? Array.Empty<OrderLine>();
        if (!reservation.ContainsAll(lines))
        {
            return PolicyResult.Deny(Error(
                "inventory.insufficient",
                $"Reservation '{reservation.ReservationId}' does not cover all order lines."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class OrderStateMachine
{
    private static readonly IReadOnlyDictionary<OrderLifecycleState, IReadOnlySet<OrderLifecycleState>> Transitions =
        new Dictionary<OrderLifecycleState, IReadOnlySet<OrderLifecycleState>>
        {
            [OrderLifecycleState.Draft] = Set(OrderLifecycleState.Validating, OrderLifecycleState.Rejected),
            [OrderLifecycleState.Validating] = Set(
                OrderLifecycleState.AwaitingInventory,
                OrderLifecycleState.Reserved,
                OrderLifecycleState.Rejected,
                OrderLifecycleState.RollingBack),
            [OrderLifecycleState.AwaitingInventory] = Set(
                OrderLifecycleState.Reserved,
                OrderLifecycleState.Rejected,
                OrderLifecycleState.RollingBack),
            [OrderLifecycleState.Reserved] = Set(
                OrderLifecycleState.Committing,
                OrderLifecycleState.Rejected,
                OrderLifecycleState.RollingBack),
            [OrderLifecycleState.Committing] = Set(
                OrderLifecycleState.Accepted,
                OrderLifecycleState.RollingBack),
            [OrderLifecycleState.RollingBack] = Set(OrderLifecycleState.RolledBack),
        };

    public bool CanTransition(OrderLifecycleState from, OrderLifecycleState to)
    {
        if (from == to)
        {
            return true;
        }

        return Transitions.TryGetValue(from, out var targets) && targets.Contains(to);
    }

    public OrderLifecycleState Transition(OrderLifecycleState from, OrderLifecycleState to)
    {
        if (!CanTransition(from, to))
        {
            throw new InvalidOperationException($"Illegal order transition from '{from}' to '{to}'.");
        }

        return to;
    }

    private static IReadOnlySet<OrderLifecycleState> Set(params OrderLifecycleState[] states)
        => new HashSet<OrderLifecycleState>(states);
}

public sealed class PluginCapabilityPolicy
{
    public PolicyResult Evaluate(PluginDescriptor plugin, PluginInvocation invocation)
    {
        if (plugin is null)
        {
            return PolicyResult.Deny(Error("plugin.required", "A plugin descriptor is required."));
        }

        if (invocation is null)
        {
            return PolicyResult.Deny(Error("plugin.invocation.required", "A plugin invocation is required."));
        }

        if (!plugin.Enabled)
        {
            return PolicyResult.Deny(Error("plugin.disabled", $"Plugin '{plugin.PluginId}' is disabled."));
        }

        if (!string.Equals(plugin.TenantId, invocation.TenantId, StringComparison.Ordinal))
        {
            return PolicyResult.Deny(Error(
                "plugin.tenant",
                $"Plugin '{plugin.PluginId}' is not available to tenant '{invocation.TenantId}'."));
        }

        if (!plugin.Supports(invocation.Operation))
        {
            return PolicyResult.Deny(Error(
                "plugin.capability",
                $"Plugin '{plugin.PluginId}' does not support operation '{invocation.Operation}'."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class OrderIdempotencyPolicy
{
    public PolicyResult Evaluate(bool alreadyCompleted, string operationId)
    {
        if (!alreadyCompleted)
        {
            return PolicyResult.Allow();
        }

        return PolicyResult.Deny(new ValidationIssue(
            "order.duplicate",
            $"Operation '{operationId}' has already completed; the duplicate must not reserve inventory again.",
            ValidationSeverity.Info));
    }
}
