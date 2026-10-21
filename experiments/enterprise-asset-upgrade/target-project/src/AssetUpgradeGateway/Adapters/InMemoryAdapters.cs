namespace AssetUpgradeGateway.Adapters;

using System.Collections.Concurrent;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Policies;

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

public sealed class ManualClock : IClock
{
    private DateTimeOffset current;
    public ManualClock(DateTimeOffset initial) => current = initial;
    public DateTimeOffset UtcNow => current;
    public void Advance(TimeSpan amount) => current = current.Add(amount);
    public void Set(DateTimeOffset value) => current = value;
}

public sealed class InMemoryTenantAuthorizer : ITenantAuthorizer
{
    private readonly ConcurrentDictionary<(string Tenant, string Actor), HashSet<string>> memberships = new();

    public void Grant(string tenantId, string actorId, params string[] permissions)
    {
        ArgumentNullException.ThrowIfNull(tenantId);
        ArgumentNullException.ThrowIfNull(actorId);

        var permissions_ = memberships.GetOrAdd(
            (tenantId, actorId),
            _ => new HashSet<string>(StringComparer.OrdinalIgnoreCase));

        lock (permissions_)
        {
            foreach (var permission in permissions ?? Array.Empty<string>())
            {
                if (!string.IsNullOrWhiteSpace(permission))
                {
                    permissions_.Add(permission);
                }
            }
        }
    }

    public bool CanAccess(string tenantId, string actorId)
        => tenantId is not null && actorId is not null && memberships.ContainsKey((tenantId, actorId));

    public bool Can(string tenantId, string actorId, string permission)
        => memberships.TryGetValue((tenantId, actorId), out var permissions)
            && !string.IsNullOrEmpty(permission)
            && permissions.Contains(permission);

    public TenantScope Scope(string tenantId, string actorId, DateTimeOffset expiresAt)
    {
        memberships.TryGetValue((tenantId, actorId), out var permissions);
        var snapshot = permissions is null
            ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : new HashSet<string>(permissions, StringComparer.OrdinalIgnoreCase);

        return new TenantScope(tenantId, actorId, new HashSet<string>(StringComparer.OrdinalIgnoreCase), snapshot, expiresAt);
    }
}

public sealed class InMemoryIdempotencyStore : IIdempotencyStore
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> completed = new(StringComparer.Ordinal);

    public bool HasCompleted(string tenantId, string operationId)
        => tenantId is not null && operationId is not null && completed.ContainsKey(Key(tenantId, operationId));

    public void MarkCompleted(string tenantId, string operationId)
    {
        ArgumentNullException.ThrowIfNull(tenantId);
        ArgumentNullException.ThrowIfNull(operationId);
        completed[Key(tenantId, operationId)] = DateTimeOffset.UtcNow;
    }

    public IReadOnlyDictionary<string, DateTimeOffset> Snapshot()
        => new Dictionary<string, DateTimeOffset>(completed, StringComparer.Ordinal);

    private static string Key(string tenantId, string operationId) => $"{tenantId}\u001f{operationId}";
}

public sealed class InMemoryAuditSink : IAuditSink, IAuditQuery
{
    private readonly ConcurrentQueue<AuditRecord> records = new();

    public void Record(AuditRecord record)
    {
        if (record is null)
        {
            return;
        }

        records.Enqueue(record);
    }

    public Task<IReadOnlyList<AuditRecord>> FindAsync(string tenantId, string? subjectId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        IReadOnlyList<AuditRecord> matches = records
            .Where(record => string.Equals(record.TenantId, tenantId, StringComparison.Ordinal))
            .Where(record => subjectId is null || string.Equals(record.SubjectId, subjectId, StringComparison.Ordinal))
            .Where(record => record.At >= from && record.At <= to)
            .OrderBy(record => record.At)
            .ToArray();

        return Task.FromResult(matches);
    }

    public IReadOnlyList<AuditRecord> Snapshot() => records.ToArray();
}

public sealed class InMemoryAttachmentRepository : IAttachmentRepository
{
    private readonly ConcurrentDictionary<string, AttachmentInput> attachments = new(StringComparer.Ordinal);

