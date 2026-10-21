namespace AssetUpgradeGateway;

public interface ITenantAuthorizer
{
    bool CanAccess(string tenantId, string actorId);
}

public interface IAttachmentQuarantine
{
    bool IsSafe(AttachmentInput attachment);
}

public interface IWorkflowDispatcher
{
    Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken);
}

public interface IIdempotencyStore
{
    bool HasCompleted(string tenantId, string operationId);
    void MarkCompleted(string tenantId, string operationId);
}

public interface IAuditSink
{
    void Record(AuditRecord record);
}

public interface IRetryableEventStore
{
    Task<IReadOnlyList<PendingEvent>> FindDueAsync(
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken);

    Task MarkRetryableAsync(
        PendingEvent pending,
        DateTimeOffset retryAfter,
        CancellationToken cancellationToken);
}

public interface IOrderValidator
{
    bool IsValid(OrderRequest order, out string? reason);
}

public interface IInventoryGateway
{
    Task<ReservationResult> ReserveAsync(
        OrderRequest order,
        CancellationToken cancellationToken);
}

/// The implementation owns the database transaction. The Agent must call this
/// only after validation and reservation have succeeded.
public interface IOrderCommitter
{
    Task CommitAsync(
        OrderRequest order,
        ReservationResult reservation,
        CancellationToken cancellationToken);
}
