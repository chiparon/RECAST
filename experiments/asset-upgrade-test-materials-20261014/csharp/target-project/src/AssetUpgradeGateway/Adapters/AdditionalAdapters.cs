namespace AssetUpgradeGateway.Adapters;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Ports;

public sealed class InMemoryPolicyDecision : IPolicyDecision
{
    private readonly ConcurrentDictionary<string, IReadOnlyList<ValidationIssue>> decisions = new(StringComparer.Ordinal);
    public void Set(string subjectId, IReadOnlyList<ValidationIssue> issues) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public Task<IReadOnlyList<ValidationIssue>> EvaluateAsync(OperationContext context, string subjectId, CancellationToken cancellationToken)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class InMemoryDispatchHistoryReader
{
    private readonly IDispatchHistory history;
    public InMemoryDispatchHistoryReader(IDispatchHistory history) => this.history = history;
    public Task<bool> HasSuccessfulAttemptAsync(string tenantId, string eventId, CancellationToken cancellationToken = default) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public Task<int> CountAttemptsAsync(string tenantId, string eventId, CancellationToken cancellationToken = default) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class InMemoryAssetChangeLog
{
    private readonly ConcurrentQueue<(string Tenant, string Asset, string Action, DateTimeOffset At)> changes = new();
    public void Append(string tenantId, string assetId, string action, DateTimeOffset at) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public IReadOnlyList<(string Tenant, string Asset, string Action, DateTimeOffset At)> Find(string tenantId, string? assetId = null) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class InMemoryOperationLock
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new(StringComparer.Ordinal);
    public Task<IDisposable> AcquireAsync(string key, CancellationToken cancellationToken = default)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private sealed class Releaser : IDisposable
    {
        private readonly SemaphoreSlim gate;
        public Releaser(SemaphoreSlim gate) => this.gate = gate;
        public void Dispose() { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    }
}

public sealed class InMemoryFeatureFlagSnapshot
{
    private readonly IFeatureFlags flags;
    public InMemoryFeatureFlagSnapshot(IFeatureFlags flags) => this.flags = flags;
    public IReadOnlyDictionary<string, bool> Capture(string tenantId, IEnumerable<string> names) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class CancellationAwareDispatcher : IWorkflowDispatcher
{
    private readonly IWorkflowDispatcher inner;
    public CancellationAwareDispatcher(IWorkflowDispatcher inner) => this.inner = inner;
    public Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
