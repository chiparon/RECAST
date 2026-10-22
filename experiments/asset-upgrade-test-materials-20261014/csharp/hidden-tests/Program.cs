using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using AssetUpgradeGateway;

const string TenantA = "tenant-a";
const string TenantB = "tenant-b";
const string ActorA = "actor-a";
const string ActorB = "actor-b";

var arguments = ParseArguments(args);
var output = arguments.TryGetValue("output", out var outputPath)
    ? outputPath
    : Path.Combine(Environment.CurrentDirectory, "hidden-evaluation.json");
var jsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};

var cases = new[]
{
    new AcceptanceCase("attachment-quarantine", "tenant-owner", "An attachment from another tenant is rejected before dispatch.", AttachmentTenantOwner),
    new AcceptanceCase("attachment-quarantine", "file-safety", "Unsafe names and oversized attachments are quarantined and never dispatched.", AttachmentFileSafety),
    new AcceptanceCase("attachment-quarantine", "quarantine-gate", "An unscanned attachment cannot enter the approval workflow.", AttachmentQuarantineGate),
    new AcceptanceCase("attachment-quarantine", "content-signature", "A declared MIME type that disagrees with content is quarantined.", AttachmentContentSignature),
    new AcceptanceCase("attachment-quarantine", "duplicate-event", "Repeated submission of one event has one dispatch side effect.", AttachmentDuplicateEvent),

    new AcceptanceCase("workflow-event-delivery", "permission-state", "Only an authorized actor may dispatch an approved event.", WorkflowPermissionAndState),
    new AcceptanceCase("workflow-event-delivery", "retry", "A transport failure remains retryable.", WorkflowRetryableFailure),
    new AcceptanceCase("workflow-event-delivery", "retry-success-once", "A successful retry completes the event exactly once.", WorkflowRetrySuccessOnce),
    new AcceptanceCase("workflow-event-delivery", "duplicate-side-effect", "A completed event cannot produce a second dispatch side effect.", WorkflowDuplicateSideEffect),
    new AcceptanceCase("workflow-event-delivery", "audit", "The final workflow audit contains the event identity and status.", WorkflowAudit),
    new AcceptanceCase("workflow-event-delivery", "dispatch-exception", "A dispatcher exception remains retryable instead of escaping the submission call.", WorkflowDispatchException, "quality"),

    new AcceptanceCase("scheduled-reconciliation", "due-retryable", "Reconciliation queries the due window and ignores non-retryable events.", ReconciliationDueRetryable),
    new AcceptanceCase("scheduled-reconciliation", "tenant-isolation", "Events from a tenant outside the actor scope are not touched.", ReconciliationTenantIsolation),
    new AcceptanceCase("scheduled-reconciliation", "idempotent-rescan", "Scanning the same pending event twice dispatches it once.", ReconciliationIdempotentRescan),
    new AcceptanceCase("scheduled-reconciliation", "failure-rerun", "A failed compensation can be retried successfully on a later run.", ReconciliationFailureRerun),
    new AcceptanceCase("scheduled-reconciliation", "audit", "An empty reconciliation run still leaves a traceable audit record.", ReconciliationAudit),
    new AcceptanceCase("scheduled-reconciliation", "dispatch-exception", "A dispatcher exception is recorded as a retryable run failure instead of escaping the run.", ReconciliationDispatchException, "quality"),

    new AcceptanceCase("order-plugin-bridge", "incomplete-no-inventory", "Invalid order input does not reserve inventory.", OrderIncompleteNoInventory),
    new AcceptanceCase("order-plugin-bridge", "reservation-failure", "A failed reservation does not commit an order or mark it complete.", OrderReservationFailure),
    new AcceptanceCase("order-plugin-bridge", "atomic-success-audit", "A successful order commits, marks idempotency, and records audit evidence.", OrderAtomicSuccess),
    new AcceptanceCase("order-plugin-bridge", "duplicate-no-reserve", "A repeated order does not reserve inventory a second time.", OrderDuplicateNoReserve),
    new AcceptanceCase("order-plugin-bridge", "port-abstraction", "The order bridge depends on ports rather than concrete infrastructure types.", OrderPortAbstraction),
    new AcceptanceCase("order-plugin-bridge", "commit-rollback", "A commit exception returns a rollback result and does not mark the order complete.", OrderCommitRollback, "quality"),
    new AcceptanceCase("order-plugin-bridge", "audit-failure", "An audit failure cannot leave the order reported as successfully completed.", OrderAuditFailure, "quality"),
};

