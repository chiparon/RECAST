namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using System.Text;

public sealed record AttachmentPolicyOptions(
    long MaximumBytes,
    IReadOnlySet<string> AllowedExtensions,
    IReadOnlySet<string> AllowedContentTypes,
    IReadOnlySet<string> BlockedFileNames,
    int MaximumNameLength,
    bool RequireScan)
{
    public static AttachmentPolicyOptions Default { get; } = new(
        0,
        new HashSet<string>(),
        new HashSet<string>(),
        new HashSet<string>(),
        0,
        false);
}

public sealed class FilenameSafetyPolicy
{
    private readonly AttachmentPolicyOptions? options;
    public FilenameSafetyPolicy(AttachmentPolicyOptions? options = null) => this.options = options;

    public PolicyResult Evaluate(string? fileName)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    public string Normalize(string fileName)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class MimeCompatibilityPolicy
{
    private readonly AttachmentPolicyOptions? options;
    public MimeCompatibilityPolicy(AttachmentPolicyOptions? options = null) => this.options = options;

    public PolicyResult Evaluate(string fileName, string contentType)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private static bool IsMismatch(string extension, string contentType)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AttachmentSizePolicy
{
    private readonly AttachmentPolicyOptions? options;
    public AttachmentSizePolicy(AttachmentPolicyOptions? options = null) => this.options = options;

    public PolicyResult Evaluate(long length)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class ContentSignaturePolicy
{
    public PolicyResult Evaluate(string fileName, ReadOnlySpan<byte> content)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private static bool LooksLikeText(ReadOnlySpan<byte> content)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class AttachmentValidationPipeline
{
    private readonly FilenameSafetyPolicy filename;
    private readonly MimeCompatibilityPolicy mime;
    private readonly AttachmentSizePolicy size;
    private readonly ContentSignaturePolicy signature;
    public AttachmentValidationPipeline(AttachmentPolicyOptions? options = null)
    {
        filename = new(options); mime = new(options); size = new(options); signature = new();
    }
    public PolicyResult Evaluate(AttachmentInput attachment)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
    private static void Add(List<ValidationIssue> target, PolicyResult result) { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}

public sealed class TenantAttachmentPolicy
{
    public PolicyResult Evaluate(TenantScope scope, AttachmentInput attachment, string operation)
    { throw new global::System.NotImplementedException("Implementation belongs to the evaluated Agent."); }
}
