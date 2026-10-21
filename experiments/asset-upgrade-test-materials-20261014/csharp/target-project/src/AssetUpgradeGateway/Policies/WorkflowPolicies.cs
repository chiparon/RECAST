namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed class WorkflowStateTransitionPolicy : IWorkflowStateMachine
{
    public bool CanTransition(WorkflowState from, WorkflowState to) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public WorkflowState Transition(WorkflowState from, WorkflowState to)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public IReadOnlyList<WorkflowState> ReachableFrom(WorkflowState from) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed record RetryPolicyOptions(int MaximumAttempts, TimeSpan InitialDelay, TimeSpan MaximumDelay, double Multiplier, bool AddJitter);

public sealed class ExponentialRetryPolicy : IRetryPolicy
{
    private readonly RetryPolicyOptions? options;
    public ExponentialRetryPolicy(RetryPolicyOptions? options = null) => this.options = options;
    public bool CanRetry(int attempts) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public DateTimeOffset NextAttempt(DateTimeOffset now, int attempts)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class EventEnvelopePolicy
{
    private readonly IWorkflowStateMachine? machine;
    public EventEnvelopePolicy(IWorkflowStateMachine? machine = null) => this.machine = machine;

    public PolicyResult Validate(AssetEvent assetEvent, EventEnvelope envelope)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class DuplicateDeliveryPolicy
{
    public PolicyResult Evaluate(IReadOnlyList<DispatchAttempt> attempts, AssetEvent assetEvent)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class RetryBudgetPolicy
{
    private readonly IRetryPolicy? retry;
    public RetryBudgetPolicy(IRetryPolicy? retry = null) => this.retry = retry;
    public PolicyResult Evaluate(int attempts, DateTimeOffset now)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public DateTimeOffset Schedule(DateTimeOffset now, int attempts) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class TenantBatchPolicy
{
    public PolicyResult Evaluate(string tenantId, IReadOnlyList<PendingEvent> events, int limit)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class CorrelationPolicy
{
    public PolicyResult Evaluate(EventEnvelope envelope)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
