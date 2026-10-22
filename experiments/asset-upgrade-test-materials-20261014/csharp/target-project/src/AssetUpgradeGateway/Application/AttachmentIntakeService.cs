namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record AttachmentIntakeCommand(string TenantId, string ActorId, AttachmentInput Attachment, string CorrelationId);
public sealed record AttachmentIntakeResult(bool Accepted, AttachmentState State, IReadOnlyList<ValidationIssue> Issues, string? Fingerprint = null);

public sealed class AttachmentIntakeService
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IAttachmentRepository repository;
    private readonly IAttachmentScanner scanner;
    private readonly IQuarantineLog quarantine;
    private readonly IAuditSink audit;
    private readonly IMetricsSink metrics;
    private readonly AttachmentValidationPipeline validation;
    private readonly IClock clock;

    public AttachmentIntakeService(ITenantAuthorizer authorizer, IAttachmentRepository repository, IAttachmentScanner scanner, IQuarantineLog quarantine, IAuditSink audit, IMetricsSink metrics, IClock? clock = null, AttachmentValidationPipeline? validation = null)
    {
        this.authorizer = authorizer; this.repository = repository; this.scanner = scanner; this.quarantine = quarantine; this.audit = audit; this.metrics = metrics; this.clock = clock ?? new SystemClock(); this.validation = validation ?? new AttachmentValidationPipeline();
    }
    public Task<AttachmentIntakeResult> IntakeAsync(AttachmentIntakeCommand command, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private AttachmentIntakeResult Reject(AttachmentIntakeCommand command, ValidationIssue issue, DateTimeOffset started)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AttachmentQueryService
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    public AttachmentQueryService(IAttachmentRepository repository, ITenantAuthorizer authorizer) { this.repository = repository; this.authorizer = authorizer; }
    public Task<AttachmentInput?> GetAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AttachmentReleaser
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    private readonly IAuditSink audit;
    public AttachmentReleaser(IAttachmentRepository repository, ITenantAuthorizer authorizer, IAuditSink audit) { this.repository = repository; this.authorizer = authorizer; this.audit = audit; }
    public Task ReleaseAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