var results = new List<CaseResult>(cases.Length);
foreach (var testCase in cases)
{
    try
    {
        await testCase.Run();
        results.Add(new(testCase.TaskId, testCase.ConditionId, testCase.Category, testCase.Description, true, null));
    }
    catch (Exception exception)
    {
        results.Add(new(testCase.TaskId, testCase.ConditionId, testCase.Category, testCase.Description, false, exception.Message));
    }
}

var taskReports = results
    .GroupBy(result => result.TaskId, StringComparer.Ordinal)
    .OrderBy(group => group.Key, StringComparer.Ordinal)
    .Select(group => new TaskReport(group.Key, group.Count(result => result.Passed), group.Count(), group.All(result => result.Passed)))
    .ToArray();

var report = new EvaluationReport(
    SchemaVersion: 1,
    Evaluator: "enterprise-asset-upgrade-hidden",
    TargetProject: arguments.GetValueOrDefault("target"),
    GeneratedAt: DateTimeOffset.UtcNow,
    Total: results.Count,
    Passed: results.Count(result => result.Passed),
    Failed: results.Count(result => !result.Passed),
    Score: results.Count == 0 ? 0 : results.Count(result => result.Passed) / (double)results.Count,
    RequirementTotal: results.Count(result => result.Category == "requirement"),
    RequirementPassed: results.Count(result => result.Category == "requirement" && result.Passed),
    QualityTotal: results.Count(result => result.Category == "quality"),
    QualityPassed: results.Count(result => result.Category == "quality" && result.Passed),
    Tasks: taskReports,
    Cases: results);

var outputDirectory = Path.GetDirectoryName(Path.GetFullPath(output));
if (!string.IsNullOrEmpty(outputDirectory)) Directory.CreateDirectory(outputDirectory);
await File.WriteAllTextAsync(output, JsonSerializer.Serialize(report, jsonOptions));

Console.WriteLine($"Hidden acceptance: {report.Passed}/{report.Total} passed ({report.Score:P0})");
Console.WriteLine($"  requirements: {report.RequirementPassed}/{report.RequirementTotal} ({Ratio(report.RequirementPassed, report.RequirementTotal):P0})");
Console.WriteLine($"  quality guards: {report.QualityPassed}/{report.QualityTotal} ({Ratio(report.QualityPassed, report.QualityTotal):P0})");
foreach (var task in taskReports)
    Console.WriteLine($"  {task.TaskId}: {task.Passed}/{task.Total}");
Console.WriteLine($"Report: {Path.GetFullPath(output)}");
return report.Failed == 0 ? 0 : 1;

static async Task AttachmentTenantOwner()
{
    var authorizer = new RecordingAuthorizer((TenantA, ActorA));
    var quarantine = new RecordingQuarantine(_ => true);
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var audit = new RecordingAudit();
    var service = new AssetUpgradeService(authorizer, quarantine, dispatcher, new RecordingIdempotency(), audit);
    var result = await service.SubmitAsync(ActorA, Event("attachment-tenant", TenantA), Attachment("attachment-tenant", TenantB));
    Require(!result.Accepted && result.Status == DeliveryStatus.Rejected, "cross-tenant attachment was accepted");
    Require(dispatcher.Calls.Count == 0, "cross-tenant attachment reached the dispatcher");
}