    public Task<AttachmentInput?> FindAsync(string tenantId, string attachmentId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attachments.TryGetValue(Key(tenantId, attachmentId), out var attachment);
        return Task.FromResult(attachment);
    }

    public Task SaveAsync(AttachmentInput attachment, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(attachment);
        cancellationToken.ThrowIfCancellationRequested();
        attachments[Key(attachment.TenantId, attachment.AttachmentId)] = attachment;
        return Task.CompletedTask;
    }

    public Task ReleaseAsync(string tenantId, string attachmentId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var key = Key(tenantId, attachmentId);
        if (attachments.TryGetValue(key, out var attachment) && !attachment.Scanned)
        {
            attachments[key] = attachment with { Scanned = true };
        }

        return Task.CompletedTask;
    }

    public IReadOnlyList<AttachmentInput> Snapshot() => attachments.Values.ToArray();

    private static string Key(string tenantId, string id) => $"{tenantId}\u001f{id}";
}

public sealed class InMemoryAttachmentScanner : IAttachmentScanner
{
    private readonly IClock clock;
    private readonly Func<AttachmentInput, bool>? detector;
    public InMemoryAttachmentScanner(IClock? clock = null, Func<AttachmentInput, bool>? detector = null) { this.clock = clock ?? new SystemClock(); this.detector = detector; }

    public Task<AttachmentScanResult> ScanAsync(AttachmentInput attachment, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(attachment);
        cancellationToken.ThrowIfCancellationRequested();

        var clean = detector is null ? attachment.Scanned : detector(attachment);
        var detail = clean ? "scanner reported a clean payload" : "scanner reported a quarantined payload";
        return Task.FromResult(new AttachmentScanResult(attachment.AttachmentId, clean, "in-memory", clock.UtcNow, detail));
    }
}

public sealed class InMemoryAttachmentQuarantine : IAttachmentQuarantine
{
    private readonly ConcurrentDictionary<string, string> rejected = new(StringComparer.Ordinal);
    private readonly AttachmentValidationPipeline validation;

    public InMemoryAttachmentQuarantine(AttachmentValidationPipeline? validation = null)
        => this.validation = validation ?? new AttachmentValidationPipeline();

    /// <summary>
    /// An attachment is only ever safe once it has passed scanning, is not on the
    /// explicit rejection list, and satisfies the filename, MIME, size and
    /// content-signature policy. Anything else stays quarantined so it can never
    /// enter the approval workflow.
    /// </summary>
    public bool IsSafe(AttachmentInput attachment)
    {
        if (attachment is null || !attachment.Scanned)
        {
            return false;
        }

        if (rejected.ContainsKey(attachment.AttachmentId))
        {
            return false;
        }

        return validation.Evaluate(attachment).Allowed;
    }

    public void Reject(string attachmentId, string reason)
    {
        if (string.IsNullOrEmpty(attachmentId))
        {
            return;
        }

        rejected[attachmentId] = reason ?? "rejected";
    }

    public bool TryGetReason(string attachmentId, out string? reason)
        => rejected.TryGetValue(attachmentId ?? string.Empty, out reason);
}

public sealed class InMemoryDeadLetterSink : IDeadLetterSink
{
    private readonly ConcurrentQueue<DeadLetterEvent> events = new();

    public Task PublishAsync(DeadLetterEvent deadLetter, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(deadLetter);
        cancellationToken.ThrowIfCancellationRequested();
        events.Enqueue(deadLetter);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<DeadLetterEvent>> FindByTenantAsync(string tenantId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<DeadLetterEvent> matches = events
            .Where(deadLetter => deadLetter.Event is not null
                && string.Equals(deadLetter.Event.TenantId, tenantId, StringComparison.Ordinal))
            .OrderBy(deadLetter => deadLetter.RecordedAt)
            .ToArray();
        return Task.FromResult(matches);
    }

    public IReadOnlyList<DeadLetterEvent> Snapshot() => events.ToArray();
}

public sealed class InMemoryMetricsSink : IMetricsSink
{
    private readonly ConcurrentDictionary<(string Tenant, string Name), long> counters = new();
    private readonly ConcurrentDictionary<(string Tenant, string Name), TimeSpan> timings = new();

