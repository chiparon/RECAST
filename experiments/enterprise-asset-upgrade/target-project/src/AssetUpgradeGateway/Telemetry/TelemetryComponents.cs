namespace AssetUpgradeGateway.Telemetry;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public sealed record TraceSpan(string TraceId, string Name, DateTimeOffset StartedAt, DateTimeOffset? FinishedAt, IReadOnlyDictionary<string, string> Tags, bool Failed);

public interface ITraceSink
{
    void Write(TraceSpan span);
    IReadOnlyList<TraceSpan> Find(string traceId);
}

public sealed class InMemoryTraceSink : ITraceSink
{
    private readonly ConcurrentQueue<TraceSpan> spans = new();
    public void Write(TraceSpan span)
    {
        if (span is null)
        {
            return;
        }

        spans.Enqueue(span);
    }

    public IReadOnlyList<TraceSpan> Find(string traceId)
    {
        if (traceId is null)
        {
            return Array.Empty<TraceSpan>();
        }

        return spans
            .Where(span => string.Equals(span.TraceId, traceId, StringComparison.Ordinal))
            .OrderBy(span => span.StartedAt)
            .ThenBy(span => span.Name, StringComparer.Ordinal)
            .ToArray();
    }
}

public sealed class TraceScope : IDisposable
{
    private readonly ITraceSink sink;
    private readonly DateTimeOffset started;
    private readonly string traceId;
    private readonly string name;
    private readonly ConcurrentDictionary<string, string> tags;
    private int disposed;

    public TraceScope(ITraceSink sink, string traceId, string name, IReadOnlyDictionary<string, string>? tags = null)
    {
        this.sink = sink;
        this.traceId = traceId;
        this.name = name;
        this.tags = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);

        if (tags is not null)
        {
            foreach (var pair in tags)
            {
                if (!string.IsNullOrEmpty(pair.Key))
                {
                    this.tags[pair.Key] = pair.Value ?? string.Empty;
                }
            }
        }

        started = DateTimeOffset.UtcNow;
    }

    public bool Failed { get; private set; }

    public string TraceId => traceId;

    public void MarkFailed(string? reason = null)
    {
        Failed = true;
        if (!string.IsNullOrWhiteSpace(reason))
        {
            tags["failure.reason"] = reason;
        }
    }

    public void AddTag(string key, string value)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return;
        }

        tags[key] = value ?? string.Empty;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        var merged = new Dictionary<string, string>(tags, StringComparer.Ordinal);
        sink?.Write(new TraceSpan(traceId, name, started, DateTimeOffset.UtcNow, merged, Failed));
    }
}

public sealed class TraceFactory
{
    private readonly ITraceSink sink;
    public TraceFactory(ITraceSink sink) => this.sink = sink;
    public TraceScope Start(string traceId, string operation, string tenantId, string actorId)
    {
        var resolvedTraceId = string.IsNullOrWhiteSpace(traceId) ? Guid.NewGuid().ToString("N") : traceId;
        var name = string.IsNullOrWhiteSpace(operation) ? "operation" : operation;
        var tags = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["tenantId"] = tenantId ?? string.Empty,
            ["actorId"] = actorId ?? string.Empty,
            ["operation"] = operation ?? string.Empty,
        };

        return new TraceScope(sink, resolvedTraceId, name, tags);
    }
}

public sealed class MetricsHealthProbe : Application.IHealthProbe
{
    private readonly IMetricsSink metrics;
    private readonly string tenantId;
    private readonly string? component;

    public MetricsHealthProbe(IMetricsSink metrics, string tenantId) : this(metrics, tenantId, null) { }

    public MetricsHealthProbe(IMetricsSink metrics, string tenantId, string? component)
    {
        this.metrics = metrics;
        this.tenantId = tenantId ?? string.Empty;
        this.component = string.IsNullOrWhiteSpace(component) ? null : component;
    }

    public string Name => component is null ? $"metrics:{tenantId}" : $"metrics:{tenantId}:{component}";

    public Task<HealthCheckResult> CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var started = DateTimeOffset.UtcNow;

        try
        {
            var snapshot = metrics.Snapshot(tenantId);
            var duration = DateTimeOffset.UtcNow - started;
            Emit(duration);

            var healthy = snapshot is not null;
            var detail = healthy ? null : $"The metrics sink for tenant '{tenantId}' returned no snapshot.";
            return Task.FromResult(new HealthCheckResult(Name, healthy, duration, detail));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            return Task.FromResult(new HealthCheckResult(Name, false, DateTimeOffset.UtcNow - started, exception.Message));
        }
    }

    private void Emit(TimeSpan duration)
    {
        try
        {
            metrics.Timing("health.metrics.check", tenantId, duration);
            metrics.Increment("health.metrics.check", tenantId);
        }
        catch
        {
        }
    }
}

public sealed class AuditMetricsDecorator : IAuditSink
{
    private readonly IAuditSink inner;
    private readonly IMetricsSink metrics;
    public AuditMetricsDecorator(IAuditSink inner, IMetricsSink metrics) { this.inner = inner; this.metrics = metrics; }

    public static IAuditSink Wrap(IAuditSink sink, IMetricsSink? metrics)
    {
        ArgumentNullException.ThrowIfNull(sink);

        if (sink is AuditMetricsDecorator || metrics is null)
        {
            return sink;
        }

        return new AuditMetricsDecorator(sink, metrics);
    }

    public void Record(AuditRecord record)
    {
        if (record is null)
        {
            return;
        }

        var started = DateTimeOffset.UtcNow;
        inner.Record(record);
        var duration = DateTimeOffset.UtcNow - started;

        try
        {
            metrics.Increment("audit.recorded", record.TenantId);
            metrics.Increment($"audit.{record.Action}", record.TenantId);
            metrics.Timing("audit.record", record.TenantId, duration);
        }
        catch
        {
        }
    }
}

public sealed class CorrelationContext : ICorrelationContext
{
    public CorrelationContext(string tenantId, string actorId, string correlationId)
    {
        TenantId = tenantId ?? string.Empty;
        ActorId = actorId ?? string.Empty;
        CorrelationId = correlationId ?? string.Empty;
    }
    public string CorrelationId { get; }
    public string ActorId { get; }
    public string TenantId { get; }
    public ICorrelationContext Child(string operation)
    {
        var op = operation ?? string.Empty;
        var correlationId = string.IsNullOrWhiteSpace(CorrelationId) ? op : $"{CorrelationId}/{op}";
        return new CorrelationContext(TenantId, ActorId, correlationId);
    }
}
