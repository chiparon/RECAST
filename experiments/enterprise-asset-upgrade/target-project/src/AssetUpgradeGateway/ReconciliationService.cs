namespace AssetUpgradeGateway;

using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Policies;

/// <summary>
/// Public gateway entry point for scheduled retry reconciliation. Only events
/// that are still retryable are considered, the caller actor must be authorized
/// for the owning tenant of each event, and every run emits a traceable audit
/// record so a failed run can be retried safely.
/// </summary>
public sealed class ReconciliationService
{
    private const string RunAction = "reconciliation.run";
    private const string EventAction = "reconciliation.event";
    private const string RunSubject = "reconciliation";

    private readonly ITenantAuthorizer authorizer;
    private readonly IRetryableEventStore eventStore;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;
    private readonly IRetryPolicy retry;

    public ReconciliationService(
        ITenantAuthorizer authorizer,
        IRetryableEventStore eventStore,
        IWorkflowDispatcher dispatcher,
        IIdempotencyStore idempotency,
        IAuditSink audit)
    {
        this.authorizer = authorizer;
        this.eventStore = eventStore;
        this.dispatcher = dispatcher;
        this.idempotency = idempotency;
        this.audit = audit;
        this.retry = new ExponentialRetryPolicy();
    }

    public async Task<ReconciliationReport> RunAsync(
        string actorId,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default)
    {
        var examined = 0;
        var retried = 0;
        var succeeded = 0;
        var failed = 0;
        var processed = new List<string>();
        var denied = 0;
        string? runTenant = null;
        var runStatus = "Completed";

        try
        {
            var due = await eventStore.FindDueAsync(now, limit, cancellationToken).ConfigureAwait(false)
                ?? Array.Empty<PendingEvent>();

            foreach (var pending in due)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var assetEvent = pending?.Event;
                if (assetEvent is null || !pending!.Retryable)
                {
                    continue;
                }

                // Tenant isolation: only an actor that can access the owning tenant
                // may drive (or even observe) the event.
                if (!authorizer.CanAccess(assetEvent.TenantId, actorId))
                {
                    denied++;
                    continue;
                }

                runTenant ??= assetEvent.TenantId;
                examined++;
                var eventId = assetEvent.EventId;

                // Serialize the per-event check-perform-mark critical section so
                // overlapping reconciliation runs cannot dispatch the same event twice.
                using var gate = await OperationSerialization.AcquireAsync(assetEvent.TenantId, "reconciliation:" + eventId, cancellationToken).ConfigureAwait(false);

                if (idempotency.HasCompleted(assetEvent.TenantId, eventId))
                {
                    // A previous run already completed this event: safe to skip.
                    processed.Add(eventId);
                    continue;
                }

                DeliveryResult delivery;
                try
                {
                    delivery = await dispatcher.DispatchAsync(assetEvent, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    delivery = new DeliveryResult(false, DeliveryStatus.Retryable, exception.Message);
                }

                processed.Add(eventId);

                if (delivery.Status == DeliveryStatus.Accepted)
                {
                    // The required audit runs before the completion marker: if the audit
                    // write fails the event stays retryable and no completion is recorded,
                    // so the reconciliation can be retried safely.
                    audit.Record(new AuditRecord(assetEvent.TenantId, eventId, EventAction, "Completed", now));
                    idempotency.MarkCompleted(assetEvent.TenantId, eventId);
                    succeeded++;
                    continue;
                }

                var attempts = pending.Attempts + 1;
                if (retry.CanRetry(attempts))
                {
                    var next = retry.NextAttempt(now, attempts);
                    await eventStore.MarkRetryableAsync(
                        pending with { Attempts = attempts, Retryable = true },
                        next,
                        cancellationToken).ConfigureAwait(false);
                    retried++;
                    audit.Record(new AuditRecord(assetEvent.TenantId, eventId, EventAction, "RetryPending", now));
                }
                else
                {
                    await eventStore.MarkRetryableAsync(
                        pending with { Attempts = attempts, Retryable = false },
                        now,
                        cancellationToken).ConfigureAwait(false);
                    failed++;
                    audit.Record(new AuditRecord(assetEvent.TenantId, eventId, EventAction, "Failed", now));
                }
            }

            runStatus = examined == 0 && denied > 0 ? "Unauthorized" : "Completed";
            return new ReconciliationReport(examined, retried, succeeded, failed, processed);
        }
        catch (Exception)
        {
            runStatus = "Failed";
            throw;
        }
        finally
        {
            // Every run is traceable, even when nothing was eligible, the actor was
            // unauthorized, or the run failed part way through.
            audit.Record(new AuditRecord(runTenant ?? string.Empty, RunSubject, RunAction, runStatus, now));
        }
    }
}