    public void Increment(string name, string tenantId)
    {
        if (string.IsNullOrEmpty(name))
        {
            return;
        }

        counters.AddOrUpdate((tenantId, name), 1, (_, value) => value + 1);
    }

    public void Timing(string name, string tenantId, TimeSpan duration)
    {
        if (string.IsNullOrEmpty(name))
        {
            return;
        }

        timings.AddOrUpdate((tenantId, name), duration, (_, value) => value + duration);
    }

    public MetricSnapshot Snapshot(string tenantId)
    {
        var scopedCounters = counters
            .Where(entry => string.Equals(entry.Key.Tenant, tenantId, StringComparison.Ordinal))
            .ToDictionary(entry => entry.Key.Name, entry => entry.Value, StringComparer.Ordinal);
        var scopedTimings = timings
            .Where(entry => string.Equals(entry.Key.Tenant, tenantId, StringComparison.Ordinal))
            .ToDictionary(entry => entry.Key.Name, entry => entry.Value, StringComparer.Ordinal);

        return new MetricSnapshot(tenantId, scopedCounters, scopedTimings);
    }
}

public sealed class InMemoryRetryableEventStore : IRetryableEventStore, IEventEnvelopeStore
{
    private readonly ConcurrentDictionary<string, PendingEvent> pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, EventEnvelope> envelopes = new(StringComparer.Ordinal);

    public Task<IReadOnlyList<PendingEvent>> FindDueAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        IReadOnlyList<PendingEvent> due = pending.Values
            .Where(item => item.Event is not null && item.Retryable && item.RetryAfter <= now)
            .OrderBy(item => item.RetryAfter)
            .ThenBy(item => item.Event.EventId, StringComparer.Ordinal)
            .Take(limit <= 0 ? int.MaxValue : limit)
            .ToArray();

        return Task.FromResult(due);
    }

    public Task MarkRetryableAsync(PendingEvent pendingEvent, DateTimeOffset retryAfter, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pendingEvent);
        cancellationToken.ThrowIfCancellationRequested();

        if (pendingEvent.Event is null)
        {
            return Task.CompletedTask;
        }

        pending[Key(pendingEvent.Event.TenantId, pendingEvent.Event.EventId)] = pendingEvent with { RetryAfter = retryAfter };
        return Task.CompletedTask;
    }

    public Task<EventEnvelope?> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        envelopes.TryGetValue(Key(tenantId, eventId), out var envelope);
        return Task.FromResult(envelope);
    }

    public Task SaveAsync(EventEnvelope envelope, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        cancellationToken.ThrowIfCancellationRequested();

        if (envelope.Event is null)
        {
            return Task.CompletedTask;
        }

        envelopes[Key(envelope.Event.TenantId, envelope.Event.EventId)] = envelope;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<EventEnvelope>> FindByStageAsync(string tenantId, EventProcessingStage stage, int limit, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        IReadOnlyList<EventEnvelope> matches = envelopes.Values
            .Where(envelope => envelope.Event is not null
                && string.Equals(envelope.Event.TenantId, tenantId, StringComparison.Ordinal)
                && envelope.Stage == stage)
            .OrderBy(envelope => envelope.EnqueuedAt)
            .ThenBy(envelope => envelope.Event.EventId, StringComparer.Ordinal)
            .Take(limit <= 0 ? int.MaxValue : limit)
            .ToArray();

        return Task.FromResult(matches);
    }

    public void Add(PendingEvent item)
    {
        if (item?.Event is null)
        {
            return;
        }

        pending[Key(item.Event.TenantId, item.Event.EventId)] = item;
    }

    private static string Key(string tenantId, string eventId) => $"{tenantId}\u001f{eventId}";
}

