namespace AssetUpgradeGateway;

using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Ports;

/// <summary>
/// Public gateway entry point for the order/plugin inventory integration.
/// Validation, reservation and committing form one logical operation: no
/// inventory is held unless validation passed, and a repeated request never
/// reserves a second time.
/// </summary>
public sealed class OrderPluginBridge
{
    private const string ActionName = "order.submit";

    private static readonly RequestNormalizer Normalizer = new();
    private static readonly RequestFingerprint Fingerprints = new();

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

    public async Task<OrderResult> SubmitAsync(
        OrderRequest order,
        CancellationToken cancellationToken = default)
    {
        if (order is null)
        {
            return new OrderResult(false, OrderStatus.Rejected, null, "An order request is required.");
        }

        var normalized = Normalizer.Normalize(order);
        var tenantId = normalized.TenantId;
        var orderId = normalized.OrderId;

        if (string.IsNullOrWhiteSpace(tenantId)
            || string.IsNullOrWhiteSpace(orderId)
            || normalized.Lines is null
            || normalized.Lines.Count == 0)
        {
            return Reject(tenantId, orderId, "The order request is incomplete.");
        }

        if (!validator.IsValid(normalized, out var reason))
        {
            return Reject(tenantId, orderId, reason ?? "The order request is invalid.");
        }

        var operationId = Fingerprints.ForOrder(normalized);

        // Serialize the check-perform-mark critical section so two concurrent
        // submissions of the same request cannot reserve inventory or commit twice.
        using var gate = await OperationSerialization.AcquireAsync(tenantId, "order-submit:" + operationId, cancellationToken).ConfigureAwait(false);

        if (idempotency.HasCompleted(tenantId, operationId))
        {
            audit.Record(new AuditRecord(tenantId, orderId, ActionName, "Duplicate", DateTimeOffset.UtcNow));
            return new OrderResult(
                false,
                OrderStatus.Accepted,
                null,
                $"Order '{orderId}' has already been processed; inventory is not reserved again.");
        }

        ReservationResult reservation;
        try
        {
            reservation = await inventory.ReserveAsync(normalized, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            return Reject(tenantId, orderId, exception.Message);
        }

        if (!reservation.Reserved || string.IsNullOrEmpty(reservation.ReservationId))
        {
            // A failed reservation leaves the order state unchanged: nothing is
            // committed and no reservation id is handed back.
            return Reject(
                tenantId,
                orderId,
                reservation.Detail ?? $"Inventory could not be reserved for order '{orderId}'.");
        }

        // The committer owns the database transaction; it is only invoked once
        // validation and reservation have both succeeded. A failed commit is
        // compensated by releasing the reservation so no inventory is leaked and
        // the request can be retried.
        var reservationId = reservation.ReservationId!;
        try
        {
            await committer.CommitAsync(normalized, reservation, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await ReleaseAsync(normalized, reservationId, CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        catch (Exception exception)
        {
            await ReleaseAsync(normalized, reservationId, CancellationToken.None).ConfigureAwait(false);
            audit.Record(new AuditRecord(tenantId, orderId, ActionName, OrderStatus.RolledBack.ToString(), DateTimeOffset.UtcNow));
            return new OrderResult(false, OrderStatus.RolledBack, reservationId, exception.Message);
        }

        // Audit is part of the success boundary: the completion marker is written
        // only after the required audit succeeds. An audit failure compensates the
        // reservation and reports the contract's rollback outcome instead of success.
        try
        {
            audit.Record(new AuditRecord(tenantId, orderId, ActionName, OrderStatus.Accepted.ToString(), DateTimeOffset.UtcNow));
        }
        catch (Exception exception)
        {
            await ReleaseAsync(normalized, reservationId, CancellationToken.None).ConfigureAwait(false);
            return new OrderResult(false, OrderStatus.RolledBack, reservationId, exception.Message);
        }

        idempotency.MarkCompleted(tenantId, operationId);
        return new OrderResult(true, OrderStatus.Accepted, reservationId);
    }

    private async Task ReleaseAsync(OrderRequest order, string reservationId, CancellationToken cancellationToken)
    {
        if (inventory is not IReservationLedger ledger)
        {
            return;
        }

        try
        {
            await ledger.ReleaseAsync(order.TenantId, reservationId, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // Compensation is best effort; the original failure is what is reported.
        }
    }

    private OrderResult Reject(string tenantId, string orderId, string detail)
    {
        audit.Record(new AuditRecord(tenantId, orderId, ActionName, OrderStatus.Rejected.ToString(), DateTimeOffset.UtcNow));
        return new OrderResult(false, OrderStatus.Rejected, null, detail);
    }
}
