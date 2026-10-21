namespace AssetUpgradeGateway.Application;

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;

public sealed class RequestNormalizer
{
    public AttachmentInput Normalize(AttachmentInput input)
    {
        ArgumentNullException.ThrowIfNull(input);

        return input with
        {
            FileName = input.FileName?.Trim() ?? string.Empty,
            DeclaredContentType = MimeCompatibilityPolicy.NormalizeContentType(input.DeclaredContentType),
        };
    }

    public OrderRequest Normalize(OrderRequest input)
    {
        ArgumentNullException.ThrowIfNull(input);

        var lines = (input.Lines ?? Array.Empty<OrderLine>())
            .Where(line => line is not null)
            .Select(line => line with { Sku = line.Sku?.Trim() ?? string.Empty })
            .ToArray();

        return input with
        {
            OrderId = input.OrderId?.Trim() ?? string.Empty,
            TenantId = input.TenantId?.Trim() ?? string.Empty,
            ActorId = input.ActorId?.Trim() ?? string.Empty,
            Currency = (input.Currency ?? string.Empty).Trim().ToUpperInvariant(),
            Lines = lines,
        };
    }

    public AssetEvent Normalize(AssetEvent input)
    {
        ArgumentNullException.ThrowIfNull(input);

        return input with
        {
            EventId = input.EventId?.Trim() ?? string.Empty,
            TenantId = input.TenantId?.Trim() ?? string.Empty,
            AssetId = input.AssetId?.Trim() ?? string.Empty,
            EventType = input.EventType?.Trim() ?? string.Empty,
            AttachmentId = string.IsNullOrWhiteSpace(input.AttachmentId) ? null : input.AttachmentId.Trim(),
        };
    }
}

public sealed class RequestFingerprint
{
    public string ForOrder(OrderRequest order)
    {
        ArgumentNullException.ThrowIfNull(order);
        return order.StableFingerprint();
    }

    public string ForEvent(AssetEvent assetEvent)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);

        var payload = string.Join(
            '\u001e',
            assetEvent.TenantId ?? string.Empty,
            assetEvent.EventId ?? string.Empty,
            assetEvent.AssetId ?? string.Empty,
            assetEvent.EventType ?? string.Empty,
            assetEvent.AttachmentId ?? string.Empty);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));
    }
}

public sealed class ErrorResponseFactory
{
    public IReadOnlyDictionary<string, object> Create(IEnumerable<ValidationIssue> issues, string correlationId)
    {
        var materialized = (issues ?? Array.Empty<ValidationIssue>())
            .Where(issue => issue is not null)
            .ToArray();

        var byCode = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var issue in materialized)
        {
            byCode[issue.Code] = issue.Message;
        }

        var descriptions = materialized
            .Select(issue => new Dictionary<string, object>
            {
                ["code"] = issue.Code,
                ["message"] = issue.Message,
                ["severity"] = issue.Severity.ToString(),
                ["blocking"] = issue.BlocksOperation,
            })
            .ToArray();

        return new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["correlationId"] = correlationId ?? string.Empty,
            ["allowed"] = materialized.All(issue => !issue.BlocksOperation),
            ["codes"] = materialized.Select(issue => issue.Code).ToArray(),
            ["errors"] = byCode,
            ["issues"] = descriptions,
        };
    }
}