public sealed class InMemoryWorkflowDispatcher : IWorkflowDispatcher
{
    private readonly ConcurrentQueue<AssetEvent> dispatched = new();
    private readonly Func<AssetEvent, DeliveryStatus>? behavior;
    public InMemoryWorkflowDispatcher(Func<AssetEvent, DeliveryStatus>? behavior = null) => this.behavior = behavior;

    public Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);
        cancellationToken.ThrowIfCancellationRequested();

        dispatched.Enqueue(assetEvent);
        var status = behavior is null ? DeliveryStatus.Accepted : behavior(assetEvent);
        var accepted = status == DeliveryStatus.Accepted;
        var detail = accepted ? null : $"dispatcher returned '{status}'";
        return Task.FromResult(new DeliveryResult(accepted, status, detail));
    }

    public IReadOnlyList<AssetEvent> Snapshot() => dispatched.ToArray();
}

public sealed class InMemoryDispatchHistory : IDispatchHistory, IDispatchAttemptStore
{
    private readonly ConcurrentQueue<DispatchAttempt> attempts = new();

    public Task AppendAsync(DispatchAttempt attempt, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(attempt);
        cancellationToken.ThrowIfCancellationRequested();
        attempts.Enqueue(attempt);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<DispatchAttempt>> FindAsync(string tenantId, string eventId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        IReadOnlyList<DispatchAttempt> matches = attempts
            .Where(attempt => string.Equals(attempt.TenantId, tenantId, StringComparison.Ordinal)
                && string.Equals(attempt.EventId, eventId, StringComparison.Ordinal))
            .OrderBy(attempt => attempt.Attempt)
            .ToArray();

        return Task.FromResult(matches);
    }

    public IReadOnlyList<DispatchAttempt> Snapshot() => attempts.ToArray();
}

public sealed class InMemoryOrderRepository : IOrderAggregateRepository
{
    private readonly ConcurrentDictionary<string, OrderSnapshot> snapshots = new(StringComparer.Ordinal);

    public Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(snapshots.ContainsKey(Key(tenantId, orderId)));
    }

    public Task<OrderSnapshot?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        snapshots.TryGetValue(Key(tenantId, orderId), out var snapshot);
        return Task.FromResult(snapshot);
    }

    public Task SaveAsync(OrderSnapshot snapshot, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        cancellationToken.ThrowIfCancellationRequested();
        var request = snapshot.Request;
        var key = Key(request.TenantId, request.OrderId);

        snapshots.AddOrUpdate(key, snapshot, (_, existing) =>
            snapshot.Version >= existing.Version ? snapshot : existing);

        return Task.CompletedTask;
    }

    public IReadOnlyList<OrderSnapshot> Snapshot() => snapshots.Values.ToArray();

    private static string Key(string tenantId, string orderId) => $"{tenantId}\u001f{orderId}";
}


public sealed class InMemoryOrderRequestRepository : IOrderRepository
{
    private readonly ConcurrentDictionary<string, OrderRequest> requests = new(StringComparer.Ordinal);

    public Task<OrderRequest?> FindAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        requests.TryGetValue(Key(tenantId, orderId), out var request);
        return Task.FromResult(request);
    }

    public Task SaveAsync(OrderRequest order, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(order);
        cancellationToken.ThrowIfCancellationRequested();
        requests[Key(order.TenantId, order.OrderId)] = order;
        return Task.CompletedTask;
    }

    public Task<bool> ExistsAsync(string tenantId, string orderId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(requests.ContainsKey(Key(tenantId, orderId)));
    }

    private static string Key(string tenantId, string orderId) => $"{tenantId}\u001f{orderId}";
}

public sealed class InMemoryInventoryGateway : IInventoryGateway, IReservationLedger
{
    private readonly ConcurrentDictionary<string, InventoryReservation> reservations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> stock = new(StringComparer.OrdinalIgnoreCase);
    private readonly IClock clock;
    public InMemoryInventoryGateway(IClock? clock = null) => this.clock = clock ?? new SystemClock();

    public void Seed(string sku, int quantity)
    {
        if (string.IsNullOrWhiteSpace(sku))
        {
            return;
        }

        stock[sku] = quantity;
    }

