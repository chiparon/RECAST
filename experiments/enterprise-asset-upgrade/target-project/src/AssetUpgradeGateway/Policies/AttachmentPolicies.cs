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
        10L * 1024 * 1024,
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".pdf", ".png", ".jpg", ".jpeg", ".txt" },
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "application/pdf", "image/png", "image/jpeg", "text/plain" },
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".", ".." },
        255,
        false);
}

public sealed class FilenameSafetyPolicy
{
    private readonly AttachmentPolicyOptions? options;
    public FilenameSafetyPolicy(AttachmentPolicyOptions? options = null) => this.options = options;

    private AttachmentPolicyOptions Options => options ?? AttachmentPolicyOptions.Default;

    public PolicyResult Evaluate(string? fileName)
    {
        var current = Options;

        if (string.IsNullOrWhiteSpace(fileName))
        {
            return PolicyResult.Deny(Error("attachment.filename.empty", "A file name is required."));
        }

        var raw = fileName!;
        if (raw.IndexOf('\0') >= 0 || HasControlCharacters(raw))
        {
            return PolicyResult.Deny(Error("attachment.filename.invalid", "File name must not contain control characters."));
        }

        if (raw.IndexOf('/') >= 0 || raw.IndexOf('\\') >= 0)
        {
            return PolicyResult.Deny(Error("attachment.filename.path", "File name must not contain a path separator."));
        }

        var normalized = Normalize(raw);
        if (normalized.Length == 0)
        {
            return PolicyResult.Deny(Error("attachment.filename.empty", "A file name is required."));
        }

        if (normalized is "." or "..")
        {
            return PolicyResult.Deny(Error("attachment.filename.unsafe", $"File name '{normalized}' is not allowed."));
        }

        if (current.MaximumNameLength > 0 && normalized.Length > current.MaximumNameLength)
        {
            return PolicyResult.Deny(Error(
                "attachment.filename.too_long",
                $"File name length {normalized.Length} exceeds maximum {current.MaximumNameLength}."));
        }

        if (current.BlockedFileNames.Count > 0 && ContainsName(current.BlockedFileNames, normalized))
        {
            return PolicyResult.Deny(Error("attachment.filename.blocked", $"File name '{normalized}' is blocked."));
        }

        if (current.AllowedExtensions.Count > 0)
        {
            var extension = ExtensionOf(normalized);
            if (extension.Length == 0 || !ContainsExtension(current.AllowedExtensions, extension))
            {
                return PolicyResult.Deny(Error(
                    "attachment.filename.extension",
                    $"File extension '.{extension}' is not allowed for '{normalized}'."));
            }
        }

        return PolicyResult.Allow();
    }

    public string Normalize(string fileName)
    {
        if (string.IsNullOrEmpty(fileName))
        {
            return string.Empty;
        }

        var replaced = fileName.Replace('\\', '/');
        var lastSeparator = replaced.LastIndexOf('/');
        if (lastSeparator >= 0)
        {
            replaced = replaced[(lastSeparator + 1)..];
        }

        var builder = new StringBuilder(replaced.Length);
        foreach (var character in replaced)
        {
            if (!char.IsControl(character))
            {
                builder.Append(character);
            }
        }

        return builder.ToString().Trim();
    }

    internal static string ExtensionOf(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return string.Empty;
        }

        var name = fileName.Replace('\\', '/');
        var lastSeparator = name.LastIndexOf('/');
        if (lastSeparator >= 0)
        {
            name = name[(lastSeparator + 1)..];
        }

        var dot = name.LastIndexOf('.');
        if (dot < 0 || dot == name.Length - 1)
        {
            return string.Empty;
        }

