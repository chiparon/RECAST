namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public interface IHealthProbe
{
    string Name { get; }
    Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken);
}

public sealed class HealthProbeRunner
{
    private readonly IReadOnlyList<IHealthProbe> probes;
    private readonly IClock clock;
    public HealthProbeRunner(IEnumerable<IHealthProbe> probes, IClock? clock = null) { this.probes = probes.ToArray(); this.clock = clock ?? new Adapters.SystemClock(); }
    public Task<ServiceHealthReport> RunAsync(CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class InMemoryHealthProbe : IHealthProbe
{
    private readonly Func<bool>? check;
    public InMemoryHealthProbe(string name, Func<bool>? check = null) { Name = name; this.check = check; }
    public string Name { get; }
    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AuditQueryService
{
    private readonly IAuditQuery query;
    private readonly ITenantAuthorizer authorizer;
    public AuditQueryService(IAuditQuery query, ITenantAuthorizer authorizer) { this.query = query; this.authorizer = authorizer; }
    public Task<IReadOnlyList<AuditRecord>> SearchAsync(AuditQuery request, string actorId, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class TenantBoundaryService
{
    private readonly ITenantAuthorizer authorizer;
    public TenantBoundaryService(ITenantAuthorizer authorizer) => this.authorizer = authorizer;
    public void Require(string tenantId, string actorId) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public void RequireSame(string expectedTenant, string actualTenant) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