    public Task<ReservationResult> ReserveAsync(OrderRequest order, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(order);
        cancellationToken.ThrowIfCancellationRequested();

        var demanded = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in order.Lines ?? Array.Empty<OrderLine>())
        {
            if (line is null || line.Quantity <= 0)
            {
                continue;
            }

            demanded[line.Sku] = demanded.TryGetValue(line.Sku, out var current) ? current + line.Quantity : line.Quantity;
        }

        if (demanded.Count == 0)
        {
            return Task.FromResult(new ReservationResult(false, null, "The order has no reservable lines."));
        }

        foreach (var entry in demanded)
        {
            if (!stock.TryGetValue(entry.Key, out var available) || available < entry.Value)
            {
                return Task.FromResult(new ReservationResult(
                    false,
                    null,
                    $"Insufficient stock for '{entry.Key}': requested {entry.Value}, available {available}."));
            }
        }

        foreach (var entry in demanded)
        {
            stock.AddOrUpdate(entry.Key, 0, (_, value) => value - entry.Value);
        }

        var reservationId = $"res-{Guid.NewGuid():N}";
        var reservation = new InventoryReservation(
            reservationId,
            order.TenantId,
            order.OrderId,
            demanded,
            clock.UtcNow.AddMinutes(15),
            false);

        reservations[Key(order.TenantId, reservationId)] = reservation;
        return Task.FromResult(new ReservationResult(true, reservationId, null));
    }

    public Task<InventoryReservation?> FindAsync(string tenantId, string reservationId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        reservations.TryGetValue(Key(tenantId, reservationId), out var reservation);
        return Task.FromResult(reservation);
    }

    public Task SaveAsync(InventoryReservation reservation, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reservation);
        cancellationToken.ThrowIfCancellationRequested();
        reservations[Key(reservation.TenantId, reservation.ReservationId)] = reservation;
        return Task.CompletedTask;
    }

    public Task ReleaseAsync(string tenantId, string reservationId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var key = Key(tenantId, reservationId);

        if (!reservations.TryGetValue(key, out var reservation) || reservation.Released)
        {
            return Task.CompletedTask;
        }

        foreach (var entry in reservation.Quantities)
        {
            stock.AddOrUpdate(entry.Key, entry.Value, (_, value) => value + entry.Value);
        }

        reservations[key] = reservation.Release();
        return Task.CompletedTask;
    }

    private static string Key(string tenantId, string reservationId) => $"{tenantId}\u001f{reservationId}";
}

public sealed class InMemoryOrderCommitter : IOrderCommitter
{
    private readonly ConcurrentQueue<OrderCommitReceipt> receipts = new();
    private readonly IClock clock;
    public InMemoryOrderCommitter(IClock? clock = null) => this.clock = clock ?? new SystemClock();

    public Task CommitAsync(OrderRequest order, ReservationResult reservation, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(order);
        ArgumentNullException.ThrowIfNull(reservation);
        cancellationToken.ThrowIfCancellationRequested();

        var commitId = $"commit-{Guid.NewGuid():N}";
        receipts.Enqueue(new OrderCommitReceipt(order.OrderId, reservation.ReservationId ?? string.Empty, commitId, clock.UtcNow));
        return Task.CompletedTask;
    }

    public IReadOnlyList<OrderCommitReceipt> Snapshot() => receipts.ToArray();
}

public sealed class InMemoryPluginRegistry : IPluginRegistry
{
    private readonly ConcurrentDictionary<string, PluginDescriptor> plugins = new(StringComparer.Ordinal);

    public Task RegisterAsync(PluginDescriptor descriptor, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        cancellationToken.ThrowIfCancellationRequested();
        plugins[Key(descriptor.TenantId, descriptor.PluginId)] = descriptor;
        return Task.CompletedTask;
    }

