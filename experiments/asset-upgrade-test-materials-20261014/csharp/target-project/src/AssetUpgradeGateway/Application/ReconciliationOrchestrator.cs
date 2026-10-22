namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record ReconciliationCommand(string TenantId, string ActorId, DateTimeOffset Now, int Limit, string JobName);
public sealed record ReconciliationOutcome(ReconciliationReport Report, string? Checkpoint, IReadOnlyList<ValidationIssue> Issues);

public sealed class ReconciliationOrchestrator
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IRetryableEventStore store;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;
    private readonly ICheckpointStore checkpoints;
    private readonly ILeaseStore leases;
    private readonly IRetryPolicy retry;
    private readonly IMetricsSink metrics;

    public ReconciliationOrchestrator(ITenantAuthorizer authorizer, IRetryableEventStore store, IWorkflowDispatcher dispatcher, IIdempotencyStore idempotency, IAuditSink audit, ICheckpointStore checkpoints, ILeaseStore leases, IMetricsSink metrics, IRetryPolicy? retry = null)
    {
        this.authorizer = authorizer; this.store = store; this.dispatcher = dispatcher; this.idempotency = idempotency; this.audit = audit; this.checkpoints = checkpoints; this.leases = leases; this.metrics = metrics; this.retry = retry ?? new ExponentialRetryPolicy();
    }
    public Task<ReconciliationOutcome> RunAsync(ReconciliationCommand command, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class ReconciliationReportFormatter
{
    public string ToText(ReconciliationOutcome outcome)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class DueWindowCalculator
{
    public BatchWindow Compute(DateTimeOffset now, TimeSpan lookback, TimeSpan lookahead, int limit)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public bool Contains(BatchWindow window, DateTimeOffset value) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
