namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed class WorkflowStateTransitionPolicy : IWorkflowStateMachine
{
    private static readonly IReadOnlyDictionary<WorkflowState, IReadOnlySet<WorkflowState>> Transitions =
        new Dictionary<WorkflowState, IReadOnlySet<WorkflowState>>
        {
            [WorkflowState.New] = Set(WorkflowState.Approved, WorkflowState.Failed),
            [WorkflowState.Approved] = Set(WorkflowState.Dispatched, WorkflowState.Failed),
            [WorkflowState.Dispatched] = Set(
                WorkflowState.Completed,
                WorkflowState.RetryPending,
                WorkflowState.Failed),
            [WorkflowState.RetryPending] = Set(WorkflowState.Dispatched, WorkflowState.Failed),
        };

    public bool CanTransition(WorkflowState from, WorkflowState to)
    {
        if (from == to)
        {
            return true;
        }

        return Transitions.TryGetValue(from, out var targets) && targets.Contains(to);
    }

    public WorkflowState Transition(WorkflowState from, WorkflowState to)
    {
        if (!CanTransition(from, to))
        {
            throw new InvalidOperationException($"Illegal workflow transition from '{from}' to '{to}'.");
        }

        return to;
    }

    public IReadOnlyList<WorkflowState> ReachableFrom(WorkflowState from)
        => Transitions.TryGetValue(from, out var targets)
            ? targets.OrderBy(state => (int)state).ToArray()
            : Array.Empty<WorkflowState>();

    private static IReadOnlySet<WorkflowState> Set(params WorkflowState[] states)
        => new HashSet<WorkflowState>(states);
}

public sealed record RetryPolicyOptions(int MaximumAttempts, TimeSpan InitialDelay, TimeSpan MaximumDelay, double Multiplier, bool AddJitter);

public sealed class ExponentialRetryPolicy : IRetryPolicy
{
    private static readonly RetryPolicyOptions Fallback = new(
        5,
        TimeSpan.FromSeconds(1),
        TimeSpan.FromMinutes(1),
        2.0,
        false);

    private readonly RetryPolicyOptions? options;
    public ExponentialRetryPolicy(RetryPolicyOptions? options = null) => this.options = options;

    private RetryPolicyOptions Options => options ?? Fallback;

    public bool CanRetry(int attempts) => attempts < Options.MaximumAttempts;

    public DateTimeOffset NextAttempt(DateTimeOffset now, int attempts)
    {
        var current = Options;
        var exponent = attempts < 0 ? 0 : attempts;
        var multiplier = current.Multiplier > 0 ? current.Multiplier : 1.0;

        var baseTicks = current.InitialDelay.Ticks;
        if (baseTicks < 0)
        {
            baseTicks = 0;
        }

        double delayTicks = baseTicks * Math.Pow(multiplier, exponent);
        if (double.IsNaN(delayTicks) || delayTicks < 0)
        {
            delayTicks = 0;
        }

        var maximumTicks = current.MaximumDelay.Ticks;
        if (maximumTicks > 0 && delayTicks > maximumTicks)
        {
            delayTicks = maximumTicks;
        }

        if (current.AddJitter)
        {
            var bucket = ((long)exponent * 1103515245 + 12345) & 0x7FFFFFFF;
            var fraction = (bucket % 1001) / 10000.0;
            delayTicks *= 1.0 + fraction;
            if (maximumTicks > 0 && delayTicks > maximumTicks)
            {
                delayTicks = maximumTicks;
            }
        }

        if (delayTicks >= long.MaxValue)
        {
            return DateTimeOffset.MaxValue;
        }

        return now.AddTicks((long)delayTicks);
    }
}

public sealed class EventEnvelopePolicy
{
    private readonly IWorkflowStateMachine? machine;
    public EventEnvelopePolicy(IWorkflowStateMachine? machine = null) => this.machine = machine;

