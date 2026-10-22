namespace AssetUpgradeGateway.Application;

using System.Diagnostics;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record WorkflowDeliveryCommand(string TenantId, string ActorId, AssetEvent Event, string CorrelationId);
public sealed record WorkflowDeliveryResult(bool Accepted, DeliveryStatus Status, WorkflowState State, int Attempts, IReadOnlyList<ValidationIssue> Issues);

public sealed class WorkflowDeliveryCoordinator
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IEventEnvelopeStore envelopes;
    private readonly IDispatchAttemptStore history;
    private readonly IDeadLetterSink deadLetters;
    private readonly IAuditSink audit;
    private readonly IMetricsSink metrics;
    private readonly IClock clock;
    private readonly IWorkflowStateMachine stateMachine;
    private readonly IRetryPolicy retryPolicy;
    private readonly DuplicateDeliveryPolicy duplicatePolicy = new();

    public WorkflowDeliveryCoordinator(ITenantAuthorizer authorizer, IWorkflowDispatcher dispatcher, IEventEnvelopeStore envelopes, IDispatchAttemptStore history, IDeadLetterSink deadLetters, IAuditSink audit, IMetricsSink metrics, IClock? clock = null, IWorkflowStateMachine? stateMachine = null, IRetryPolicy? retryPolicy = null)
    {
        this.authorizer = authorizer; this.dispatcher = dispatcher; this.envelopes = envelopes; this.history = history; this.deadLetters = deadLetters; this.audit = audit; this.metrics = metrics; this.clock = clock ?? new Adapters.SystemClock(); this.stateMachine = stateMachine ?? new WorkflowStateTransitionPolicy(); this.retryPolicy = retryPolicy ?? new ExponentialRetryPolicy();
    }
    public Task<WorkflowDeliveryResult> DeliverAsync(WorkflowDeliveryCommand command, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private static WorkflowDeliveryResult Deny(DeliveryStatus status, ValidationIssue issue) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class WorkflowDeliveryQuery
{
    private readonly IDispatchAttemptStore history;
    private readonly ITenantAuthorizer authorizer;
    public WorkflowDeliveryQuery(IDispatchAttemptStore history, ITenantAuthorizer authorizer) { this.history = history; this.authorizer = authorizer; }
    public Task<IReadOnlyList<DispatchAttempt>> GetAttemptsAsync(string tenantId, string actorId, string eventId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class WorkflowBatchDispatcher
{
    private readonly WorkflowDeliveryCoordinator coordinator;
    public WorkflowBatchDispatcher(WorkflowDeliveryCoordinator coordinator) => this.coordinator = coordinator;
    public Task<IReadOnlyList<WorkflowDeliveryResult>> DispatchAsync(string tenantId, string actorId, IReadOnlyList<AssetEvent> events, string correlationId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
