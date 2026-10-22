namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public interface IValidationRule<in T>
{
    ValidationIssue? Validate(T value);
}

public sealed class ValidationPipeline<T>
{
    private readonly IReadOnlyList<IValidationRule<T>> rules;
    public ValidationPipeline(IEnumerable<IValidationRule<T>> rules) => this.rules = rules?.ToArray() ?? Array.Empty<IValidationRule<T>>();

    public PolicyResult Evaluate(T value)
    {
        var issues = new List<ValidationIssue>();
        foreach (var rule in rules)
        {
            if (rule is null)
            {
                continue;
            }

            var issue = rule.Validate(value);
            if (issue is not null)
            {
                issues.Add(issue);
            }
        }

        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    public IReadOnlyList<string> RuleNames() => rules.Select(rule => rule.GetType().Name).ToArray();
}

public sealed class RequiredAssetIdRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value)
        => value is null || string.IsNullOrWhiteSpace(value.AssetId)
            ? Error("event.asset.required", "An asset identifier is required.")
            : null;

    internal static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class RequiredEventTypeRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value)
        => value is null || string.IsNullOrWhiteSpace(value.EventType)
            ? RequiredAssetIdRule.Error("event.type.required", "An event type is required.")
            : null;
}

public sealed class EventTenantRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value)
        => value is null || string.IsNullOrWhiteSpace(value.TenantId)
            ? RequiredAssetIdRule.Error("event.tenant.required", "An event tenant is required.")
            : null;
}

public sealed class OrderCurrencyRule : IValidationRule<OrderRequest>
{
    private readonly IReadOnlySet<string>? supported;
    public OrderCurrencyRule(IEnumerable<string>? supported = null) => this.supported = supported is null ? null : new HashSet<string>(supported, StringComparer.OrdinalIgnoreCase);

    public ValidationIssue? Validate(OrderRequest value)
    {
        if (value is null || string.IsNullOrWhiteSpace(value.Currency))
        {
            return RequiredAssetIdRule.Error("order.currency.empty", "An order currency is required.");
        }

        var allowed = supported;
        if (allowed is null || allowed.Count == 0)
        {
            return null;
        }

        foreach (var candidate in allowed)
        {
            if (string.Equals(candidate, value.Currency, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
        }

        return RequiredAssetIdRule.Error(
            "order.currency.unsupported",
            $"Currency '{value.Currency}' is not supported.");
    }
}

public sealed class OrderLineCountRule : IValidationRule<OrderRequest>
{
    private readonly int maximum;
    public OrderLineCountRule(int maximum = 0) => this.maximum = maximum;

    public ValidationIssue? Validate(OrderRequest value)
    {
        var lines = value?.Lines;
        if (lines is null || lines.Count == 0)
        {
            return RequiredAssetIdRule.Error("order.lines.empty", "An order requires at least one line.");
        }

        if (maximum > 0 && lines.Count > maximum)
        {
            return RequiredAssetIdRule.Error(
                "order.lines.max",
                $"Order has {lines.Count} lines which exceeds the maximum of {maximum}.");
        }

        return null;
    }
}

public sealed class AttachmentTenantRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value)
        => value is null || string.IsNullOrWhiteSpace(value.TenantId)
            ? RequiredAssetIdRule.Error("attachment.tenant.required", "An attachment tenant is required.")
            : null;
}

public sealed class AttachmentScanRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value)
        => value is null || !value.Scanned
            ? RequiredAssetIdRule.Error(
                "attachment.scan.required",
                $"Attachment '{value?.AttachmentId}' has not passed scanning and must remain quarantined.")
            : null;
}

public sealed class ValidationIssueCatalog
{
    private static readonly IReadOnlyDictionary<string, string> Table = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["event.asset.required"] = "An asset identifier is required.",
        ["event.type.required"] = "An event type is required.",
        ["event.tenant.required"] = "An event tenant is required.",
        ["order.currency.empty"] = "An order currency is required.",
        ["order.currency.unsupported"] = "The order currency is not supported.",
        ["order.lines.empty"] = "An order requires at least one line.",
        ["order.lines.max"] = "The order exceeds the maximum number of lines.",
        ["attachment.tenant.required"] = "An attachment tenant is required.",
        ["attachment.scan.required"] = "The attachment has not passed scanning and remains quarantined.",
        ["attachment.tenant.mismatch"] = "The attachment belongs to a different tenant.",
        ["attachment.required"] = "An attachment is required.",
        ["attachment.unauthorized"] = "The actor is not authorized for the attachment tenant.",
        ["attachment.scan.failed"] = "The attachment scan did not report a clean payload.",
        ["order.invalid"] = "The order request is invalid.",
        ["order.duplicate"] = "The order operation already completed.",
        ["inventory.unavailable"] = "Inventory could not be reserved for the order.",
        ["inventory.commit.failed"] = "The order commit failed and was rolled back.",
        ["workflow.unauthorized"] = "The actor is not authorized for the workflow tenant.",
        ["workflow.tenant.mismatch"] = "The event tenant does not match the command tenant.",
        ["delivery.duplicate"] = "The event already has an accepted delivery attempt.",
        ["reconciliation.busy"] = "The reconciliation lease is already held.",
        ["reconciliation.unauthorized"] = "The actor is not authorized for the reconciliation tenant.",
        ["plugin.required"] = "A plugin descriptor is required.",
        ["plugin.tenant"] = "The plugin belongs to a different tenant.",
        ["plugin.capabilities.empty"] = "A plugin must declare at least one capability.",
        ["plugin.unauthorized"] = "The actor is not authorized for the plugin tenant.",
        ["plugin.not_found"] = "The plugin could not be found.",
    };

    private readonly IReadOnlyDictionary<string, string> descriptions = Table;

    public string Describe(string code)
        => code is not null && descriptions.TryGetValue(code, out var description) ? description : code ?? string.Empty;

    public bool Contains(string code) => code is not null && descriptions.ContainsKey(code);

    public IReadOnlyCollection<string> Codes => descriptions.Keys.ToArray();
}
