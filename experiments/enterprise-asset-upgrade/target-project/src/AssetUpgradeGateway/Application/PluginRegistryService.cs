namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;

public sealed record PluginRegistrationCommand(string TenantId, string ActorId, PluginDescriptor Descriptor);

public sealed class PluginRegistryService
{
    private readonly IPluginRegistry registry;
    private readonly ITenantAuthorizer authorizer;
    private readonly IAuditSink audit;
    public PluginRegistryService(IPluginRegistry registry, ITenantAuthorizer authorizer, IAuditSink audit) { this.registry = registry; this.authorizer = authorizer; this.audit = audit; }

    public async Task<PolicyResult> RegisterAsync(PluginRegistrationCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);

        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
        {
            return PolicyResult.Deny(new ValidationIssue(
                "plugin.unauthorized",
                $"Actor '{command.ActorId}' is not authorized for tenant '{command.TenantId}'.",
                ValidationSeverity.Error));
        }

        var descriptor = command.Descriptor;
        if (descriptor is null)
        {
            return PolicyResult.Deny(new ValidationIssue("plugin.required", "A plugin descriptor is required.", ValidationSeverity.Error));
        }

        if (!string.Equals(descriptor.TenantId, command.TenantId, StringComparison.Ordinal))
        {
            return PolicyResult.Deny(new ValidationIssue(
                "plugin.tenant",
                $"Plugin '{descriptor.PluginId}' belongs to tenant '{descriptor.TenantId}' and not to '{command.TenantId}'.",
                ValidationSeverity.Error));
        }

        if (descriptor.Capabilities is null || descriptor.Capabilities.Count == 0)
        {
            return PolicyResult.Deny(new ValidationIssue(
                "plugin.capabilities.empty",
                $"Plugin '{descriptor.PluginId}' must declare at least one capability.",
                ValidationSeverity.Error));
        }

        // An enabled plugin must clear the capability policy for every declared
        // capability; a disabled plugin may be registered (it stays unusable until
        // it is explicitly enabled).
        var policy = new PluginCapabilityPolicy();
        foreach (var capability in descriptor.Capabilities)
        {
            if (!descriptor.Enabled)
            {
                break;
            }

            var invocation = new PluginInvocation(
                descriptor.PluginId,
                command.TenantId,
                capability,
                Guid.NewGuid().ToString("N"),
                new Dictionary<string, string>(StringComparer.Ordinal),
                DateTimeOffset.UtcNow);

            var decision = policy.Evaluate(descriptor, invocation);
            if (!decision.Allowed)
            {
                return decision;
            }
        }

        await registry.RegisterAsync(descriptor, cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(command.TenantId, descriptor.PluginId, "plugin.register", "Registered", DateTimeOffset.UtcNow));
        return PolicyResult.Allow();
    }

    public async Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, string actorId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return Array.Empty<PluginDescriptor>();
        }

        return await registry.ListAsync(tenantId, cancellationToken).ConfigureAwait(false);
    }

    public async Task<PolicyResult> DisableAsync(string tenantId, string actorId, string pluginId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return PolicyResult.Deny(new ValidationIssue(
                "plugin.unauthorized",
                $"Actor '{actorId}' is not authorized for tenant '{tenantId}'.",
                ValidationSeverity.Error));
        }

        var descriptors = await registry.ListAsync(tenantId, cancellationToken).ConfigureAwait(false);
        var descriptor = descriptors.FirstOrDefault(candidate => string.Equals(candidate.PluginId, pluginId, StringComparison.Ordinal));
        if (descriptor is null)
        {
            return PolicyResult.Deny(new ValidationIssue(
                "plugin.not_found",
                $"Plugin '{pluginId}' was not found for tenant '{tenantId}'.",
                ValidationSeverity.Error));
        }

        await registry.RegisterAsync(descriptor.Disable(), cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(tenantId, pluginId, "plugin.disable", "Disabled", DateTimeOffset.UtcNow));
        return PolicyResult.Allow();
    }
}

public sealed class OrderCommandRouter
{
    private readonly OrderPluginValidationService plugins;
    private readonly OrderLifecycleService orders;
    public OrderCommandRouter(OrderPluginValidationService plugins, OrderLifecycleService orders) { this.plugins = plugins; this.orders = orders; }

    public async Task<OrderSubmissionResult?> RouteAsync(OrderCommand command, OrderRequest request, CancellationToken cancellationToken = default)
    {
        if (command is null || request is null)
        {
            return null;
        }

        var validation = await plugins.EvaluateAsync(command, cancellationToken).ConfigureAwait(false);
        if (!validation.Allowed)
        {
            return new OrderSubmissionResult(
                false,
                OrderLifecycleState.Rejected,
                null,
                null,
                validation.Issues,
                Array.Empty<string>());
        }

        return await orders.SubmitAsync(new OrderSubmissionCommand(request, command.CommandId), cancellationToken).ConfigureAwait(false);
    }
}
