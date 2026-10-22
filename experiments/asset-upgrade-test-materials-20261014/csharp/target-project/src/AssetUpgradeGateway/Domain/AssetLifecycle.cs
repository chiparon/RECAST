namespace AssetUpgradeGateway.Domain;

using AssetUpgradeGateway;

/// <summary>
/// Domain vocabulary reconstructed from the file-upload, identity and workflow
/// assets. The target uses its own names so an implementation must translate
/// concepts instead of copying an upstream API.
/// </summary>
public enum AssetKind
{
    Document,
    Image,
    Archive,
    DataExport,
    PluginPackage,
}

public enum AttachmentInspectionState
{
    Received,
    Quarantined,
    Scanning,
    Clean,
    Rejected,
    Released,
}

public enum EventProcessingStage
{
    Created,
    Authorized,
    Validated,
    Enqueued,
    Delivered,
    RetryScheduled,
    DeadLettered,
    Completed,
}

public sealed record AssetDescriptor
{
    public AssetDescriptor(string assetId, string tenantId, AssetKind kind, string externalKey)
        : this(assetId, tenantId, kind, externalKey, new Dictionary<string, string>()) { }
    public AssetDescriptor(string assetId, string tenantId, AssetKind kind, string externalKey, IReadOnlyDictionary<string, string>? tags)
    {
        AssetId = assetId; TenantId = tenantId; Kind = kind; ExternalKey = externalKey;
        Tags = tags ?? new Dictionary<string, string>();
    }
    public string AssetId { get; init; }
    public string TenantId { get; init; }
    public AssetKind Kind { get; init; }
    public string ExternalKey { get; init; }
    public IReadOnlyDictionary<string, string> Tags { get; init; }

    public bool HasTag(string key) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public AssetDescriptor WithTag(string key, string value)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record AttachmentMetadata(
    string AttachmentId,
    string TenantId,
    string FileName,
    string DeclaredContentType,
    long Length,
    string? ContentHash,
    AttachmentInspectionState InspectionState,
    DateTimeOffset ReceivedAt,
    DateTimeOffset? ScannedAt,
    string? RejectionReason)
{
    public bool IsTerminal => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public bool IsUsable => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public AttachmentMetadata Quarantine() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public AttachmentMetadata BeginScan(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public AttachmentMetadata MarkClean(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public AttachmentMetadata Reject(string reason) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public AttachmentMetadata Release() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record ContentSignature(
    string MediaType,
    IReadOnlyList<byte> Prefix,
    IReadOnlyList<string> AllowedExtensions,
    bool IsText)
{
    public bool Matches(ReadOnlySpan<byte> content)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record TenantScope(
    string TenantId,
    string ActorId,
    IReadOnlySet<string> Roles,
    IReadOnlySet<string> Permissions,
    DateTimeOffset ExpiresAt)
{
    public bool IsExpired(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool HasRole(string role) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool Can(string permission) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public TenantScope RequireTenant(string tenantId)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AssetAggregate
{
    private readonly List<AttachmentMetadata> attachments = [];
    private readonly List<AssetEvent> events = [];

    public AssetAggregate(AssetDescriptor descriptor)
    {
        Descriptor = descriptor;
    }
    public AssetDescriptor Descriptor { get; private set; }

    public IReadOnlyList<AttachmentMetadata> Attachments => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public IReadOnlyList<AssetEvent> Events => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");

    public void AddAttachment(AttachmentMetadata attachment)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public void RecordEvent(AssetEvent assetEvent)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public void RenameExternalKey(string externalKey)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record EventEnvelope(
    AssetEvent Event,
    string CorrelationId,
    string CausationId,
    int DeliveryAttempt,
    EventProcessingStage Stage,
    DateTimeOffset EnqueuedAt,
    DateTimeOffset? DeliveredAt,
    IReadOnlyDictionary<string, string> Headers)
{
    public EventEnvelope(AssetEvent assetEvent, string correlationId)
        : this(assetEvent, correlationId, string.Empty, 0, default, default, null, new Dictionary<string, string>())
    {
        throw new NotImplementedException("Implementation belongs to the evaluated Agent.");
    }
    public EventEnvelope NextAttempt(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public EventEnvelope MarkDelivered(DateTimeOffset now) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public EventEnvelope WithHeader(string name, string value)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record AssetPage<T>(
    IReadOnlyList<T> Items,
    string? ContinuationToken,
    int TotalCount,
    bool HasMore)
{
    public static AssetPage<T> Empty => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");
}
