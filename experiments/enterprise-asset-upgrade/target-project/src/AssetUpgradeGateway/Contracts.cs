namespace AssetUpgradeGateway;

public enum DeliveryStatus { Accepted, Rejected, Retryable, Duplicate, Quarantined }

public enum OrderStatus { Accepted, Rejected, RolledBack }

public sealed record AssetEvent(
    string EventId,
    string TenantId,
    string AssetId,
    string EventType,
    DateTimeOffset CreatedAt,
    string? AttachmentId = null)
{
    // Kept as an init property so existing six-argument fixtures remain valid.
    public WorkflowState State { get; init; }
}

public sealed record AttachmentInput(
    string AttachmentId,
    string TenantId,
    string FileName,
    string DeclaredContentType,
    ReadOnlyMemory<byte> Content,
    bool Scanned);

public sealed record DeliveryResult(bool Accepted, DeliveryStatus Status, string? Detail = null);

public sealed record PendingEvent(
    AssetEvent Event,
    DateTimeOffset RetryAfter,
    int Attempts,
    bool Retryable);

public sealed record ReconciliationReport(
    int Examined,
    int Retried,
    int Succeeded,
    int Failed,
    IReadOnlyList<string> EventIds);

public sealed record OrderRequest(
    string OrderId,
    string TenantId,
    string ActorId,
    IReadOnlyList<OrderLine> Lines,
    string Currency);

public sealed record OrderLine(string Sku, int Quantity, long UnitPriceMinor);

public sealed record ReservationResult(bool Reserved, string? ReservationId, string? Detail = null);

public sealed record OrderResult(
    bool Accepted,
    OrderStatus Status,
    string? ReservationId = null,
    string? Detail = null);

public sealed record AuditRecord(
    string TenantId,
    string SubjectId,
    string Action,
    string Status,
    DateTimeOffset At);