        return name[(dot + 1)..].Trim().ToLowerInvariant();
    }

    internal static bool ContainsExtension(IReadOnlySet<string> allowed, string extension)
    {
        foreach (var candidate in allowed)
        {
            var normalized = (candidate ?? string.Empty).Trim().TrimStart('.');
            if (normalized.Length > 0 && string.Equals(normalized, extension, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    internal static bool ContainsName(IReadOnlySet<string> names, string name)
    {
        foreach (var candidate in names)
        {
            if (string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasControlCharacters(string value)
    {
        foreach (var character in value)
        {
            if (char.IsControl(character))
            {
                return true;
            }
        }

        return false;
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class MimeCompatibilityPolicy
{
    private readonly AttachmentPolicyOptions? options;
    public MimeCompatibilityPolicy(AttachmentPolicyOptions? options = null) => this.options = options;

    private AttachmentPolicyOptions Options => options ?? AttachmentPolicyOptions.Default;

    private static readonly IReadOnlyDictionary<string, string[]> ExtensionsByContentType =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["application/pdf"] = new[] { "pdf" },
            ["image/png"] = new[] { "png" },
            ["image/jpeg"] = new[] { "jpg", "jpeg" },
            ["image/jpg"] = new[] { "jpg", "jpeg" },
            ["image/gif"] = new[] { "gif" },
            ["image/bmp"] = new[] { "bmp" },
            ["image/webp"] = new[] { "webp" },
            ["text/plain"] = new[] { "txt", "text", "log", "md" },
            ["text/csv"] = new[] { "csv" },
            ["application/json"] = new[] { "json" },
            ["application/xml"] = new[] { "xml" },
            ["text/xml"] = new[] { "xml" },
            ["application/zip"] = new[] { "zip" },
            ["application/x-zip-compressed"] = new[] { "zip" },
        };

    public PolicyResult Evaluate(string fileName, string contentType)
    {
        var normalizedType = NormalizeContentType(contentType);
        if (normalizedType.Length == 0)
        {
            return PolicyResult.Deny(Error("attachment.mime.missing", "A declared content type is required."));
        }

        var current = Options;
        if (current.AllowedContentTypes.Count > 0 && !AllowsContentType(current.AllowedContentTypes, normalizedType))
        {
            return PolicyResult.Deny(Error(
                "attachment.mime.unsupported",
                $"Content type '{normalizedType}' is not allowed."));
        }

        var extension = FilenameSafetyPolicy.ExtensionOf(fileName);
        if (IsMismatch(extension, normalizedType))
        {
            return PolicyResult.Deny(Error(
                "attachment.mime.mismatch",
                $"Content type '{normalizedType}' does not match file extension '.{extension}'."));
        }

        return PolicyResult.Allow();
    }

    private static bool IsMismatch(string extension, string contentType)
    {
        var normalizedType = NormalizeContentType(contentType);
        if (!ExtensionsByContentType.TryGetValue(normalizedType, out var extensions) || extensions.Length == 0)
        {
            return false;
        }

        if (extension.Length == 0)
        {
            return true;
        }

        foreach (var candidate in extensions)
        {
            if (string.Equals(candidate, extension, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return true;
    }

    internal static string NormalizeContentType(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType))
        {
            return string.Empty;
        }

        var value = contentType.Trim();
        var separator = value.IndexOf(';');
        if (separator >= 0)
        {
            value = value[..separator];
        }

        return value.Trim().ToLowerInvariant();
    }

    private static bool AllowsContentType(IReadOnlySet<string> allowed, string contentType)
    {
        foreach (var candidate in allowed)
        {
            var normalized = NormalizeContentType(candidate);
            if (normalized.Length == 0)
            {
                continue;
            }

            if (normalized is "*/*" or "*")
            {
                return true;
            }

            if (string.Equals(normalized, contentType, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (normalized.EndsWith("/*", StringComparison.Ordinal)
                && contentType.StartsWith(normalized[..^1], StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class AttachmentSizePolicy
{
    private readonly AttachmentPolicyOptions? options;
    public AttachmentSizePolicy(AttachmentPolicyOptions? options = null) => this.options = options;

    private AttachmentPolicyOptions Options => options ?? AttachmentPolicyOptions.Default;

    public PolicyResult Evaluate(long length)
    {
        if (length < 0)
        {
            return PolicyResult.Deny(Error("attachment.size.negative", "Attachment length cannot be negative."));
        }

        var maximum = Options.MaximumBytes;
        if (maximum > 0 && length > maximum)
        {
            return PolicyResult.Deny(Error(
                "attachment.size.exceeded",
                $"Attachment length {length} exceeds maximum {maximum}."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class ContentSignaturePolicy
{
    private static readonly (string[] Extensions, byte[] Prefix)[] Signatures =
    {
        (new[] { "pdf" }, new byte[] { 0x25, 0x50, 0x44, 0x46 }),
        (new[] { "png" }, new byte[] { 0x89, 0x50, 0x4E, 0x47 }),
        (new[] { "jpg", "jpeg" }, new byte[] { 0xFF, 0xD8, 0xFF }),
        (new[] { "gif" }, new byte[] { 0x47, 0x49, 0x46, 0x38 }),
        (new[] { "bmp" }, new byte[] { 0x42, 0x4D }),
        (new[] { "zip", "docx", "xlsx", "pptx" }, new byte[] { 0x50, 0x4B, 0x03, 0x04 }),
        (new[] { "zip" }, new byte[] { 0x50, 0x4B, 0x05, 0x06 }),
        (new[] { "zip" }, new byte[] { 0x50, 0x4B, 0x07, 0x08 }),
    };

    public PolicyResult Evaluate(string fileName, ReadOnlySpan<byte> content)
    {
        if (content.Length == 0)
        {
            return PolicyResult.Allow();
        }

        var extension = FilenameSafetyPolicy.ExtensionOf(fileName);

        foreach (var signature in Signatures)
        {
            if (StartsWith(content, signature.Prefix))
            {
                return AllowsExtension(signature.Extensions, extension)
                    ? PolicyResult.Allow()
                    : PolicyResult.Deny(Error(
                        "attachment.signature.mismatch",
                        $"Content signature does not match file extension '.{extension}'."));
            }
        }

        if (LooksLikeText(content))
        {
            return IsKnownFormatExtension(extension)
                ? PolicyResult.Deny(Error(
                    "attachment.signature.mismatch",
                    $"Text content does not match the declared binary extension '.{extension}'."))
                : PolicyResult.Allow();
        }

        return IsKnownFormatExtension(extension)
            ? PolicyResult.Deny(Error(
                "attachment.signature.mismatch",
                $"Content does not match the declared format for '.{extension}'."))
            : PolicyResult.Allow();
    }

    private static bool LooksLikeText(ReadOnlySpan<byte> content)
    {
        if (content.Length == 0)
        {
            return true;
        }

        foreach (var value in content)
        {
            if (value is 0x09 or 0x0A or 0x0D)
            {
                continue;
            }

            if (value < 0x20 || value > 0x7E)
            {
                return false;
            }
        }

        return true;
    }

    private static bool StartsWith(ReadOnlySpan<byte> content, byte[] prefix)
    {
        if (content.Length < prefix.Length)
        {
            return false;
        }

        for (var index = 0; index < prefix.Length; index++)
        {
            if (content[index] != prefix[index])
            {
                return false;
            }
        }

        return true;
    }

    private static bool AllowsExtension(string[] extensions, string extension)
    {
        if (extension.Length == 0)
        {
            return false;
        }

        foreach (var candidate in extensions)
        {
            if (string.Equals(candidate, extension, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsKnownFormatExtension(string extension)
    {
        if (extension.Length == 0)
        {
            return false;
        }

        foreach (var signature in Signatures)
        {
            if (AllowsExtension(signature.Extensions, extension))
            {
                return true;
            }
        }

        return false;
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
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
    {
        ArgumentNullException.ThrowIfNull(attachment);

        var issues = new List<ValidationIssue>();
        Add(issues, filename.Evaluate(attachment.FileName));
        Add(issues, mime.Evaluate(attachment.FileName, attachment.DeclaredContentType));
        Add(issues, size.Evaluate(attachment.Content.Length));
        Add(issues, signature.Evaluate(attachment.FileName, attachment.Content.Span));

        var allowed = issues.All(issue => !issue.BlocksOperation);
        return new PolicyResult(allowed, issues);
    }

    private static void Add(List<ValidationIssue> target, PolicyResult result)
    {
        if (result?.Issues is null)
        {
            return;
        }

        foreach (var issue in result.Issues)
        {
            target.Add(issue);
        }
    }
}

public sealed class TenantAttachmentPolicy
{
    public PolicyResult Evaluate(TenantScope scope, AttachmentInput attachment, string operation)
    {
        if (scope is null)
        {
            return PolicyResult.Deny(Error("attachment.scope.required", "A tenant scope is required."));
        }

        if (attachment is null)
        {
            return PolicyResult.Deny(Error("attachment.required", "An attachment is required."));
        }

        if (!string.Equals(scope.TenantId, attachment.TenantId, StringComparison.Ordinal))
        {
            return PolicyResult.Deny(Error(
                "attachment.tenant.mismatch",
                $"Tenant '{scope.TenantId}' cannot access attachment '{attachment.AttachmentId}' owned by tenant '{attachment.TenantId}'."));
        }

        if (scope.IsExpired(DateTimeOffset.UtcNow))
        {
            return PolicyResult.Deny(Error(
                "attachment.scope.expired",
                $"Tenant scope for '{scope.TenantId}' has expired."));
        }

        if (!attachment.Scanned)
        {
            return PolicyResult.Deny(Error(
                "attachment.quarantined",
                $"Attachment '{attachment.AttachmentId}' has not passed scanning and remains quarantined for operation '{operation}'."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}