static async Task AttachmentFileSafety()
{
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new AssetUpgradeService(
        new RecordingAuthorizer((TenantA, ActorA)),
        new RecordingQuarantine(attachment => !attachment.FileName.Contains("..", StringComparison.Ordinal) && attachment.Content.Length <= 4),
        dispatcher,
        new RecordingIdempotency(),
        new RecordingAudit());
    var unsafeName = await service.SubmitAsync(ActorA, Event("unsafe-attachment"), Attachment("unsafe-attachment", TenantA, scanned: true, fileName: "../payload.bin"));
    var oversized = await service.SubmitAsync(ActorA, Event("oversized-attachment"), Attachment("oversized-attachment", TenantA, scanned: true, contentBytes: 5));
    Require(!unsafeName.Accepted && unsafeName.Status == DeliveryStatus.Quarantined, "unsafe filename was not quarantined");
    Require(!oversized.Accepted && oversized.Status == DeliveryStatus.Quarantined, "oversized attachment was not quarantined");
    Require(dispatcher.Calls.Count == 0, "unsafe attachment reached the dispatcher");
}

static async Task AttachmentQuarantineGate()
{
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new AssetUpgradeService(
        new RecordingAuthorizer((TenantA, ActorA)),
        new RecordingQuarantine(attachment => attachment.Scanned),
        dispatcher,
        new RecordingIdempotency(),
        new RecordingAudit());
    var result = await service.SubmitAsync(ActorA, Event("unscanned-attachment"), Attachment("unscanned-attachment", TenantA, scanned: false));
    Require(!result.Accepted && result.Status == DeliveryStatus.Quarantined, "unscanned attachment entered the workflow");
    Require(dispatcher.Calls.Count == 0, "unscanned attachment reached the dispatcher");
}

static async Task AttachmentDuplicateEvent()
{
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var idempotency = new RecordingIdempotency();
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), dispatcher, idempotency, new RecordingAudit());
    var assetEvent = Event("duplicate-attachment-event");
    var first = await service.SubmitAsync(ActorA, assetEvent, Attachment("duplicate-attachment"));
    var second = await service.SubmitAsync(ActorA, assetEvent, Attachment("duplicate-attachment"));
    Require(first.Accepted && second.Status == DeliveryStatus.Duplicate, "duplicate event did not report duplicate status");
    Require(dispatcher.Calls.Count == 1, $"duplicate event dispatched {dispatcher.Calls.Count} times");
    Require(idempotency.MarkCalls.Count == 1, "duplicate event was marked complete more than once");
}

static async Task AttachmentContentSignature()
{
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new AssetUpgradeService(
        new RecordingAuthorizer((TenantA, ActorA)),
        new RecordingQuarantine(attachment => attachment.DeclaredContentType == "application/pdf" && attachment.Content.Span.SequenceEqual(new byte[] { 0x25, 0x50, 0x44, 0x46 })),
        dispatcher,
        new RecordingIdempotency(),
        new RecordingAudit());
    var fakePdf = new AttachmentInput("fake-pdf", TenantA, "report.pdf", "application/pdf", new byte[] { 0x7B, 0x22, 0x78, 0x22 }, true);
    var result = await service.SubmitAsync(ActorA, Event("content-signature"), fakePdf);
    Require(!result.Accepted && result.Status == DeliveryStatus.Quarantined, "MIME/content signature mismatch was accepted");
    Require(dispatcher.Calls.Count == 0, "MIME/content signature mismatch reached the dispatcher");
}

static async Task WorkflowPermissionAndState()
{
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), dispatcher, new RecordingIdempotency(), new RecordingAudit());
    var unauthorized = await service.SubmitAsync(ActorB, Event("unauthorized-workflow"), null);
    var unapproved = await service.SubmitAsync(ActorA, Event("unapproved-workflow", state: WorkflowState.New), null);
    Require(!unauthorized.Accepted && unauthorized.Status == DeliveryStatus.Rejected, "unauthorized workflow event was accepted");
    Require(!unapproved.Accepted && unapproved.Status == DeliveryStatus.Rejected, "unapproved workflow event was dispatched");
    Require(dispatcher.Calls.Count == 0, "a permission/state failure reached the dispatcher");
}

