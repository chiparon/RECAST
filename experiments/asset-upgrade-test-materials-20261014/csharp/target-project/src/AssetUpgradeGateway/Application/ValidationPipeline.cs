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
    public ValidationPipeline(IEnumerable<IValidationRule<T>> rules) => this.rules = rules.ToArray();
    public PolicyResult Evaluate(T value)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public IReadOnlyList<string> RuleNames() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class RequiredAssetIdRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class RequiredEventTypeRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class EventTenantRule : IValidationRule<AssetEvent>
{
    public ValidationIssue? Validate(AssetEvent value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class OrderCurrencyRule : IValidationRule<OrderRequest>
{
    private readonly IReadOnlySet<string>? supported;
    public OrderCurrencyRule(IEnumerable<string>? supported = null) => this.supported = supported is null ? null : new HashSet<string>(supported, StringComparer.OrdinalIgnoreCase);
    public ValidationIssue? Validate(OrderRequest value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class OrderLineCountRule : IValidationRule<OrderRequest>
{
    private readonly int maximum;
    public OrderLineCountRule(int maximum = 0) => this.maximum = maximum;
    public ValidationIssue? Validate(OrderRequest value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AttachmentTenantRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AttachmentScanRule : IValidationRule<AttachmentInput>
{
    public ValidationIssue? Validate(AttachmentInput value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class ValidationIssueCatalog
{
    private readonly IReadOnlyDictionary<string, string> descriptions = new Dictionary<string, string>();
    public string Describe(string code) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool Contains(string code) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public IReadOnlyCollection<string> Codes => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");
}
