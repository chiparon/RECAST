namespace AssetUpgradeGateway.Ports;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public interface IAttachmentPolicy
{
    PolicyResult Evaluate(AttachmentInput attachment);
}

public interface IAssetRepository
{
    Task<AssetAggregate?> FindAsync(string tenantId, string assetId, CancellationToken cancellationToken);
    Task SaveAsync(AssetAggregate asset, CancellationToken cancellationToken);
    Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string? continuationToken, int pageSize, CancellationToken cancellationToken);
}

public interface IEventEnvelopeStore
{
    Task<EventEnvelope?> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken);
    Task SaveAsync(EventEnvelope envelope, CancellationToken cancellationToken);
    Task<IReadOnlyList<EventEnvelope>> FindByStageAsync(string tenantId, EventProcessingStage stage, int limit, CancellationToken cancellationToken);
}

public interface IDispatchAttemptStore
{
    Task AppendAsync(DispatchAttempt attempt, CancellationToken cancellationToken);
    Task<IReadOnlyList<DispatchAttempt>> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken);
}

public interface IOrderAggregateRepository
{
    Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken);
    Task SaveAsync(OrderSnapshot snapshot, CancellationToken cancellationToken);
    Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken);
}

public interface IPluginRegistry
{
    Task RegisterAsync(PluginDescriptor descriptor, CancellationToken cancellationToken);
    Task<PluginDescriptor?> FindCapabilityAsync(string tenantId, string capability, CancellationToken cancellationToken);
    Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, CancellationToken cancellationToken);
}

public interface IReservationLedger
{
    Task<InventoryReservation?> FindAsync(string tenantId, string reservationId, CancellationToken cancellationToken);
    Task SaveAsync(InventoryReservation reservation, CancellationToken cancellationToken);
    Task ReleaseAsync(string tenantId, string reservationId, CancellationToken cancellationToken);
}

public interface IAuditQuery
{
    Task<IReadOnlyList<AuditRecord>> FindAsync(string tenantId, string? subjectId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);
}

public interface ILeaseStore
{
    Task<bool> TryClaimAsync(string tenantId, string key, TimeSpan duration, CancellationToken cancellationToken);
    Task ReleaseAsync(string tenantId, string key, CancellationToken cancellationToken);
}

public interface ICheckpointStore
{
    Task<string?> GetAsync(string tenantId, string jobName, CancellationToken cancellationToken);
    Task PutAsync(string tenantId, string jobName, string checkpoint, CancellationToken cancellationToken);
}

public interface IQuarantineLog
{
    Task RecordAsync(string tenantId, string attachmentId, IReadOnlyList<ValidationIssue> issues, CancellationToken cancellationToken);
    Task<IReadOnlyList<string>> FindAsync(string tenantId, CancellationToken cancellationToken);
}

public interface ICorrelationContext
{
    string CorrelationId { get; }
    string ActorId { get; }
    string TenantId { get; }
    ICorrelationContext Child(string operation);
}

public sealed record LeaseClaim(string TenantId, string Key, DateTimeOffset ExpiresAt, string Owner);

public sealed record ReconciliationCursor(string? LastEventId, DateTimeOffset ObservedAt, int Processed);

public sealed record QuarantineEntry(string TenantId, string AttachmentId, IReadOnlyList<ValidationIssue> Issues, DateTimeOffset RecordedAt);

public sealed record AuditQuery(string TenantId, string? SubjectId, DateTimeOffset From, DateTimeOffset To, int Limit);

public sealed record HealthCheckResult(string Component, bool Healthy, TimeSpan Duration, string? Detail = null);

public sealed record ServiceHealthReport(DateTimeOffset CheckedAt, IReadOnlyList<HealthCheckResult> Checks)
{
    public bool Healthy => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");
}

public sealed record DispatchBatch(string TenantId, IReadOnlyList<EventEnvelope> Events, string? ContinuationToken)
{
    public bool IsEmpty => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");
}

public sealed record OrderCommand(string TenantId, string ActorId, string OrderId, string CommandId, string Operation);

public sealed record OrderCommitReceipt(string OrderId, string ReservationId, string CommitId, DateTimeOffset CommittedAt);