static async Task WorkflowRetryableFailure()
{
    var dispatcher = new RecordingDispatcher(new DeliveryResult(false, DeliveryStatus.Retryable, "temporary transport failure"), new DeliveryResult(true, DeliveryStatus.Accepted));
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), dispatcher, new RecordingIdempotency(), new RecordingAudit());
    var first = await service.SubmitAsync(ActorA, Event("workflow-retry"), null);
    Require(!first.Accepted && first.Status == DeliveryStatus.Retryable, "transport failure was not left retryable");
}

static async Task WorkflowRetrySuccessOnce()
{
    var dispatcher = new RecordingDispatcher(new DeliveryResult(false, DeliveryStatus.Retryable), new DeliveryResult(true, DeliveryStatus.Accepted), new DeliveryResult(true, DeliveryStatus.Accepted));
    var idempotency = new RecordingIdempotency();
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), dispatcher, idempotency, new RecordingAudit());
    var assetEvent = Event("workflow-retry-once");
    var failed = await service.SubmitAsync(ActorA, assetEvent, null);
    var retried = await service.SubmitAsync(ActorA, assetEvent, null);
    var repeated = await service.SubmitAsync(ActorA, assetEvent, null);
    Require(failed.Status == DeliveryStatus.Retryable && retried.Accepted && repeated.Status == DeliveryStatus.Duplicate, "retry sequence did not reach one completed state");
    Require(dispatcher.Calls.Count == 2 && idempotency.MarkCalls.Count == 1, "successful retry advanced workflow more than once");
}

static async Task WorkflowDuplicateSideEffect()
{
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), dispatcher, new RecordingIdempotency(), new RecordingAudit());
    var assetEvent = Event("workflow-duplicate-side-effect");
    await service.SubmitAsync(ActorA, assetEvent, null);
    var duplicate = await service.SubmitAsync(ActorA, assetEvent, null);
    Require(duplicate.Status == DeliveryStatus.Duplicate && dispatcher.Calls.Count == 1, "completed event produced a second workflow side effect");
}

static async Task WorkflowAudit()
{
    var audit = new RecordingAudit();
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted)), new RecordingIdempotency(), audit);
    var assetEvent = Event("workflow-audit");
    var result = await service.SubmitAsync(ActorA, assetEvent, null);
    Require(result.Accepted, "workflow dispatch failed");
    Require(audit.Records.Any(record => record.SubjectId == assetEvent.EventId && record.Status == "accepted"), "workflow audit is missing event identity or final status");
}

static async Task WorkflowDispatchException()
{
    var attempts = 0;
    var dispatcher = new RecordingDispatcher(_ =>
    {
        attempts++;
        if (attempts == 1) throw new InvalidOperationException("temporary workflow outage");
        return new DeliveryResult(true, DeliveryStatus.Accepted);
    });
    var idempotency = new RecordingIdempotency();
    var service = new AssetUpgradeService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingQuarantine(_ => true), dispatcher, idempotency, new RecordingAudit());
    var assetEvent = Event("workflow-exception");
    DeliveryResult first;
    try
    {
        first = await service.SubmitAsync(ActorA, assetEvent, null);
    }
    catch (Exception exception)
    {
        throw new InvalidOperationException($"dispatcher exception escaped workflow submission: {exception.Message}");
    }
    var second = await service.SubmitAsync(ActorA, assetEvent, null);
    Require(!first.Accepted && first.Status == DeliveryStatus.Retryable && second.Accepted, "workflow dispatch exception did not remain retryable");
    Require(dispatcher.Calls.Count == 2 && idempotency.MarkCalls.Count == 1, "workflow exception retry produced incorrect side effects");
}

static async Task ReconciliationDueRetryable()
{
    var now = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    var due = new PendingEvent(Event("due-retryable"), now.AddMinutes(-1), 0, true);
    var notRetryable = new PendingEvent(Event("not-retryable"), now.AddMinutes(-1), 0, false);
    var store = new RecordingEventStore(due, notRetryable);
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new ReconciliationService(new RecordingAuthorizer((TenantA, ActorA)), store, dispatcher, new RecordingIdempotency(), new RecordingAudit());
    var report = await service.RunAsync(ActorA, now, 10);
    Require(store.FindCalls.Count == 1 && store.FindCalls[0].Now == now && store.FindCalls[0].Limit == 10, "reconciliation did not query the requested due window");
    Require(report.EventIds.SequenceEqual(new[] { "due-retryable" }), "non-retryable event was processed");
    Require(dispatcher.Calls.Count == 1, "reconciliation dispatched a non-retryable event");
}

