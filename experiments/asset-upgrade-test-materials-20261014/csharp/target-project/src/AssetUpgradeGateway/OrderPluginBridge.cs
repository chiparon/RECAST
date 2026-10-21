namespace AssetUpgradeGateway;

public sealed class OrderPluginBridge
{
    private readonly IOrderValidator validator;
    private readonly IInventoryGateway inventory;
    private readonly IIdempotencyStore idempotency;
    private readonly IOrderCommitter committer;
    private readonly IAuditSink audit;

    public OrderPluginBridge(
        IOrderValidator validator,
        IInventoryGateway inventory,
        IIdempotencyStore idempotency,
        IOrderCommitter committer,
        IAuditSink audit)
    {
        this.validator = validator;
        this.inventory = inventory;
        this.idempotency = idempotency;
        this.committer = committer;
        this.audit = audit;
    }

    public Task<OrderResult> SubmitAsync(
        OrderRequest order,
        CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException("Implementation belongs to the evaluated Agent.");
    }
}