    public Task<PluginDescriptor?> FindCapabilityAsync(string tenantId, string capability, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var match = plugins.Values
            .Where(descriptor => string.Equals(descriptor.TenantId, tenantId, StringComparison.Ordinal)
                && descriptor.Supports(capability))
            .OrderByDescending(descriptor => descriptor.Enabled)
            .ThenBy(descriptor => descriptor.PluginId, StringComparer.Ordinal)
            .FirstOrDefault();

        return Task.FromResult<PluginDescriptor?>(match);
    }

    public Task<IReadOnlyList<PluginDescriptor>> ListAsync(string tenantId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        IReadOnlyList<PluginDescriptor> matches = plugins.Values
            .Where(descriptor => string.Equals(descriptor.TenantId, tenantId, StringComparison.Ordinal))
            .OrderBy(descriptor => descriptor.PluginId, StringComparer.Ordinal)
            .ToArray();

        return Task.FromResult(matches);
    }

    private static string Key(string tenantId, string pluginId) => $"{tenantId}\u001f{pluginId}";
}

public sealed class InMemoryTransactionBoundary : ITransactionBoundary
{
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task<T> ExecuteAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(operation);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await operation(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }
}

public sealed class InMemoryLeaseStore : ILeaseStore
{
    private readonly ConcurrentDictionary<string, LeaseClaim> claims = new(StringComparer.Ordinal);

    public Task<bool> TryClaimAsync(string tenantId, string key, TimeSpan duration, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(tenantId);
        ArgumentNullException.ThrowIfNull(key);
        cancellationToken.ThrowIfCancellationRequested();

        var now = DateTimeOffset.UtcNow;
        var compound = $"{tenantId}\u001f{key}";
        var claim = new LeaseClaim(tenantId, key, now.Add(duration), $"owner-{Guid.NewGuid():N}");

        while (true)
        {
            if (claims.TryGetValue(compound, out var existing) && existing.ExpiresAt > now)
            {
                return Task.FromResult(false);
            }

            if (existing is null)
            {
                if (claims.TryAdd(compound, claim))
                {
                    return Task.FromResult(true);
                }
            }
            else if (claims.TryUpdate(compound, claim, existing))
            {
                return Task.FromResult(true);
            }
        }
    }

    public Task ReleaseAsync(string tenantId, string key, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        claims.TryRemove($"{tenantId}\u001f{key}", out _);
        return Task.CompletedTask;
    }
}

public sealed class InMemoryCheckpointStore : ICheckpointStore
{
    private readonly ConcurrentDictionary<string, string> values = new(StringComparer.Ordinal);

    public Task<string?> GetAsync(string tenantId, string jobName, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        values.TryGetValue(Key(tenantId, jobName), out var value);
        return Task.FromResult(value);
    }

    public Task PutAsync(string tenantId, string jobName, string checkpoint, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        values[Key(tenantId, jobName)] = checkpoint ?? string.Empty;
        return Task.CompletedTask;
    }

    private static string Key(string tenantId, string jobName) => $"{tenantId}\u001f{jobName}";
}

public sealed class InMemoryQuarantineLog : IQuarantineLog
{
    private readonly ConcurrentQueue<QuarantineEntry> entries = new();

    public Task RecordAsync(string tenantId, string attachmentId, IReadOnlyList<ValidationIssue> issues, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        entries.Enqueue(new QuarantineEntry(
            tenantId,
            attachmentId,
            issues ?? Array.Empty<ValidationIssue>(),
            DateTimeOffset.UtcNow));
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> FindAsync(string tenantId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        IReadOnlyList<string> matches = entries
            .Where(entry => string.Equals(entry.TenantId, tenantId, StringComparison.Ordinal))
            .Select(entry => entry.AttachmentId)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return Task.FromResult(matches);
    }
}

public sealed class InMemoryFeatureFlags : IFeatureFlags
{
    private readonly ConcurrentDictionary<(string Tenant, string Flag), bool> flags = new();

    public void Set(string tenantId, string flag, bool enabled)
    {
        if (string.IsNullOrEmpty(flag))
        {
            return;
        }

        flags[(tenantId, flag)] = enabled;
    }

    public bool Enabled(string tenantId, string flag)
        => flags.TryGetValue((tenantId, flag), out var enabled) && enabled;
}
