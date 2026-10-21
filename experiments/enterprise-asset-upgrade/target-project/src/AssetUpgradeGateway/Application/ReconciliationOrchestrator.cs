namespace AssetUpgradeGateway.Application;

using System.Globalization;
using System.Text;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Telemetry;

public sealed record ReconciliationCommand(string TenantId, string ActorId, DateTimeOffset Now, int Limit, string JobName);
public sealed record ReconciliationOutcome(ReconciliationReport Report, string? Checkpoint, IReadOnlyList<ValidationIssue> Issues);

public sealed class ReconciliationOrchestrator
{
    private static readonly ReconciliationReport EmptyReport = new(0, 0, 0, 0, Array.Empty<string>());

    private readonly ITenantAuthorizer authorizer;
    private readonly IRetryableEventStore store;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;
    private readonly ICheckpointStore checkpoints;
    private readonly ILeaseStore leases;
    private readonly IRetryPolicy retry;
    private readonly IMetricsSink metrics;
    private readonly TraceFactory? traces;

    public ReconciliationOrchestrator(ITenantAuthorizer authorizer, IRetryableEventStore store, IWorkflowDispatcher dispatcher, IIdempotencyStore idempotency, IAuditSink audit, ICheckpointStore checkpoints, ILeaseStore leases, IMetricsSink metrics, IRetryPolicy? retry = null, TraceFactory? traces = null)
    {
        this.authorizer = authorizer; this.store = store; this.dispatcher = dispatcher; this.idempotency = idempotency; this.audit = TelemetryHealthComposition.Decorate(audit, metrics); this.checkpoints = checkpoints; this.leases = leases; this.metrics = metrics; this.retry = retry ?? new ExponentialRetryPolicy(); this.traces = traces;
    }

    public async Task<ReconciliationOutcome> RunAsync(ReconciliationCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        using var scope = traces?.Start(command.JobName, "reconciliation.run", command.TenantId, command.ActorId);

        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
        {
            var unauthorized = new ValidationIssue(
                "reconciliation.unauthorized",
                $"Actor '{command.ActorId}' is not authorized for tenant '{command.TenantId}'.",
                ValidationSeverity.Error);
            Decorate(scope, "Rejected", true, "reconciliation.unauthorized");
            return new ReconciliationOutcome(EmptyReport, null, new[] { unauthorized });
        }

        var jobName = string.IsNullOrWhiteSpace(command.JobName) ? "reconciliation" : command.JobName;
        var claimed = await leases.TryClaimAsync(command.TenantId, jobName, TimeSpan.FromMinutes(5), cancellationToken).ConfigureAwait(false);
        if (!claimed)
        {
            var busy = new ValidationIssue(
                "reconciliation.busy",
                $"Reconciliation job '{jobName}' is already running for tenant '{command.TenantId}'.",
                ValidationSeverity.Error);
            Decorate(scope, "Busy", false);
            return new ReconciliationOutcome(EmptyReport, null, new[] { busy });
        }

        var runStatus = "Completed";
        try
        {
            var now = command.Now;
            var issues = new List<ValidationIssue>();
            var previousCheckpoint = await checkpoints.GetAsync(command.TenantId, jobName, cancellationToken).ConfigureAwait(false);
            var limit = command.Limit > 0 ? command.Limit : 100;

            var due = await store.FindDueAsync(now, limit, cancellationToken).ConfigureAwait(false);

            var batch = new TenantBatchPolicy().Evaluate(command.TenantId, due, limit);
            if (!batch.Allowed)
            {
                issues.AddRange(batch.Issues);
            }

            var scoped = due
                .Where(pending => pending?.Event is not null
                    && string.Equals(pending.Event.TenantId, command.TenantId, StringComparison.Ordinal))
                .ToArray();

            var examined = 0;
            var retried = 0;
            var succeeded = 0;
            var failed = 0;
            var processed = new List<string>();
            string? lastEventId = null;

            foreach (var pending in scoped)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var assetEvent = pending.Event;
                if (assetEvent is null || !pending.Retryable)
                {
                    continue;
                }

                examined++;
                var eventId = assetEvent.EventId;

                if (idempotency.HasCompleted(command.TenantId, eventId))
                {
                    // A previous run already completed this event: safe to skip.
                    lastEventId = eventId;
                    continue;
                }

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
                }

                processed.Add(eventId);
                lastEventId = eventId;

                if (delivery.Status == DeliveryStatus.Accepted)
                {
                    idempotency.MarkCompleted(command.TenantId, eventId);
                    succeeded++;
                    audit.Record(new AuditRecord(command.TenantId, eventId, "reconciliation.event", "Completed", now));
                    metrics.Increment("reconciliation.succeeded", command.TenantId);
                    continue;
                }

                var attempts = pending.Attempts + 1;
                if (retry.CanRetry(attempts))
                {
                    var next = retry.NextAttempt(now, attempts);
                    await store.MarkRetryableAsync(
                        pending with { Attempts = attempts, Retryable = true },
                        next,
                        cancellationToken).ConfigureAwait(false);
                    retried++;
                    audit.Record(new AuditRecord(command.TenantId, eventId, "reconciliation.event", "RetryPending", now));
                    metrics.Increment("reconciliation.retried", command.TenantId);
                }
                else
                {
                    await store.MarkRetryableAsync(
                        pending with { Attempts = attempts, Retryable = false },
                        now,
                        cancellationToken).ConfigureAwait(false);
                    failed++;
                    audit.Record(new AuditRecord(command.TenantId, eventId, "reconciliation.event", "Failed", now));
                    metrics.Increment("reconciliation.failed", command.TenantId);
                }
            }

