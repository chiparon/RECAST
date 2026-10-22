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

    public bool HasTag(string key) => Tags.ContainsKey(key);
    public AssetDescriptor WithTag(string key, string value)
    {
        var merged = new Dictionary<string, string>(Tags, StringComparer.Ordinal)
        {
            [key] = value,
        };
        return new AssetDescriptor(AssetId, TenantId, Kind, ExternalKey, merged);
    }
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
    public bool IsTerminal
        => InspectionState is AttachmentInspectionState.Rejected or AttachmentInspectionState.Released;

    public bool IsUsable
        => InspectionState is AttachmentInspectionState.Clean or AttachmentInspectionState.Released;

    public AttachmentMetadata Quarantine()
        => IsTerminal
            ? this
            : this with { InspectionState = AttachmentInspectionState.Quarantined };

    public AttachmentMetadata BeginScan(DateTimeOffset now)
        => IsTerminal || InspectionState == AttachmentInspectionState.Scanning
            ? this
            : this with { InspectionState = AttachmentInspectionState.Scanning };

    public AttachmentMetadata MarkClean(DateTimeOffset now)
        => IsTerminal
            ? this
            : this with
            {
                InspectionState = AttachmentInspectionState.Clean,
                ScannedAt = now,
                RejectionReason = null,
            };

    public AttachmentMetadata Reject(string reason)
        => IsTerminal
            ? this
            : this with
            {
                InspectionState = AttachmentInspectionState.Rejected,
                RejectionReason = reason,
            };

    public AttachmentMetadata Release()
        => InspectionState == AttachmentInspectionState.Clean
            ? this with { InspectionState = AttachmentInspectionState.Released }
            : this;
}

public sealed record ContentSignature(
    string MediaType,
    IReadOnlyList<byte> Prefix,
    IReadOnlyList<string> AllowedExtensions,
    bool IsText)
{
    public bool Matches(ReadOnlySpan<byte> content)
    {
        if (Prefix.Count == 0)
        {
            return true;
        }

        if (content.Length < Prefix.Count)
        {
            return false;
        }

        for (var index = 0; index < Prefix.Count; index++)
        {
            if (content[index] != Prefix[index])
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Extension allow-list check. An empty allow list accepts any extension so
    /// callers can opt into per-media-type restrictions without breaking the
    /// default signature.
    /// </summary>
    public bool AllowsExtension(string? fileName)
    {
        if (AllowedExtensions.Count == 0)
        {
            return true;
        }

        var extension = GetExtension(fileName).TrimStart('.');
        if (extension.Length == 0)
        {
            return false;
        }

        foreach (var allowed in AllowedExtensions)
        {
            var normalized = (allowed ?? string.Empty).TrimStart('.');
            if (normalized.Length > 0
                && string.Equals(normalized, extension, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Combines the extension allow-list with the byte-prefix signature so an
    /// unsafe file name or mismatched payload keeps the attachment quarantined.
    /// </summary>
    public bool Matches(string? fileName, ReadOnlySpan<byte> content)
        => AllowsExtension(fileName) && Matches(content);

    private static string GetExtension(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return string.Empty;
        }

        return Path.GetExtension(fileName) ?? string.Empty;
    }
}

public sealed record TenantScope(
    string TenantId,
    string ActorId,
    IReadOnlySet<string> Roles,
    IReadOnlySet<string> Permissions,
    DateTimeOffset ExpiresAt)
{
    public bool IsExpired(DateTimeOffset now) => now >= ExpiresAt;
    public bool HasRole(string role) => Roles.Contains(role);
    public bool Can(string permission) => Permissions.Contains(permission);
    public TenantScope RequireTenant(string tenantId)
    {
        if (!string.Equals(TenantId, tenantId, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException(
                $"Tenant scope for '{TenantId}' cannot be used for tenant '{tenantId}'.");
        }

        return this;
    }

    public TenantScope RequireTenant(string tenantId, DateTimeOffset now)
    {
        if (IsExpired(now))
        {
            throw new UnauthorizedAccessException(
                $"Tenant scope for '{TenantId}' expired at {ExpiresAt:O}.");
        }

        return RequireTenant(tenantId);
    }
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

    public IReadOnlyList<AttachmentMetadata> Attachments => attachments;

    public IReadOnlyList<AssetEvent> Events => events;

    /// <summary>
    /// Idempotent by <see cref="AttachmentMetadata.AttachmentId"/>: repeated
    /// submission of the same attachment refreshes the existing entry in place
    /// instead of appending a duplicate row, so intake stays auditable.
    /// </summary>
    public void AddAttachment(AttachmentMetadata attachment)
    {
        ArgumentNullException.ThrowIfNull(attachment);

        var index = attachments.FindIndex(
            existing => string.Equals(existing.AttachmentId, attachment.AttachmentId, StringComparison.Ordinal));

        if (index >= 0)
        {
            attachments[index] = attachment;
        }
        else
        {
            attachments.Add(attachment);
        }
    }

    /// <summary>
    /// Idempotent by <see cref="AssetEvent.EventId"/>: a replayed event updates
    /// the recorded event in place so the same logical event is never recorded
    /// twice.
    /// </summary>
    public void RecordEvent(AssetEvent assetEvent)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);

        var index = events.FindIndex(
            existing => string.Equals(existing.EventId, assetEvent.EventId, StringComparison.Ordinal));

        if (index >= 0)
        {
            events[index] = assetEvent;
        }
        else
        {
            events.Add(assetEvent);
        }
    }

    /// <summary>
    /// Advances the matching recorded event to <see cref="WorkflowState.Completed"/>
    /// exactly once. Events that are unknown or already terminal are left
    /// untouched so a successful retry cannot advance the workflow twice.
    /// </summary>
    public void MarkDelivered(string eventId, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(eventId))
        {
            return;
        }

        var index = events.FindIndex(
            existing => string.Equals(existing.EventId, eventId, StringComparison.Ordinal));

        if (index < 0)
        {
            return;
        }

        var current = events[index];
        if (current.State.IsTerminal())
        {
            return;
        }

        events[index] = current.WithState(WorkflowState.Completed);
    }

    public void RenameExternalKey(string externalKey)
    {
        Descriptor = new AssetDescriptor(
            Descriptor.AssetId,
            Descriptor.TenantId,
            Descriptor.Kind,
            externalKey,
            Descriptor.Tags);
    }
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
    }
    public EventEnvelope NextAttempt(DateTimeOffset now)
        => Stage.IsTerminal()
            ? this
            : this with
            {
                DeliveryAttempt = DeliveryAttempt + 1,
                Stage = EventProcessingStage.RetryScheduled,
            };
    public EventEnvelope MarkDelivered(DateTimeOffset now)
        => Stage.IsTerminal()
            ? this
            : this with
            {
                Stage = EventProcessingStage.Delivered,
                DeliveredAt = now,
            };
    public EventEnvelope WithHeader(string name, string value)
    {
        var merged = new Dictionary<string, string>(Headers, StringComparer.Ordinal)
        {
            [name] = value,
        };
        return this with { Headers = merged };
    }
}

public sealed record AssetPage<T>(
    IReadOnlyList<T> Items,
    string? ContinuationToken,
    int TotalCount,
    bool HasMore)
{
    public static AssetPage<T> Empty => new(Array.Empty<T>(), null, 0, false);
}
