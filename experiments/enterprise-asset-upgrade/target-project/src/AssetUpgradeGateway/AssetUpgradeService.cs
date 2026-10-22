namespace AssetUpgradeGateway;

using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Domain;

/// <summary>
/// Public gateway entry point for attachment quarantine plus approved workflow
/// dispatch. The façade is expressed entirely in terms of the infrastructure
/// neutral ports so the underlying identity, storage, queue and scanner
/// technology can be swapped without touching this class.
/// </summary>
public sealed class AssetUpgradeService
{
    private const string ActionName = "asset.upgrade";
    private const string RunUnspecified = "workflow";

    private static readonly RequestNormalizer Normalizer = new();
    private static readonly RequestFingerprint Fingerprints = new();

    private readonly ITenantAuthorizer authorizer;
    private readonly IAttachmentQuarantine quarantine;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;

    public AssetUpgradeService(
        ITenantAuthorizer authorizer,
        IAttachmentQuarantine quarantine,
        IWorkflowDispatcher dispatcher,
        IIdempotencyStore idempotency,
        IAuditSink audit)
    {
        this.authorizer = authorizer;
        this.quarantine = quarantine;
        this.dispatcher = dispatcher;
        this.idempotency = idempotency;
        this.audit = audit;
    }

    public async Task<DeliveryResult> SubmitAsync(
        string actorId,
        AssetEvent assetEvent,
        AttachmentInput? attachment,
        CancellationToken cancellationToken = default)
    {
        if (assetEvent is null)
        {
            return new DeliveryResult(false, DeliveryStatus.Rejected, "An asset event is required.");
        }

        var normalizedEvent = Normalizer.Normalize(assetEvent);
        var tenantId = normalizedEvent.TenantId;

        if (!authorizer.CanAccess(tenantId, actorId))
        {
            Record(tenantId, normalizedEvent.EventId, DeliveryStatus.Rejected);
            return new DeliveryResult(
                false,
                DeliveryStatus.Rejected,
                $"Actor '{actorId}' is not authorized for tenant '{tenantId}'.");
        }

        AttachmentInput? normalizedAttachment = null;
        if (attachment is not null)
        {
            normalizedAttachment = Normalizer.Normalize(attachment);

            if (!string.Equals(normalizedAttachment.TenantId, tenantId, StringComparison.Ordinal))
            {
                Record(tenantId, normalizedEvent.EventId, DeliveryStatus.Rejected);
                return new DeliveryResult(
                    false,
                    DeliveryStatus.Rejected,
                    $"Attachment '{normalizedAttachment.AttachmentId}' belongs to tenant '{normalizedAttachment.TenantId}' and not to '{tenantId}'.");
            }

            // An attachment that has not passed scanning (or that was explicitly
            // rejected by the quarantine) never reaches the approval workflow.
            if (!normalizedAttachment.Scanned || !quarantine.IsSafe(normalizedAttachment))
            {
                Record(tenantId, normalizedEvent.EventId, DeliveryStatus.Quarantined);
                return new DeliveryResult(
                    false,
                    DeliveryStatus.Quarantined,
                    $"Attachment '{normalizedAttachment.AttachmentId}' has not passed scanning and remains quarantined.");
            }
        }

        var operationId = normalizedAttachment is not null
            ? normalizedAttachment.StableFingerprint()
            : Fingerprints.ForEvent(normalizedEvent);

        // Serialize the check-perform-mark critical section so two concurrent
        // submissions of the same event cannot dispatch the transport twice.
        using var gate = await OperationSerialization.AcquireAsync(tenantId, "asset-upgrade:" + operationId, cancellationToken).ConfigureAwait(false);

        if (idempotency.HasCompleted(tenantId, operationId))
        {
            Record(tenantId, normalizedEvent.EventId, DeliveryStatus.Duplicate);
            return new DeliveryResult(
                false,
                DeliveryStatus.Duplicate,
                $"Event '{normalizedEvent.EventId}' has already been delivered; the operation is idempotent.");
        }

        var approved = normalizedEvent.WithState(WorkflowState.Approved);

        DeliveryResult delivery;
        try
        {
            delivery = await dispatcher.DispatchAsync(approved, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            delivery = new DeliveryResult(false, DeliveryStatus.Retryable, exception.Message);
        }

        if (delivery.Status == DeliveryStatus.Accepted)
        {
            // The completion marker is part of the success boundary: the required
            // audit must be durable before the operation is marked complete. If the
            // audit write fails the event stays retryable and no success is reported.
            try
            {
                Record(tenantId, approved.EventId, DeliveryStatus.Accepted);
            }
            catch (Exception exception)
            {
                return new DeliveryResult(false, DeliveryStatus.Retryable, exception.Message);
            }

            idempotency.MarkCompleted(tenantId, operationId);
            return new DeliveryResult(true, DeliveryStatus.Accepted, delivery.Detail);
        }

        // Any non-accepted dispatch leaves the event retryable so a later attempt
        // (scheduled or manual) can complete it exactly once.
        Record(tenantId, approved.EventId, DeliveryStatus.Retryable);
        return new DeliveryResult(
            false,
            DeliveryStatus.Retryable,
            delivery.Detail ?? $"The {RunUnspecified} transport did not accept event '{approved.EventId}'; it remains retryable.");
    }

    private void Record(string tenantId, string subjectId, DeliveryStatus status)
        => audit.Record(new AuditRecord(tenantId, subjectId, ActionName, status.ToString(), DateTimeOffset.UtcNow));
}
