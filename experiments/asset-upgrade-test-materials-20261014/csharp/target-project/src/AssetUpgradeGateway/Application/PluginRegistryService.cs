namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Ports;

public sealed record PluginRegistrationCommand(string TenantId, string ActorId, PluginDescriptor Descriptor);

public sealed class PluginRegistryService
{
    private readonly IPluginRegistry registry;
    private readonly ITenantAuthorizer authorizer;
    private readonly IAuditSink audit;
    public PluginRegistryService(IPluginRegistry registry, ITenantAuthorizer authorizer, IAuditSink audit) { this.registry = registry; this.authorizer = authorizer; this.audit = audit; }
    public Task<PolicyResult> RegisterAsync(PluginRegistrationCommand command, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, string actorId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public Task<PolicyResult> DisableAsync(string tenantId, string actorId, string pluginId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class OrderCommandRouter
{
    private readonly OrderPluginValidationService plugins;
    private readonly OrderLifecycleService orders;
    public OrderCommandRouter(OrderPluginValidationService plugins, OrderLifecycleService orders) { this.plugins = plugins; this.orders = orders; }
    public Task<OrderSubmissionResult?> RouteAsync(OrderCommand command, OrderRequest request, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