static async Task ReconciliationTenantIsolation()
{
    var now = DateTimeOffset.UtcNow;
    var crossTenant = new PendingEvent(Event("tenant-b-event", TenantB), now.AddMinutes(-1), 0, true);
    var local = new PendingEvent(Event("tenant-a-event", TenantA), now.AddMinutes(-1), 0, true);
    var store = new RecordingEventStore(crossTenant, local);
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var service = new ReconciliationService(new RecordingAuthorizer((TenantA, ActorA)), store, dispatcher, new RecordingIdempotency(), new RecordingAudit());
    var report = await service.RunAsync(ActorA, now, 10);
    Require(report.EventIds.SequenceEqual(new[] { "tenant-a-event" }), "cross-tenant event was processed");
    Require(dispatcher.Calls.All(item => item.TenantId == TenantA), "dispatcher received a cross-tenant event");
    Require(store.MarkCalls.All(item => item.Pending.Event.TenantId == TenantA), "cross-tenant event was modified");
}

static async Task ReconciliationIdempotentRescan()
{
    var now = DateTimeOffset.UtcNow;
    var pending = new PendingEvent(Event("rescan-once"), now.AddMinutes(-1), 0, true);
    var store = new RecordingEventStore(pending, pending);
    var dispatcher = new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted));
    var idempotency = new RecordingIdempotency();
    var service = new ReconciliationService(new RecordingAuthorizer((TenantA, ActorA)), store, dispatcher, idempotency, new RecordingAudit());
    var report = await service.RunAsync(ActorA, now, 10);
    Require(report.Succeeded == 2, "repeated pending event was not recognized as already completed");
    Require(dispatcher.Calls.Count == 1 && idempotency.MarkCalls.Count == 1, "rescan dispatched or marked the event twice");
}

static async Task ReconciliationFailureRerun()
{
    var firstNow = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    var pending = new PendingEvent(Event("rerun-after-failure"), firstNow.AddMinutes(-1), 0, true);
    var store = new RecordingEventStore(pending);
    var dispatcher = new RecordingDispatcher(new DeliveryResult(false, DeliveryStatus.Retryable, "temporary"), new DeliveryResult(true, DeliveryStatus.Accepted));
    var idempotency = new RecordingIdempotency();
    var service = new ReconciliationService(new RecordingAuthorizer((TenantA, ActorA)), store, dispatcher, idempotency, new RecordingAudit());
    var first = await service.RunAsync(ActorA, firstNow, 10);
    var second = await service.RunAsync(ActorA, firstNow.AddMinutes(2), 10);
    Require(first.Retried == 1 && second.Succeeded == 1, "a failed reconciliation could not be rerun successfully");
    Require(dispatcher.Calls.Count == 2 && idempotency.MarkCalls.Count == 1, "rerun produced an incorrect number of dispatch side effects");
}

