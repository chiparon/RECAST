namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Telemetry;

public interface IHealthProbe
{
    string Name { get; }
    Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken);
}

public sealed class HealthProbeRunner
{
    private readonly IReadOnlyList<IHealthProbe> probes;
    private readonly IClock clock;
    public HealthProbeRunner(IEnumerable<IHealthProbe> probes, IClock? clock = null) { this.probes = probes?.ToArray() ?? Array.Empty<IHealthProbe>(); this.clock = clock ?? new Adapters.SystemClock(); }

    public async Task<ServiceHealthReport> RunAsync(CancellationToken cancellationToken = default)
    {
        // Every probe runs concurrently; the results keep the declared order and
        // a thrown or failed probe becomes an unhealthy check instead of aborting.
        var checks = probes.Select(probe => RunProbeAsync(probe, cancellationToken)).ToArray();
        var results = await Task.WhenAll(checks).ConfigureAwait(false);

        var report = results.Where(result => result is not null).Select(result => result!).ToArray();
        return new ServiceHealthReport(clock.UtcNow, report);
    }

    private async Task<HealthCheckResult?> RunProbeAsync(IHealthProbe? probe, CancellationToken cancellationToken)
    {
        if (probe is null)
        {
            return null;
        }

        var started = clock.UtcNow;
        try
        {
            var result = await probe.CheckAsync(cancellationToken).ConfigureAwait(false);
            var duration = clock.UtcNow - started;
            if (result is null)
            {
                return new HealthCheckResult(probe.Name, false, duration, "The probe returned no result.");
            }

            var component = string.IsNullOrWhiteSpace(result.Component) ? probe.Name : result.Component;
            return new HealthCheckResult(component, result.Healthy, duration, result.Detail);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            return new HealthCheckResult(probe.Name, false, clock.UtcNow - started, exception.Message);
        }
    }
}

public sealed class InMemoryHealthProbe : IHealthProbe
{
    private readonly Func<bool>? check;
    public InMemoryHealthProbe(string name, Func<bool>? check = null) { Name = name; this.check = check; }
    public string Name { get; }

    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var healthy = check is null || check();
        var detail = healthy ? null : $"Probe '{Name}' reported unhealthy.";
        return Task.FromResult(new HealthCheckResult(Name, healthy, TimeSpan.Zero, detail));
    }
}

public sealed class AuditQueryService
{
    private readonly IAuditQuery query;
    private readonly ITenantAuthorizer authorizer;
    public AuditQueryService(IAuditQuery query, ITenantAuthorizer authorizer) { this.query = query; this.authorizer = authorizer; }

    public async Task<IReadOnlyList<AuditRecord>> SearchAsync(AuditQuery request, string actorId, CancellationToken cancellationToken = default)
    {
        if (request is null)
        {
            return Array.Empty<AuditRecord>();
        }

        if (!authorizer.CanAccess(request.TenantId, actorId))
        {
            // Reject cross-tenant searches by returning no data rather than leaking rows.
            return Array.Empty<AuditRecord>();
        }

        var records = await query.FindAsync(
            request.TenantId,
            request.SubjectId,
            request.From,
            request.To,
            cancellationToken).ConfigureAwait(false);

        if (request.Limit > 0 && records.Count > request.Limit)
        {
            records = records.Take(request.Limit).ToArray();
        }

        return records;
    }
}

public sealed class TenantBoundaryService
{
    private readonly ITenantAuthorizer authorizer;
    public TenantBoundaryService(ITenantAuthorizer authorizer) => this.authorizer = authorizer;

    public void Require(string tenantId, string actorId)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            throw new UnauthorizedAccessException(
                $"Actor '{actorId}' is not authorized for tenant '{tenantId}'.");
        }
    }

    public void RequireSame(string expectedTenant, string actualTenant)
    {
        if (!string.Equals(expectedTenant, actualTenant, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException(
                $"Tenant '{actualTenant}' cannot be used in the scope of tenant '{expectedTenant}'.");
        }
    }
}

/// <summary>
/// Composition seam that binds the telemetry surface to the health and audit
/// pipeline. Probes report metrics-sink readiness for the workflow, order and
/// attachment components plus the tenant itself, and the audit decorator keeps
/// every recorded row countable without mutating it.
/// </summary>
public static class TelemetryHealthComposition
{
    private static readonly string[] DefaultComponents = { "workflow", "order", "attachment" };

    public static IAuditSink Decorate(IAuditSink audit, IMetricsSink? metrics)
        => AuditMetricsDecorator.Wrap(audit, metrics);

    public static IReadOnlyList<IHealthProbe> MetricsProbes(IMetricsSink metrics, string tenantId, IEnumerable<string>? components = null)
    {
        var probes = new List<IHealthProbe>();
        foreach (var component in components ?? DefaultComponents)
        {
            if (string.IsNullOrWhiteSpace(component))
            {
                continue;
            }

            probes.Add(new MetricsHealthProbe(metrics, tenantId, component));
        }

        probes.Add(new MetricsHealthProbe(metrics, tenantId));
        return probes;
    }

    public static HealthProbeRunner MetricsRunner(IMetricsSink metrics, string tenantId, IEnumerable<IHealthProbe>? probes = null, IClock? clock = null)
    {
        var all = new List<IHealthProbe>();
        if (probes is not null)
        {
            all.AddRange(probes);
        }

        all.AddRange(MetricsProbes(metrics, tenantId));
        return new HealthProbeRunner(all, clock);
    }
}
