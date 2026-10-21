namespace AssetUpgradeGateway;

public sealed class AssetUpgradeService
{
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

    public Task<DeliveryResult> SubmitAsync(
        string actorId,
        AssetEvent assetEvent,
        AttachmentInput? attachment,
        CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException("Implementation belongs to the evaluated Agent.");
    }
}