static async Task ReconciliationAudit()
{
    var audit = new RecordingAudit();
    var service = new ReconciliationService(new RecordingAuthorizer((TenantA, ActorA)), new RecordingEventStore(), new RecordingDispatcher(_ => new(true, DeliveryStatus.Accepted)), new RecordingIdempotency(), audit);
    await service.RunAsync(ActorA, DateTimeOffset.UtcNow, 10);
    Require(audit.Records.Any(record => record.Action.StartsWith("reconciliation", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(record.SubjectId)), "reconciliation run produced no traceable audit record");
}

static async Task ReconciliationDispatchException()
{
    var now = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
    var store = new RecordingEventStore(new PendingEvent(Event("exception-rerun"), now.AddMinutes(-1), 0, true));
    var attempts = 0;
    var dispatcher = new RecordingDispatcher(_ =>
    {
        attempts++;
        if (attempts == 1) throw new InvalidOperationException("temporary dispatcher outage");
        return new DeliveryResult(true, DeliveryStatus.Accepted);
    });
    var idempotency = new RecordingIdempotency();
    var service = new ReconciliationService(new RecordingAuthorizer((TenantA, ActorA)), store, dispatcher, idempotency, new RecordingAudit());
    ReconciliationReport first;
    try
    {
        first = await service.RunAsync(ActorA, now, 10);
    }
    catch (Exception exception)
    {
        throw new InvalidOperationException($"dispatcher exception escaped reconciliation: {exception.Message}");
    }
    var second = await service.RunAsync(ActorA, now.AddMinutes(2), 10);
    Require(first.Retried + first.Failed == 1 && second.Succeeded == 1, "dispatcher exception did not leave a rerunnable reconciliation result");
}

static async Task OrderIncompleteNoInventory()
{
    var inventory = new RecordingInventory(new ReservationResult(true, "reservation-1"));
    var committer = new RecordingCommitter();
    var service = NewOrderBridge(new RecordingValidator(false, "missing order line"), inventory, committer, new RecordingIdempotency(), new RecordingAudit());
    var result = await service.SubmitAsync(Order("invalid-order"));
    Require(!result.Accepted && result.Status == OrderStatus.Rejected, "invalid order was accepted");
    Require(inventory.Calls.Count == 0 && committer.Calls.Count == 0, "invalid order changed inventory or committed");
}

static async Task OrderReservationFailure()
{
    var inventory = new RecordingInventory(new ReservationResult(false, null, "out of stock"));
    var committer = new RecordingCommitter();
    var idempotency = new RecordingIdempotency();
    var service = NewOrderBridge(new RecordingValidator(true), inventory, committer, idempotency, new RecordingAudit());
    var result = await service.SubmitAsync(Order("reservation-failure"));
    Require(!result.Accepted && result.Status != OrderStatus.Accepted, "failed reservation was accepted");
    Require(committer.Calls.Count == 0 && idempotency.MarkCalls.Count == 0, "failed reservation caused a commit or idempotency mark");
}

static async Task OrderAtomicSuccess()
{
    var inventory = new RecordingInventory(new ReservationResult(true, "reservation-success"));
    var committer = new RecordingCommitter();
    var idempotency = new RecordingIdempotency();
    var audit = new RecordingAudit();
    var service = NewOrderBridge(new RecordingValidator(true), inventory, committer, idempotency, audit);
    var result = await service.SubmitAsync(Order("successful-order"));
    Require(result.Accepted && result.Status == OrderStatus.Accepted, "valid order was not accepted");
    Require(committer.Calls.Count == 1 && idempotency.MarkCalls.Count == 1, "successful order did not commit exactly once");
    Require(audit.Records.Any(record => record.SubjectId == "successful-order" && record.Status == "accepted"), "successful order has no accepted audit record");
}

static async Task OrderDuplicateNoReserve()
{
    var inventory = new RecordingInventory(new ReservationResult(true, "should-not-be-used"));
    var committer = new RecordingCommitter();
    var idempotency = new RecordingIdempotency("duplicate-order");
    var service = NewOrderBridge(new RecordingValidator(true), inventory, committer, idempotency, new RecordingAudit());
    var result = await service.SubmitAsync(Order("duplicate-order"));
    Require(result.Accepted, "duplicate order was rejected instead of being idempotent");
    Require(inventory.Calls.Count == 0 && committer.Calls.Count == 0, "duplicate order reserved or committed again");
}

static async Task OrderCommitRollback()
{
    var inventory = new RecordingInventory(new ReservationResult(true, "reservation-rollback"));
    var committer = new RecordingCommitter(new InvalidOperationException("commit store unavailable"));
    var idempotency = new RecordingIdempotency();
    var audit = new RecordingAudit();
    var service = NewOrderBridge(new RecordingValidator(true), inventory, committer, idempotency, audit);
    var result = await service.SubmitAsync(Order("rollback-order"));
    Require(!result.Accepted && result.Status == OrderStatus.RolledBack, "commit failure did not return a rollback result");
    Require(idempotency.MarkCalls.Count == 0, "rolled-back order was marked complete");
    Require(audit.Records.Any(record => record.SubjectId == "rollback-order" && record.Status == "failed"), "rollback was not audited");
}

static async Task OrderAuditFailure()
{
    var inventory = new RecordingInventory(new ReservationResult(true, "reservation-audit-failure"));
    var committer = new RecordingCommitter();
    var idempotency = new RecordingIdempotency();
    var service = NewOrderBridge(new RecordingValidator(true), inventory, committer, idempotency, new ThrowingAudit());
    try
    {
        var result = await service.SubmitAsync(Order("audit-failure-order"));
        Require(!result.Accepted, "audit failure was reported as successful completion");
    }
    catch (Exception)
    {
        // A failing audit may be surfaced, but it must not be hidden as a
        // successful idempotent completion.
    }
    Require(idempotency.MarkCalls.Count == 0, "audit failure left the order marked complete");
}

static Task OrderPortAbstraction()
{
    var constructor = typeof(OrderPluginBridge).GetConstructors(BindingFlags.Public | BindingFlags.Instance).Single();
    var concrete = constructor.GetParameters()
        .Select(parameter => parameter.ParameterType)
        .Where(type => !type.IsInterface)
        .ToArray();
    Require(concrete.Length == 0, $"order bridge constructor depends on concrete type(s): {string.Join(", ", concrete.Select(type => type.Name))}");
    return Task.CompletedTask;
}

static OrderPluginBridge NewOrderBridge(RecordingValidator validator, RecordingInventory inventory, RecordingCommitter committer, RecordingIdempotency idempotency, IAuditSink audit)
    => new(validator, inventory, idempotency, committer, audit);

static AssetEvent Event(string id, string tenant = TenantA, WorkflowState state = WorkflowState.Approved)
    => new(id, tenant, "asset-1", "asset.updated", DateTimeOffset.Parse("2026-01-01T00:00:00Z")) { State = state };

static AttachmentInput Attachment(string id, string tenant = TenantA, bool scanned = true, string? fileName = null, int contentBytes = 4)
    => new(id, tenant, fileName ?? $"{id}.pdf", "application/pdf", Enumerable.Repeat((byte)0x41, contentBytes).ToArray(), scanned);

static OrderRequest Order(string id)
    => new(id, TenantA, ActorA, new[] { new OrderLine("sku-1", 1, 100) }, "CNY");

static Dictionary<string, string> ParseArguments(string[] args)
{
    var values = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var index = 0; index < args.Length; index++)
    {
        if (!args[index].StartsWith("--", StringComparison.Ordinal)) continue;
        var key = args[index][2..];
        values[key] = index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal)
            ? args[++index]
            : "true";
    }
    return values;
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static double Ratio(int numerator, int denominator) => denominator == 0 ? 0 : numerator / (double)denominator;