    public PolicyResult Validate(AssetEvent assetEvent, EventEnvelope envelope)
    {
        if (assetEvent is null)
        {
            return PolicyResult.Deny(Error("envelope.event.required", "An asset event is required."));
        }

        if (envelope is null)
        {
            return PolicyResult.Deny(Error(
                "envelope.required",
                $"An envelope is required for event '{assetEvent.EventId}'."));
        }

        var issues = new List<ValidationIssue>();
        var resolvedState = envelope.Event?.State ?? assetEvent.State;

        if (envelope.Event is null)
        {
            issues.Add(Error(
                "envelope.event.missing",
                $"Envelope for event '{assetEvent.EventId}' has no event payload."));
        }
        else
        {
            if (!string.Equals(envelope.Event.EventId, assetEvent.EventId, StringComparison.Ordinal)
                || !string.Equals(envelope.Event.TenantId, assetEvent.TenantId, StringComparison.Ordinal))
            {
                issues.Add(Error(
                    "envelope.identity",
                    $"Envelope identity 'eventId={envelope.Event.EventId}; tenantId={envelope.Event.TenantId}' "
                    + $"does not match 'eventId={assetEvent.EventId}; tenantId={assetEvent.TenantId}'."));
            }

            if (assetEvent.State.IsTerminal())
            {
                issues.Add(Error(
                    "envelope.stage.terminal",
                    $"EventId={assetEvent.EventId}; State={assetEvent.State}; a terminal event cannot advance again."));
            }
            else if (machine is not null
                && envelope.Event.State != assetEvent.State
                && !machine.CanTransition(assetEvent.State, envelope.Event.State))
            {
                issues.Add(Error(
                    "envelope.stage.illegal",
                    $"EventId={assetEvent.EventId}; illegal stage transition from '{assetEvent.State}' to '{envelope.Event.State}'."));
            }
        }

        if (string.IsNullOrWhiteSpace(envelope.CorrelationId))
        {
            issues.Add(Error(
                "envelope.correlation",
                $"EventId={assetEvent.EventId}; State={resolvedState}; a CorrelationId is required."));
        }

        issues.Add(new ValidationIssue(
            "envelope.audit",
            $"EventId={assetEvent.EventId}; State={resolvedState}; CorrelationId={envelope.CorrelationId}",
            ValidationSeverity.Info));

        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class DuplicateDeliveryPolicy
{
    public PolicyResult Evaluate(IReadOnlyList<DispatchAttempt> attempts, AssetEvent assetEvent)
    {
        if (assetEvent is null)
        {
            return PolicyResult.Deny(Error("delivery.event.required", "An asset event is required."));
        }

        if (assetEvent.State.IsTerminal())
        {
            return PolicyResult.Deny(Error(
                "delivery.duplicate.terminal",
                $"Event '{assetEvent.EventId}' is already in terminal state '{assetEvent.State}'."));
        }

        if (attempts is not null)
        {
            foreach (var attempt in attempts)
            {
                if (attempt is not null
                    && string.Equals(attempt.TenantId, assetEvent.TenantId, StringComparison.Ordinal)
                    && string.Equals(attempt.EventId, assetEvent.EventId, StringComparison.Ordinal)
                    && attempt.Status == DeliveryStatus.Accepted)
                {
                    return PolicyResult.Deny(Error(
                        "delivery.duplicate",
                        $"Event '{assetEvent.EventId}' already has an accepted delivery attempt."));
                }
            }
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class RetryBudgetPolicy
{
    private static readonly IRetryPolicy Fallback = new ExponentialRetryPolicy();

    private readonly IRetryPolicy? retry;
    public RetryBudgetPolicy(IRetryPolicy? retry = null) => this.retry = retry;

    private IRetryPolicy Policy => retry ?? Fallback;

    public PolicyResult Evaluate(int attempts, DateTimeOffset now)
        => Policy.CanRetry(attempts)
            ? PolicyResult.Allow()
            : PolicyResult.Deny(new ValidationIssue(
                "retry.exhausted",
                $"Retry budget exhausted after {attempts} attempts at {now:O}.",
                ValidationSeverity.Error));

    public DateTimeOffset Schedule(DateTimeOffset now, int attempts) => Policy.NextAttempt(now, attempts);
}

public sealed class TenantBatchPolicy
{
    public PolicyResult Evaluate(string tenantId, IReadOnlyList<PendingEvent> events, int limit)
    {
        if (events is null)
        {
            return PolicyResult.Deny(Error("batch.events.required", "Pending events are required."));
        }

        var issues = new List<ValidationIssue>();

        if (events.Count > limit)
        {
            issues.Add(Error("batch.limit", $"Batch size {events.Count} exceeds limit {limit}."));
        }

        foreach (var pending in events)
        {
            if (pending?.Event is null)
            {
                issues.Add(Error("batch.event.required", "Pending events must carry an event."));
                continue;
            }

            if (!string.Equals(pending.Event.TenantId, tenantId, StringComparison.Ordinal))
            {
                issues.Add(Error(
                    "batch.tenant",
                    $"Event '{pending.Event.EventId}' belongs to tenant '{pending.Event.TenantId}' and not to '{tenantId}'."));
            }
        }

        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class CorrelationPolicy
{
    public PolicyResult Evaluate(EventEnvelope envelope)
    {
        if (envelope is null)
        {
            return PolicyResult.Deny(Error("correlation.envelope.required", "An event envelope is required."));
        }

        var issues = new List<ValidationIssue>();

        if (string.IsNullOrWhiteSpace(envelope.CorrelationId))
        {
            issues.Add(Error("correlation.id", $"Event '{envelope.Event?.EventId}' requires a correlation identifier."));
        }

        if (envelope.Event is null || string.IsNullOrWhiteSpace(envelope.Event.TenantId))
        {
            issues.Add(Error("correlation.tenant", "Event envelope requires a tenant identifier."));
        }

        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}
