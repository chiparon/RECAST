namespace AssetUpgradeGateway;

public sealed class ReconciliationService
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IRetryableEventStore eventStore;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;

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
    }

    public Task<ReconciliationReport> RunAsync(
        string actorId,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException("Implementation belongs to the evaluated Agent.");
    }
}
