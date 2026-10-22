namespace AssetUpgradeGateway;

// These contracts reserve the seams needed by a production-sized solution.
// They are intentionally infrastructure-neutral; the evaluated Agent decides
// whether to use an in-memory, database, broker, or hosted-service adapter.
public enum WorkflowState { New, Approved, Dispatched, RetryPending, Completed, Failed }

public enum AttachmentState { Received, Quarantined, Scanned, Released, Rejected }

public enum ValidationSeverity { Info, Warning, Error }

public sealed record ValidationIssue(string Code, string Message, ValidationSeverity Severity)
{
    public bool BlocksOperation => throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent.");
}

public sealed record PolicyResult(
    bool Allowed,
    IReadOnlyList<ValidationIssue> Issues)
{
    public static PolicyResult Allow() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public static PolicyResult Deny(params ValidationIssue[] issues) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record OperationContext(
    string TenantId,
    string ActorId,
    string Operation,
    string CorrelationId,
    IReadOnlyDictionary<string, string>? Attributes = null);

public sealed record AttachmentScanResult(
    string AttachmentId,
    bool Clean,
    string Scanner,
    DateTimeOffset ScannedAt,
    string? Detail = null);

public sealed record DispatchAttempt(
    string TenantId,
    string EventId,
    int Attempt,
    DateTimeOffset StartedAt,
    DateTimeOffset FinishedAt,
    DeliveryStatus Status,
    string? Detail = null);

public sealed record DeadLetterEvent(
    AssetEvent Event,
    int Attempts,
    string Reason,
    DateTimeOffset RecordedAt);

public sealed record MetricSnapshot(
    string TenantId,
    IReadOnlyDictionary<string, long> Counters,
    IReadOnlyDictionary<string, TimeSpan> Timings);

public sealed record BatchWindow(DateTimeOffset From, DateTimeOffset To, int Limit);

public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public interface IAttachmentRepository
{
    Task<AttachmentInput?> FindAsync(string tenantId, string attachmentId, CancellationToken cancellationToken);
    Task SaveAsync(AttachmentInput attachment, CancellationToken cancellationToken);
    Task ReleaseAsync(string tenantId, string attachmentId, CancellationToken cancellationToken);
}

public interface IAttachmentScanner
{
    Task<AttachmentScanResult> ScanAsync(AttachmentInput attachment, CancellationToken cancellationToken);
}

public interface IDeadLetterSink
{
    Task PublishAsync(DeadLetterEvent deadLetter, CancellationToken cancellationToken);
    Task<IReadOnlyList<DeadLetterEvent>> FindByTenantAsync(string tenantId, CancellationToken cancellationToken);
}

public interface IMetricsSink
{
    void Increment(string name, string tenantId);
    void Timing(string name, string tenantId, TimeSpan duration);
    MetricSnapshot Snapshot(string tenantId);
}

public interface IFeatureFlags
{
    bool Enabled(string tenantId, string flag);
}

public interface ITransactionBoundary
{
    Task<T> ExecuteAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken cancellationToken);
}

public interface IDispatchHistory
{
    Task AppendAsync(DispatchAttempt attempt, CancellationToken cancellationToken);
    Task<IReadOnlyList<DispatchAttempt>> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken);
}

public interface IOrderRepository
{
    Task<OrderRequest?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken);
    Task SaveAsync(OrderRequest order, CancellationToken cancellationToken);
    Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken);
}

public interface IPolicyDecision
{
    Task<IReadOnlyList<ValidationIssue>> EvaluateAsync(
        OperationContext context,
        string subjectId,
        CancellationToken cancellationToken);
}

public interface IWorkflowStateMachine
{
    bool CanTransition(WorkflowState from, WorkflowState to);
    WorkflowState Transition(WorkflowState from, WorkflowState to);
}

public interface IRetryPolicy
{
    bool CanRetry(int attempts);
    DateTimeOffset NextAttempt(DateTimeOffset now, int attempts);
}
