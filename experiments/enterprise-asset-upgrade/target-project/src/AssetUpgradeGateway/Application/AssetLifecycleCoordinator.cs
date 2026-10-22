namespace AssetUpgradeGateway.Application;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Telemetry;

public sealed record AssetSubmissionCommand(string TenantId, string ActorId, AssetDescriptor Descriptor, AttachmentInput? Attachment, string EventType, string CorrelationId);
public sealed record AssetSubmissionResult(bool Accepted, DeliveryResult Delivery, AttachmentState? AttachmentState, IReadOnlyList<ValidationIssue> Issues);

public sealed class AssetLifecycleCoordinator
{
    private readonly AttachmentIntakeService attachments;
    private readonly WorkflowDeliveryCoordinator workflow;
    private readonly IAssetRepository assets;
    private readonly IAuditSink audit;
    private readonly IClock clock;
    private readonly TraceFactory? traces;

    public AssetLifecycleCoordinator(AttachmentIntakeService attachments, WorkflowDeliveryCoordinator workflow, IAssetRepository assets, IAuditSink audit, IClock? clock = null, TraceFactory? traces = null)
    {
        this.attachments = attachments; this.workflow = workflow; this.assets = assets; this.audit = audit; this.clock = clock ?? new Adapters.SystemClock(); this.traces = traces;
    }

    public async Task<AssetSubmissionResult> SubmitAsync(AssetSubmissionCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        var now = clock.UtcNow;
        using var scope = traces?.Start(command.CorrelationId, "asset.submit", command.TenantId, command.ActorId);
        var correlation = new CorrelationContext(command.TenantId, command.ActorId, command.CorrelationId);

        if (command.Descriptor is null)
        {
            var missing = new ValidationIssue("asset.descriptor.required", "An asset descriptor is required.", ValidationSeverity.Error);
            scope?.AddTag("state", DeliveryStatus.Rejected.ToString());
            return new AssetSubmissionResult(false, new DeliveryResult(false, DeliveryStatus.Rejected, missing.Message), null, new[] { missing });
        }

        if (!string.Equals(command.Descriptor.TenantId, command.TenantId, StringComparison.Ordinal))
        {
            var mismatch = new ValidationIssue(
                "asset.tenant.mismatch",
                $"Asset '{command.Descriptor.AssetId}' belongs to tenant '{command.Descriptor.TenantId}' and not to '{command.TenantId}'.",
                ValidationSeverity.Error);
            audit.Record(new AuditRecord(command.TenantId, command.Descriptor.AssetId, "asset.submit", "Rejected", now));
            scope?.AddTag("state", DeliveryStatus.Rejected.ToString());
            return new AssetSubmissionResult(false, new DeliveryResult(false, DeliveryStatus.Rejected, mismatch.Message), null, new[] { mismatch });
        }

        AttachmentState? attachmentState = null;
        if (command.Attachment is not null)
        {
            var intakeCorrelation = correlation.Child("attachment.intake").CorrelationId;
            var intake = await attachments.IntakeAsync(
                new AttachmentIntakeCommand(command.TenantId, command.ActorId, command.Attachment, intakeCorrelation),
                cancellationToken).ConfigureAwait(false);

            attachmentState = intake.State;
            scope?.AddTag("attachmentState", intake.State.ToString());
            if (!intake.Accepted || intake.State != AttachmentState.Scanned)
            {
                audit.Record(new AuditRecord(command.TenantId, command.Descriptor.AssetId, "asset.submit", intake.State.ToString(), clock.UtcNow));
                scope?.AddTag("state", intake.State.ToString());
                return new AssetSubmissionResult(
                    false,
                    new DeliveryResult(false, DeliveryStatus.Quarantined, "The attachment is not clean; delivery is refused."),
                    intake.State,
                    intake.Issues);
            }
        }

        var factory = new AssetEventFactory(clock);
        var assetEvent = factory.Create(command.Descriptor, command.EventType, command.Attachment?.AttachmentId);

        var aggregate = await assets.FindAsync(command.TenantId, command.Descriptor.AssetId, cancellationToken).ConfigureAwait(false)
            ?? new AssetAggregate(command.Descriptor);

        if (command.Attachment is not null && attachmentState == AttachmentState.Scanned)
        {
            aggregate.AddAttachment(ToMetadata(command.Attachment, now));
        }

        aggregate.RecordEvent(assetEvent);
        await assets.SaveAsync(aggregate, cancellationToken).ConfigureAwait(false);

        var deliveryCorrelation = correlation.Child("workflow.delivery").CorrelationId;
        var delivery = await workflow.DeliverAsync(
            new WorkflowDeliveryCommand(command.TenantId, command.ActorId, assetEvent, deliveryCorrelation),
            cancellationToken).ConfigureAwait(false);

        if (delivery.Status != DeliveryStatus.Duplicate)
        {
            // A duplicate replay must not clobber the state already recorded by the
            // successful delivery.
            aggregate.RecordEvent(assetEvent.WithState(delivery.State));
            await assets.SaveAsync(aggregate, cancellationToken).ConfigureAwait(false);
        }

        audit.Record(new AuditRecord(command.TenantId, assetEvent.EventId, "asset.submit", delivery.State.ToString(), clock.UtcNow));

        var deliveryResult = new DeliveryResult(
            delivery.Accepted,
            delivery.Status,
            delivery.Issues.Count > 0 ? delivery.Issues[0].Message : null);

        scope?.AddTag("deliveryStatus", delivery.Status.ToString());
        scope?.AddTag("state", delivery.State.ToString());
        return new AssetSubmissionResult(delivery.Accepted, deliveryResult, attachmentState, delivery.Issues);
    }

