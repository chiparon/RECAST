namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed record QuotaSnapshot(string TenantId, long BytesUsed, int AttachmentsUsed, int EventsUsed, DateTimeOffset WindowStarted);

public sealed class TenantQuotaPolicy
{
    private readonly long byteLimit;
    private readonly int attachmentLimit;
    private readonly int eventLimit;
    public TenantQuotaPolicy(long byteLimit = 0, int attachmentLimit = 0, int eventLimit = 0) { this.byteLimit = byteLimit; this.attachmentLimit = attachmentLimit; this.eventLimit = eventLimit; }
    public PolicyResult Evaluate(QuotaSnapshot usage, AttachmentInput? attachment, bool eventCreated)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool IsWithin(QuotaSnapshot usage) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class ActorPermissionPolicy
{
    public PolicyResult Evaluate(TenantScope scope, string operation)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class ResourceOwnershipPolicy
{
    public PolicyResult Evaluate(string tenantId, string resourceTenantId, string resourceId)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class EventAgePolicy
{
    private readonly TimeSpan? maximumAge;
    public EventAgePolicy(TimeSpan? maximumAge = null) => this.maximumAge = maximumAge;
    public PolicyResult Evaluate(AssetEvent assetEvent, DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class BatchSizePolicy
{
    public PolicyResult Evaluate<T>(IReadOnlyCollection<T> items, int maximum, string code)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class HeaderPolicy
{
    private readonly IReadOnlySet<string>? allowed;
    public HeaderPolicy(IEnumerable<string>? allowed = null) => this.allowed = allowed is null ? null : new HashSet<string>(allowed, StringComparer.OrdinalIgnoreCase);
    public PolicyResult Evaluate(IReadOnlyDictionary<string, string> headers)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
