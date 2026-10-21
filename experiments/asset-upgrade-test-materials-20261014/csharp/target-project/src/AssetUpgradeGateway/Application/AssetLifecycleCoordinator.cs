namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record AssetSubmissionCommand(string TenantId, string ActorId, AssetDescriptor Descriptor, AttachmentInput? Attachment, string EventType, string CorrelationId);
public sealed record AssetSubmissionResult(bool Accepted, DeliveryResult Delivery, AttachmentState? AttachmentState, IReadOnlyList<ValidationIssue> Issues);

public sealed class AssetLifecycleCoordinator
{
    private readonly AttachmentIntakeService attachments;
    private readonly WorkflowDeliveryCoordinator workflow;
    private readonly IAssetRepository assets;
    private readonly IAuditSink audit;
    private readonly IClock clock;

    public AssetLifecycleCoordinator(AttachmentIntakeService attachments, WorkflowDeliveryCoordinator workflow, IAssetRepository assets, IAuditSink audit, IClock? clock = null)
    {
        this.attachments = attachments; this.workflow = workflow; this.assets = assets; this.audit = audit; this.clock = clock ?? new Adapters.SystemClock();
    }
    public Task<AssetSubmissionResult> SubmitAsync(AssetSubmissionCommand command, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AssetSearchService
{
    private readonly IAssetRepository assets;
    private readonly ITenantAuthorizer authorizer;
    public AssetSearchService(IAssetRepository assets, ITenantAuthorizer authorizer) { this.assets = assets; this.authorizer = authorizer; }
    public Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string actorId, string? token, int pageSize, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class InMemoryAssetRepository : IAssetRepository
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, AssetAggregate> values = new(StringComparer.Ordinal);
    public Task<AssetAggregate?> FindAsync(string tenantId, string assetId, CancellationToken cancellationToken)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public Task SaveAsync(AssetAggregate asset, CancellationToken cancellationToken) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public Task<AssetPage<AssetAggregate>> SearchAsync(string tenantId, string? continuationToken, int pageSize, CancellationToken cancellationToken)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private static string Key(string tenantId, string assetId) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AssetEventFactory
{
    private readonly IClock clock;
    public AssetEventFactory(IClock? clock = null) => this.clock = clock ?? new Adapters.SystemClock();
    public AssetEvent Create(AssetDescriptor descriptor, string eventType, string? attachmentId = null) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public EventEnvelope Envelop(AssetEvent assetEvent, string correlationId, string actorId) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