    private static AttachmentMetadata ToMetadata(AttachmentInput attachment, DateTimeOffset now)
        => new(
            attachment.AttachmentId,
            attachment.TenantId,
            attachment.FileName,
            attachment.DeclaredContentType,
            attachment.Content.Length,
            null,
            AttachmentInspectionState.Clean,
            now,
            now,
            null);
}

public sealed class AssetSearchService
{
    private readonly IAssetRepository assets;
    private readonly ITenantAuthorizer authorizer;
    public AssetSearchService(IAssetRepository assets, ITenantAuthorizer authorizer) { this.assets = assets; this.authorizer = authorizer; }

    public async Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string actorId, string? token, int pageSize, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return AssetPage<AssetAggregate>.Empty;
        }

        return await assets.SearchAsync(tenantId, token, pageSize, cancellationToken).ConfigureAwait(false);
    }
}

public sealed class InMemoryAssetRepository : IAssetRepository
{
    private readonly ConcurrentDictionary<string, AssetAggregate> values = new(StringComparer.Ordinal);

    public Task<AssetAggregate?> FindAsync(string tenantId, string assetId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        values.TryGetValue(Key(tenantId, assetId), out var asset);
        return Task.FromResult(asset);
    }

    public Task SaveAsync(AssetAggregate asset, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(asset);
        cancellationToken.ThrowIfCancellationRequested();
        values[Key(asset.Descriptor.TenantId, asset.Descriptor.AssetId)] = asset;
        return Task.CompletedTask;
    }

    public Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string? continuationToken, int pageSize, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var scoped = values.Values
            .Where(asset => string.Equals(asset.Descriptor.TenantId, tenantId, StringComparison.Ordinal))
            .OrderBy(asset => asset.Descriptor.AssetId, StringComparer.Ordinal)
            .ToArray();

        var start = 0;
        if (!string.IsNullOrEmpty(continuationToken) && int.TryParse(continuationToken, out var parsed) && parsed > 0)
        {
            start = parsed;
        }

        var size = pageSize > 0 ? pageSize : scoped.Length;
        var items = scoped.Skip(start).Take(size).ToArray();
        var consumed = start + items.Length;
        var hasMore = consumed < scoped.Length;
        var token = hasMore ? consumed.ToString() : null;

        return Task.FromResult(new AssetPage<AssetAggregate>(items, token, scoped.Length, hasMore));
    }

    private static string Key(string tenantId, string assetId) => $"{tenantId}\u001f{assetId}";
}

public sealed class AssetEventFactory
{
    private readonly IClock clock;
    public AssetEventFactory(IClock? clock = null) => this.clock = clock ?? new Adapters.SystemClock();

    public AssetEvent Create(AssetDescriptor descriptor, string eventType, string? attachmentId = null)
    {
        ArgumentNullException.ThrowIfNull(descriptor);

        var eventId = $"{descriptor.TenantId}/{descriptor.AssetId}/{eventType}";
        return new AssetEvent(
            eventId,
            descriptor.TenantId,
            descriptor.AssetId,
            eventType,
            clock.UtcNow,
            string.IsNullOrWhiteSpace(attachmentId) ? null : attachmentId)
        {
            State = WorkflowState.Approved,
        };
    }

    public EventEnvelope Envelop(AssetEvent assetEvent, string correlationId, string actorId)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);

        var envelope = new EventEnvelope(assetEvent, correlationId)
        {
            Stage = EventProcessingStage.Enqueued,
        };

        return string.IsNullOrWhiteSpace(actorId) ? envelope : envelope.WithHeader("actorId", actorId);
    }
}