internal sealed record AcceptanceCase(string TaskId, string ConditionId, string Description, Func<Task> Run, string Category = "requirement");
internal sealed record CaseResult(string TaskId, string ConditionId, string Category, string Description, bool Passed, string? Error);
internal sealed record TaskReport(string TaskId, int Passed, int Total, bool PassedAll);
internal sealed record EvaluationReport(int SchemaVersion, string Evaluator, string? TargetProject, DateTimeOffset GeneratedAt, int Total, int Passed, int Failed, double Score, int RequirementTotal, int RequirementPassed, int QualityTotal, int QualityPassed, IReadOnlyList<TaskReport> Tasks, IReadOnlyList<CaseResult> Cases);

internal sealed class RecordingAuthorizer(params (string Tenant, string Actor)[] allowed) : ITenantAuthorizer
{
    private readonly HashSet<(string Tenant, string Actor)> allowed = allowed.ToHashSet();
    public bool CanAccess(string tenantId, string actorId) => allowed.Contains((tenantId, actorId));
}

internal sealed class RecordingQuarantine(Func<AttachmentInput, bool> predicate) : IAttachmentQuarantine
{
    public bool IsSafe(AttachmentInput attachment) => predicate(attachment);
}

internal sealed class RecordingDispatcher : IWorkflowDispatcher
{
    private readonly Queue<DeliveryResult> responses;
    private readonly Func<AssetEvent, DeliveryResult>? behavior;
    public RecordingDispatcher(params DeliveryResult[] responses) => this.responses = new(responses);
    public RecordingDispatcher(Func<AssetEvent, DeliveryResult> behavior)
    {
        this.behavior = behavior;
        responses = new();
    }
    public List<AssetEvent> Calls { get; } = [];
    public Task<DeliveryResult> DispatchAsync(AssetEvent assetEvent, CancellationToken cancellationToken)
    {
        Calls.Add(assetEvent);
        var result = behavior is not null
            ? behavior(assetEvent)
            : responses.Count == 0 ? new DeliveryResult(true, DeliveryStatus.Accepted) : responses.Dequeue();
        return Task.FromResult(result);
    }
}

