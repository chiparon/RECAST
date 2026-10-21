namespace AssetUpgradeGateway.Application;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Ports;
using AssetUpgradeGateway.Telemetry;

public sealed record AttachmentIntakeCommand(string TenantId, string ActorId, AttachmentInput Attachment, string CorrelationId);
public sealed record AttachmentIntakeResult(bool Accepted, AttachmentState State, IReadOnlyList<ValidationIssue> Issues, string? Fingerprint = null);

public sealed class AttachmentIntakeService
{
    private readonly ITenantAuthorizer authorizer;
    private readonly IAttachmentRepository repository;
    private readonly IAttachmentScanner scanner;
    private readonly IQuarantineLog quarantine;
    private readonly IAuditSink audit;
    private readonly IMetricsSink metrics;
    private readonly AttachmentValidationPipeline validation;
    private readonly IClock clock;
    private readonly TraceFactory? traces;

    public AttachmentIntakeService(ITenantAuthorizer authorizer, IAttachmentRepository repository, IAttachmentScanner scanner, IQuarantineLog quarantine, IAuditSink audit, IMetricsSink metrics, IClock? clock = null, AttachmentValidationPipeline? validation = null, TraceFactory? traces = null)
    {
        this.authorizer = authorizer; this.repository = repository; this.scanner = scanner; this.quarantine = quarantine; this.audit = TelemetryHealthComposition.Decorate(audit, metrics); this.metrics = metrics; this.clock = clock ?? new SystemClock(); this.validation = validation ?? new AttachmentValidationPipeline(); this.traces = traces;
    }

