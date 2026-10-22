namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed class RequestNormalizer
{
    public AttachmentInput Normalize(AttachmentInput input)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public OrderRequest Normalize(OrderRequest input)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public AssetEvent Normalize(AssetEvent input)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class RequestFingerprint
{
    public string ForOrder(OrderRequest order)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public string ForEvent(AssetEvent assetEvent) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class ErrorResponseFactory
{
    public IReadOnlyDictionary<string, object> Create(IEnumerable<ValidationIssue> issues, string correlationId)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