internal sealed class RecordingIdempotency(params string[] completed) : IIdempotencyStore
{
    private readonly HashSet<(string Tenant, string Operation)> completed = completed.Select(operation => ("tenant-a", operation)).ToHashSet();
    public List<(string Tenant, string Operation)> MarkCalls { get; } = [];
    public bool HasCompleted(string tenantId, string operationId) => completed.Contains((tenantId, operationId));
    public void MarkCompleted(string tenantId, string operationId) { completed.Add((tenantId, operationId)); MarkCalls.Add((tenantId, operationId)); }
}

internal sealed class RecordingAudit : IAuditSink
{
    public List<AuditRecord> Records { get; } = [];
    public void Record(AuditRecord record) => Records.Add(record);
}

internal sealed class RecordingEventStore(params PendingEvent[] items) : IRetryableEventStore
{
    private readonly List<PendingEvent> items = items.ToList();
    public List<(DateTimeOffset Now, int Limit)> FindCalls { get; } = [];
    public List<(PendingEvent Pending, DateTimeOffset RetryAfter)> MarkCalls { get; } = [];
    public Task<IReadOnlyList<PendingEvent>> FindDueAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken)
    {
        FindCalls.Add((now, limit));
        return Task.FromResult<IReadOnlyList<PendingEvent>>(items.Take(limit).ToArray());
    }
    public Task MarkRetryableAsync(PendingEvent pending, DateTimeOffset retryAfter, CancellationToken cancellationToken)
    {
        MarkCalls.Add((pending, retryAfter));
        return Task.CompletedTask;
    }
}

internal sealed class RecordingValidator(bool valid, string? reason = null) : IOrderValidator
{
    public List<OrderRequest> Calls { get; } = [];
    public bool IsValid(OrderRequest order, out string? validationReason) { Calls.Add(order); validationReason = reason; return valid; }
}

internal sealed class RecordingInventory(params ReservationResult[] responses) : IInventoryGateway
{
    private readonly Queue<ReservationResult> responses = new(responses);
    public List<OrderRequest> Calls { get; } = [];
    public Task<ReservationResult> ReserveAsync(OrderRequest order, CancellationToken cancellationToken)
    {
        Calls.Add(order);
        return Task.FromResult(responses.Count == 0 ? new ReservationResult(false, null, "no response") : responses.Dequeue());
    }
}

internal sealed class RecordingCommitter(Exception? failure = null) : IOrderCommitter
{
    public List<(OrderRequest Order, ReservationResult Reservation)> Calls { get; } = [];
    public Task CommitAsync(OrderRequest order, ReservationResult reservation, CancellationToken cancellationToken)
    {
        Calls.Add((order, reservation));
        if (failure is not null) throw failure;
        return Task.CompletedTask;
    }
}

internal sealed class ThrowingAudit : IAuditSink
{
    public void Record(AuditRecord record) => throw new InvalidOperationException("audit sink unavailable");
}