            var report = new ReconciliationReport(examined, retried, succeeded, failed, processed);
            var cursor = new ReconciliationCursor(lastEventId ?? previousCheckpoint, now, examined);
            var checkpoint = Format(cursor);
            await checkpoints.PutAsync(command.TenantId, jobName, checkpoint, cancellationToken).ConfigureAwait(false);

            runStatus = issues.Any(issue => issue.BlocksOperation) ? "Rejected" : "Completed";

            return new ReconciliationOutcome(report, checkpoint, issues);
        }
        catch (Exception)
        {
            runStatus = "Failed";
            Decorate(scope, runStatus, true, "reconciliation.failed");
            throw;
        }
        finally
        {
            scope?.AddTag("status", runStatus);
            audit.Record(new AuditRecord(command.TenantId, jobName, "reconciliation.run", runStatus, command.Now));
            metrics.Increment("reconciliation.runs", command.TenantId);
            await leases.ReleaseAsync(command.TenantId, jobName, CancellationToken.None).ConfigureAwait(false);
        }
    }

    private static void Decorate(TraceScope? scope, string status, bool failed, string? reason = null)
    {
        scope?.AddTag("status", status);
        if (failed)
        {
            scope?.MarkFailed(reason);
        }
    }

    private static string Format(ReconciliationCursor cursor)
        => string.Join(
            '|',
            cursor.LastEventId ?? string.Empty,
            cursor.ObservedAt.ToString("O", CultureInfo.InvariantCulture),
            cursor.Processed.ToString(CultureInfo.InvariantCulture));
}

public sealed class ReconciliationReportFormatter
{
    public string ToText(ReconciliationOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);

        var report = outcome.Report;
        var builder = new StringBuilder();
        builder.Append("examined=").Append(report.Examined.ToString(CultureInfo.InvariantCulture));
        builder.Append("; retried=").Append(report.Retried.ToString(CultureInfo.InvariantCulture));
        builder.Append("; succeeded=").Append(report.Succeeded.ToString(CultureInfo.InvariantCulture));
        builder.Append("; failed=").Append(report.Failed.ToString(CultureInfo.InvariantCulture));

        if (report.EventIds is { Count: > 0 })
        {
            builder.Append("; events=").Append(string.Join(",", report.EventIds));
        }

        if (!string.IsNullOrEmpty(outcome.Checkpoint))
        {
            builder.Append("; checkpoint=").Append(outcome.Checkpoint);
        }

        if (outcome.Issues is { Count: > 0 })
        {
            builder.Append("; issues=").Append(string.Join(",", outcome.Issues.Select(issue => issue.Code)));
        }

        return builder.ToString();
    }
}

public sealed class DueWindowCalculator
{
    public BatchWindow Compute(DateTimeOffset now, TimeSpan lookback, TimeSpan lookahead, int limit)
        => new(now - lookback, now + lookahead, limit);

    public bool Contains(BatchWindow window, DateTimeOffset value)
        => value >= window.From && value <= window.To;
}
