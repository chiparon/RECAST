namespace AssetUpgradeGateway.Domain;

using AssetUpgradeGateway;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

public static class DomainExtensions
{
    public static bool ContainsAll(this InventoryReservation reservation, IReadOnlyList<OrderLine> lines)
    {
        if (lines.Count == 0)
        {
            return true;
        }

        foreach (var line in lines)
        {
            if (!reservation.Contains(line.Sku, line.Quantity))
            {
                return false;
            }
        }

        return true;
    }
    public static bool IsTerminal(this WorkflowState state)
        => state is WorkflowState.Completed or WorkflowState.Failed;
    public static bool IsTerminal(this EventProcessingStage stage)
        => stage is EventProcessingStage.Delivered
            or EventProcessingStage.DeadLettered
            or EventProcessingStage.Completed;
    public static long MerchandiseTotal(this OrderRequest order)
    {
        long total = 0;
        foreach (var line in order.Lines)
        {
            total += (long)line.Quantity * line.UnitPriceMinor;
        }

        return total;
    }
    public static string StableFingerprint(this AttachmentInput attachment)
    {
        var content = attachment.Content.Span;
        var prefix = Encoding.UTF8.GetBytes(
            $"{attachment.TenantId}\u001f{attachment.AttachmentId}\u001f{attachment.FileName}\u001f{attachment.DeclaredContentType}\u001f");

        var buffer = new byte[prefix.Length + content.Length];
        prefix.CopyTo(buffer.AsSpan(0, prefix.Length));
        content.CopyTo(buffer.AsSpan(prefix.Length));

        return Convert.ToHexString(SHA256.HashData(buffer));
    }

    /// <summary>
    /// Deterministic fingerprint for an order request. Equivalent requests map
    /// to a single logical operation regardless of line ordering or the
    /// randomness used by a historical GUID-based duplicate guard.
    /// </summary>
    public static string StableFingerprint(this OrderRequest order)
    {
        ArgumentNullException.ThrowIfNull(order);

        const char separator = '\u001f';
        const char fieldSeparator = '\u001e';

        var builder = new StringBuilder();
        builder.Append(order.OrderId).Append(separator);
        builder.Append(order.TenantId).Append(separator);
        builder.Append(order.ActorId).Append(separator);
        builder.Append(order.Currency).Append(separator);

        var lines = order.Lines ?? Array.Empty<OrderLine>();
        foreach (var line in lines
            .OrderBy(candidate => candidate.Sku, StringComparer.Ordinal)
            .ThenBy(candidate => candidate.Quantity)
            .ThenBy(candidate => candidate.UnitPriceMinor))
        {
            builder.Append(line.Sku).Append(fieldSeparator);
            builder.Append(line.Quantity.ToString(CultureInfo.InvariantCulture)).Append(fieldSeparator);
            builder.Append(line.UnitPriceMinor.ToString(CultureInfo.InvariantCulture)).Append(separator);
        }

        var payload = Encoding.UTF8.GetBytes(builder.ToString());
        return Convert.ToHexString(SHA256.HashData(payload));
    }

    public static AssetEvent WithState(this AssetEvent assetEvent, WorkflowState state)
        => assetEvent with { State = state };
}
