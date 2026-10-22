namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Telemetry;
using System.Globalization;

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
    private readonly TraceFactory? traces;
    private readonly DuplicateDeliveryPolicy duplicatePolicy = new();

    public WorkflowDeliveryCoordinator(ITenantAuthorizer authorizer, IWorkflowDispatcher dispatcher, IEventEnvelopeStore envelopes, IDispatchAttemptStore history, IDeadLetterSink deadLetters, IAuditSink audit, IMetricsSink metrics, IClock? clock = null, IWorkflowStateMachine? stateMachine = null, IRetryPolicy? retryPolicy = null, TraceFactory? traces = null)
    {
        this.authorizer = authorizer; this.dispatcher = dispatcher; this.envelopes = envelopes; this.history = history; this.deadLetters = deadLetters; this.audit = TelemetryHealthComposition.Decorate(audit, metrics); this.metrics = metrics; this.clock = clock ?? new Adapters.SystemClock(); this.stateMachine = stateMachine ?? new WorkflowStateTransitionPolicy(); this.retryPolicy = retryPolicy ?? new ExponentialRetryPolicy(); this.traces = traces;
    }

    public async Task<WorkflowDeliveryResult> DeliverAsync(WorkflowDeliveryCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        using var scope = traces?.Start(command.CorrelationId, "workflow.delivery", command.TenantId, command.ActorId);
        var assetEvent = command.Event;
        if (assetEvent is null)
        {
            Decorate(scope, DeliveryStatus.Rejected.ToString(), true, "workflow.event.required");
            return Deny(
                DeliveryStatus.Rejected,
                new ValidationIssue("workflow.event.required", "An asset event is required.", ValidationSeverity.Error));
        }

        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
        {
            Decorate(scope, DeliveryStatus.Rejected.ToString(), true, "workflow.unauthorized");
            return Deny(
                DeliveryStatus.Rejected,
                new ValidationIssue(
                    "workflow.unauthorized",
                    $"Actor '{command.ActorId}' is not authorized for tenant '{command.TenantId}'.",
                    ValidationSeverity.Error));
        }

        if (!string.Equals(assetEvent.TenantId, command.TenantId, StringComparison.Ordinal))
        {
            Decorate(scope, DeliveryStatus.Rejected.ToString(), true, "workflow.tenant.mismatch");
            return Deny(
                DeliveryStatus.Rejected,
                new ValidationIssue(
                    "workflow.tenant.mismatch",
                    $"Event '{assetEvent.EventId}' belongs to tenant '{assetEvent.TenantId}' and not to '{command.TenantId}'.",
                    ValidationSeverity.Error));
        }

        var eventId = assetEvent.EventId;
        scope?.AddTag("eventId", eventId);

        // Serialize per-event delivery so two concurrent callers cannot both
        // observe "no accepted attempt" and dispatch the same event twice.
        using var gate = await OperationSerialization.AcquireAsync(command.TenantId, "workflow-delivery:" + eventId, cancellationToken).ConfigureAwait(false);

        var attempts = await history.FindAsync(command.TenantId, eventId, cancellationToken).ConfigureAwait(false);

        var duplicate = duplicatePolicy.Evaluate(attempts, assetEvent);
        if (!duplicate.Allowed)
        {
            audit.Record(new AuditRecord(command.TenantId, eventId, "workflow.delivery", DeliveryStatus.Duplicate.ToString(), clock.UtcNow));
            metrics.Increment("workflow.delivery.duplicate", command.TenantId);
            scope?.AddTag("attempts", attempts.Count.ToString(CultureInfo.InvariantCulture));
            Decorate(scope, DeliveryStatus.Duplicate.ToString(), false);
            return new WorkflowDeliveryResult(false, DeliveryStatus.Duplicate, assetEvent.State, attempts.Count, duplicate.Issues);
        }

        var envelope = await envelopes.FindAsync(command.TenantId, eventId, cancellationToken).ConfigureAwait(false)
            ?? new EventEnvelope(assetEvent, command.CorrelationId) { Stage = EventProcessingStage.Enqueued };

        if (!string.IsNullOrEmpty(command.CorrelationId))
        {
            envelope = envelope with { CorrelationId = command.CorrelationId };
        }

        // A stored envelope that already reached a terminal stage (delivered or
        // dead-lettered) is a completed operation: a replay must be a duplicate or
        // no-op and must never repeat the dispatch side effect.
        if (envelope.Stage.IsTerminal())
        {
            audit.Record(new AuditRecord(command.TenantId, eventId, "workflow.delivery", DeliveryStatus.Duplicate.ToString(), clock.UtcNow));
            metrics.Increment("workflow.delivery.duplicate", command.TenantId);
            scope?.AddTag("attempts", attempts.Count.ToString(CultureInfo.InvariantCulture));
            Decorate(scope, DeliveryStatus.Duplicate.ToString(), false);
            return new WorkflowDeliveryResult(false, DeliveryStatus.Duplicate, envelope.Event?.State ?? assetEvent.State, attempts.Count, Array.Empty<ValidationIssue>());
        }

        var attemptNumber = attempts.Count + 1;
        scope?.AddTag("attempt", attemptNumber.ToString(CultureInfo.InvariantCulture));
        scope?.AddTag("from", assetEvent.State.ToString());
        var startedAt = clock.UtcNow;
        DeliveryResult delivery;
        try
        {
            delivery = await dispatcher.DispatchAsync(assetEvent, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            delivery = new DeliveryResult(false, DeliveryStatus.Retryable, exception.Message);
            scope?.AddTag("dispatch.error", exception.Message);
        }

        var finishedAt = clock.UtcNow;
        await history.AppendAsync(
            new DispatchAttempt(command.TenantId, eventId, attemptNumber, startedAt, finishedAt, delivery.Status, delivery.Detail),
            cancellationToken).ConfigureAwait(false);

        if (delivery.Status == DeliveryStatus.Accepted)
        {
            var finalState = Advance(assetEvent.State, WorkflowState.Completed);
            var delivered = assetEvent.WithState(finalState);

            envelope = envelope with
            {
                Event = delivered,
                Stage = EventProcessingStage.Delivered,
                DeliveryAttempt = attemptNumber,
                DeliveredAt = finishedAt,
            };
            await envelopes.SaveAsync(envelope, cancellationToken).ConfigureAwait(false);

            audit.Record(new AuditRecord(command.TenantId, eventId, "workflow.delivery", finalState.ToString(), finishedAt));
            metrics.Increment("workflow.delivery.accepted", command.TenantId);

            scope?.AddTag("to", finalState.ToString());
            Decorate(scope, DeliveryStatus.Accepted.ToString(), false);
            return new WorkflowDeliveryResult(true, DeliveryStatus.Accepted, finalState, attemptNumber, Array.Empty<ValidationIssue>());
        }

        WorkflowState retryState;
        if (retryPolicy.CanRetry(attemptNumber))
        {
            retryState = Advance(assetEvent.State, WorkflowState.RetryPending);
            envelope = envelope with
            {
                Event = assetEvent.WithState(retryState),
                Stage = EventProcessingStage.RetryScheduled,
                DeliveryAttempt = attemptNumber,
            };
            await envelopes.SaveAsync(envelope, cancellationToken).ConfigureAwait(false);

            audit.Record(new AuditRecord(command.TenantId, eventId, "workflow.delivery", retryState.ToString(), finishedAt));
            metrics.Increment("workflow.delivery.retry", command.TenantId);

            scope?.AddTag("to", retryState.ToString());
            Decorate(scope, DeliveryStatus.Retryable.ToString(), true, delivery.Detail);
        }
        else
        {
            retryState = Advance(assetEvent.State, WorkflowState.Failed);
            envelope = envelope with
            {
                Event = assetEvent.WithState(retryState),
                Stage = EventProcessingStage.DeadLettered,
                DeliveryAttempt = attemptNumber,
            };
            await envelopes.SaveAsync(envelope, cancellationToken).ConfigureAwait(false);

            await deadLetters.PublishAsync(
                new DeadLetterEvent(assetEvent, attemptNumber, delivery.Detail ?? "retry budget exhausted", finishedAt),
                cancellationToken).ConfigureAwait(false);

            audit.Record(new AuditRecord(command.TenantId, eventId, "workflow.delivery", retryState.ToString(), finishedAt));
            metrics.Increment("workflow.delivery.dead_letter", command.TenantId);

            scope?.AddTag("to", retryState.ToString());
            Decorate(scope, DeliveryStatus.Retryable.ToString(), true, delivery.Detail);
        }

        return new WorkflowDeliveryResult(false, DeliveryStatus.Retryable, retryState, attemptNumber, Array.Empty<ValidationIssue>());
    }

    /// <summary>
    /// Walks the canonical workflow chain (Approved -> Dispatched -> target) so a
    /// single accepted delivery always lands on the requested terminal state and
    /// a later replay is caught by the duplicate policy instead of advancing twice.
    /// </summary>
    private WorkflowState Advance(WorkflowState current, WorkflowState target)
    {
        if (current.IsTerminal())
        {
            return current;
        }

        var chain = new[] { WorkflowState.Approved, WorkflowState.Dispatched, target };
        var state = current;
        foreach (var step in chain)
        {
            if (state == step)
            {
                continue;
            }

            if (stateMachine.CanTransition(state, step))
            {
                state = stateMachine.Transition(state, step);
            }
        }

        return state;
    }

    private static WorkflowDeliveryResult Deny(DeliveryStatus status, ValidationIssue issue)
        => new(false, status, WorkflowState.New, 0, new[] { issue });

    private static void Decorate(TraceScope? scope, string status, bool failed, string? reason = null)
    {
        scope?.AddTag("status", status);
        if (failed)
        {
            scope?.MarkFailed(reason);
        }
    }
}