    public async Task<AttachmentIntakeResult> IntakeAsync(AttachmentIntakeCommand command, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        var started = clock.UtcNow;
        using var scope = traces?.Start(command.CorrelationId, "attachment.intake", command.TenantId, command.ActorId);

        if (command.Attachment is null)
        {
            return Reject(
                command,
                new ValidationIssue("attachment.required", "An attachment is required.", ValidationSeverity.Error),
                started,
                scope);
        }

        if (!authorizer.CanAccess(command.TenantId, command.ActorId))
        {
            return Reject(
                command,
                new ValidationIssue(
                    "attachment.unauthorized",
                    $"Actor '{command.ActorId}' is not authorized for tenant '{command.TenantId}'.",
                    ValidationSeverity.Error),
                started,
                scope);
        }

        if (!string.Equals(command.Attachment.TenantId, command.TenantId, StringComparison.Ordinal))
        {
            return Reject(
                command,
                new ValidationIssue(
                    "attachment.tenant.mismatch",
                    $"Attachment '{command.Attachment.AttachmentId}' belongs to tenant '{command.Attachment.TenantId}' and not to '{command.TenantId}'.",
                    ValidationSeverity.Error),
                started,
                scope);
        }

        var policy = validation.Evaluate(command.Attachment);
        if (!policy.Allowed)
        {
            await quarantine.RecordAsync(command.TenantId, command.Attachment.AttachmentId, policy.Issues, cancellationToken).ConfigureAwait(false);
            await repository.SaveAsync(command.Attachment with { Scanned = false }, cancellationToken).ConfigureAwait(false);

            var blocking = policy.Issues.FirstOrDefault(issue => issue.BlocksOperation)
                ?? policy.Issues.FirstOrDefault()
                ?? new ValidationIssue("attachment.invalid", "The attachment failed validation.", ValidationSeverity.Error);

            return Reject(command, blocking, started, scope);
        }

        AttachmentScanResult scan;
        try
        {
            scan = await scanner.ScanAsync(command.Attachment, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            scan = new AttachmentScanResult(command.Attachment.AttachmentId, false, "unavailable", clock.UtcNow, exception.Message);
        }

        var fingerprint = command.Attachment.StableFingerprint();
        scope?.AddTag("attachmentId", command.Attachment.AttachmentId);
        scope?.AddTag("fingerprint", fingerprint);
        scope?.AddTag("scan", scan.Clean ? "Clean" : "Quarantined");

        if (!scan.Clean)
        {
            var issue = new ValidationIssue(
                "attachment.scan.failed",
                scan.Detail ?? $"Attachment '{command.Attachment.AttachmentId}' did not pass scanning and remains quarantined.",
                ValidationSeverity.Error);

            await quarantine.RecordAsync(command.TenantId, command.Attachment.AttachmentId, new[] { issue }, cancellationToken).ConfigureAwait(false);
            await repository.SaveAsync(command.Attachment with { Scanned = false }, cancellationToken).ConfigureAwait(false);

            metrics.Increment("attachment.quarantined", command.TenantId);
            audit.Record(new AuditRecord(
                command.TenantId,
                command.Attachment.AttachmentId,
                "attachment.intake",
                AttachmentState.Quarantined.ToString(),
                clock.UtcNow));

            scope?.AddTag("state", AttachmentState.Quarantined.ToString());
            scope?.MarkFailed(issue.Code);
            return new AttachmentIntakeResult(false, AttachmentState.Quarantined, new[] { issue }, fingerprint);
        }

        var accepted = command.Attachment with { Scanned = true };
        await repository.SaveAsync(accepted, cancellationToken).ConfigureAwait(false);

        metrics.Increment("attachment.accepted", command.TenantId);
        metrics.Timing("attachment.intake", command.TenantId, clock.UtcNow - started);
        audit.Record(new AuditRecord(
            command.TenantId,
            command.Attachment.AttachmentId,
            "attachment.intake",
            AttachmentState.Scanned.ToString(),
            clock.UtcNow));

        scope?.AddTag("state", AttachmentState.Scanned.ToString());
        return new AttachmentIntakeResult(true, AttachmentState.Scanned, Array.Empty<ValidationIssue>(), fingerprint);
    }

    private AttachmentIntakeResult Reject(AttachmentIntakeCommand command, ValidationIssue issue, DateTimeOffset started, TraceScope? scope)
    {
        var attachmentId = command.Attachment?.AttachmentId ?? string.Empty;
        scope?.AddTag("attachmentId", attachmentId);
        var fingerprint = command.Attachment?.StableFingerprint();
        if (fingerprint is not null)
        {
            scope?.AddTag("fingerprint", fingerprint);
        }

        scope?.AddTag("state", AttachmentState.Rejected.ToString());
        scope?.MarkFailed(issue.Code);

        metrics.Increment("attachment.rejected", command.TenantId);
        metrics.Timing("attachment.intake", command.TenantId, clock.UtcNow - started);
        audit.Record(new AuditRecord(
            command.TenantId,
            attachmentId,
            "attachment.intake",
            AttachmentState.Rejected.ToString(),
            clock.UtcNow));

        return new AttachmentIntakeResult(false, AttachmentState.Rejected, new[] { issue }, fingerprint);
    }
}

public sealed class AttachmentQueryService
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    public AttachmentQueryService(IAttachmentRepository repository, ITenantAuthorizer authorizer) { this.repository = repository; this.authorizer = authorizer; }

    public async Task<AttachmentInput?> GetAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            return null;
        }

        return await repository.FindAsync(tenantId, attachmentId, cancellationToken).ConfigureAwait(false);
    }
}

public sealed class AttachmentReleaser
{
    private readonly IAttachmentRepository repository;
    private readonly ITenantAuthorizer authorizer;
    private readonly IAuditSink audit;
    public AttachmentReleaser(IAttachmentRepository repository, ITenantAuthorizer authorizer, IAuditSink audit) { this.repository = repository; this.authorizer = authorizer; this.audit = audit; }

    public async Task ReleaseAsync(string tenantId, string actorId, string attachmentId, CancellationToken cancellationToken = default)
    {
        if (!authorizer.CanAccess(tenantId, actorId))
        {
            throw new UnauthorizedAccessException(
                $"Actor '{actorId}' is not authorized for tenant '{tenantId}'.");
        }

        var attachment = await repository.FindAsync(tenantId, attachmentId, cancellationToken).ConfigureAwait(false);
        if (attachment is null)
        {
            return;
        }

        await repository.ReleaseAsync(tenantId, attachmentId, cancellationToken).ConfigureAwait(false);
        audit.Record(new AuditRecord(tenantId, attachmentId, "attachment.release", AttachmentState.Released.ToString(), DateTimeOffset.UtcNow));
    }
}
