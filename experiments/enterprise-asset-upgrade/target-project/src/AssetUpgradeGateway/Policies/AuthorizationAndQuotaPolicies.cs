namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;

public sealed record QuotaSnapshot(string TenantId, long BytesUsed, int AttachmentsUsed, int EventsUsed, DateTimeOffset WindowStarted);

public sealed class TenantQuotaPolicy
{
    private readonly long byteLimit;
    private readonly int attachmentLimit;
    private readonly int eventLimit;
    public TenantQuotaPolicy(long byteLimit = 0, int attachmentLimit = 0, int eventLimit = 0) { this.byteLimit = byteLimit; this.attachmentLimit = attachmentLimit; this.eventLimit = eventLimit; }
    public PolicyResult Evaluate(QuotaSnapshot usage, AttachmentInput? attachment, bool eventCreated)
    {
        if (usage is null)
        {
            return PolicyResult.Deny(Error("quota.usage.required", "Quota usage is required."));
        }

        var issues = new List<ValidationIssue>();

        if (attachment is not null
            && !string.Equals(attachment.TenantId, usage.TenantId, StringComparison.Ordinal))
        {
            issues.Add(Error(
                "quota.tenant.mismatch",
                $"Attachment tenant '{attachment.TenantId}' does not match quota tenant '{usage.TenantId}'."));
        }

        var bytes = usage.BytesUsed + (attachment?.Content.Length ?? 0);
        var attachments = usage.AttachmentsUsed + (attachment is null ? 0 : 1);
        var events = usage.EventsUsed + (eventCreated ? 1 : 0);

        if (byteLimit > 0 && bytes > byteLimit)
        {
            issues.Add(Error("quota.bytes", $"Byte usage {bytes} exceeds limit {byteLimit}."));
        }

        if (attachmentLimit > 0 && attachments > attachmentLimit)
        {
            issues.Add(Error("quota.attachments", $"Attachment count {attachments} exceeds limit {attachmentLimit}."));
        }

        if (eventLimit > 0 && events > eventLimit)
        {
            issues.Add(Error("quota.events", $"Event count {events} exceeds limit {eventLimit}."));
        }

        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    public bool IsWithin(QuotaSnapshot usage) => Evaluate(usage, null, false).Allowed;

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class ActorPermissionPolicy
{
    private static readonly IReadOnlySet<string> AdministratorRoles =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "administrator", "admin", "owner" };

    public PolicyResult Evaluate(TenantScope scope, string operation)
    {
        if (scope is null)
        {
            return PolicyResult.Deny(Error("auth.scope.required", "A tenant scope is required."));
        }

        if (scope.IsExpired(DateTimeOffset.UtcNow))
        {
            return PolicyResult.Deny(Error("auth.expired", $"Tenant scope for '{scope.TenantId}' has expired."));
        }

        if (!scope.Can(operation) && !HasAdministratorRole(scope))
        {
            return PolicyResult.Deny(Error(
                "auth.forbidden",
                $"Actor '{scope.ActorId}' lacks permission '{operation}'."));
        }

        return PolicyResult.Allow();
    }

    private static bool HasAdministratorRole(TenantScope scope)
    {
        foreach (var role in AdministratorRoles)
        {
            if (scope.HasRole(role))
            {
                return true;
            }
        }

        return false;
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class ResourceOwnershipPolicy
{
    public PolicyResult Evaluate(string tenantId, string resourceTenantId, string resourceId)
    {
        if (string.IsNullOrWhiteSpace(resourceId))
        {
            return PolicyResult.Deny(Error("ownership.resource", "A resource identifier is required."));
        }

        if (!string.Equals(tenantId, resourceTenantId, StringComparison.Ordinal))
        {
            return PolicyResult.Deny(Error(
                "ownership.tenant",
                $"Tenant '{tenantId}' cannot access resource '{resourceId}' owned by tenant '{resourceTenantId}'."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class EventAgePolicy
{
    private readonly TimeSpan? maximumAge;
    public EventAgePolicy(TimeSpan? maximumAge = null) => this.maximumAge = maximumAge;
    public PolicyResult Evaluate(AssetEvent assetEvent, DateTimeOffset now)
    {
        if (assetEvent is null)
        {
            return PolicyResult.Deny(Error("event.required", "An event is required."));
        }

        if (maximumAge is null)
        {
            return PolicyResult.Allow();
        }

        var age = now - assetEvent.CreatedAt;
        if (age > maximumAge.Value)
        {
            return PolicyResult.Deny(Error(
                "event.age",
                $"Event '{assetEvent.EventId}' age {age} exceeds maximum {maximumAge.Value}."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class BatchSizePolicy
{
    public PolicyResult Evaluate<T>(IReadOnlyCollection<T> items, int maximum, string code)
    {
        if (items is null)
        {
            return PolicyResult.Deny(Error(code, "Batch items are required."));
        }

        if (items.Count > maximum)
        {
            return PolicyResult.Deny(Error(code, $"Batch size {items.Count} exceeds maximum {maximum}."));
        }

        return PolicyResult.Allow();
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}

public sealed class HeaderPolicy
{
    private readonly IReadOnlySet<string>? allowed;
    public HeaderPolicy(IEnumerable<string>? allowed = null) => this.allowed = allowed is null ? null : new HashSet<string>(allowed, StringComparer.OrdinalIgnoreCase);
    public PolicyResult Evaluate(IReadOnlyDictionary<string, string> headers)
    {
        if (headers is null)
        {
            return PolicyResult.Deny(Error("header.missing", "Headers are required."));
        }

        var issues = new List<ValidationIssue>();

        foreach (var header in headers)
        {
            var name = header.Key;
            if (string.IsNullOrWhiteSpace(name))
            {
                issues.Add(Error("header.name.empty", "Header names must not be empty."));
                continue;
            }

            if (name.IndexOf('\0') >= 0)
            {
                issues.Add(Error("header.name.invalid", $"Header '{name}' contains an invalid NUL character."));
                continue;
            }

            if (allowed is not null && !allowed.Contains(name))
            {
                issues.Add(Error("header.name.not_allowed", $"Header '{name}' is not in the allowed header list."));
            }
        }

        return new PolicyResult(issues.All(issue => !issue.BlocksOperation), issues);
    }

    private static ValidationIssue Error(string code, string message)
        => new(code, message, ValidationSeverity.Error);
}