public sealed class WorkflowDeliveryQuery
{
    private readonly IDispatchAttemptStore history;
    private readonly ITenantAuthorizer authorizer;
    public WorkflowDeliveryQuery(IDispatchAttemptStore history, ITenantAuthorizer authorizer) { this.history = history; this.authorizer = authorizer; }

    public async Task<IReadOnlyList<DispatchAttempt>> GetAttemptsAsync(string tenantId, string actorId, string eventId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return Array.Empty<DispatchAttempt>();
        }

        return await history.FindAsync(tenantId, eventId, cancellationToken).ConfigureAwait(false);
    }
}

public sealed class WorkflowBatchDispatcher
{
    private readonly WorkflowDeliveryCoordinator coordinator;
    public WorkflowBatchDispatcher(WorkflowDeliveryCoordinator coordinator) => this.coordinator = coordinator;

    public async Task<IReadOnlyList<WorkflowDeliveryResult>> DispatchAsync(string tenantId, string actorId, IReadOnlyList<AssetEvent> events, string correlationId, CancellationToken cancellationToken = default)
    {
        var results = new List<WorkflowDeliveryResult>();
        foreach (var assetEvent in events ?? Array.Empty<AssetEvent>())
        {
            if (assetEvent is null)
            {
                continue;
            }

            results.Add(await coordinator.DeliverAsync(
                new WorkflowDeliveryCommand(tenantId, actorId, assetEvent, correlationId),
                cancellationToken).ConfigureAwait(false));
        }

        return results;
    }
}
