namespace AssetUpgradeGateway;

using AssetUpgradeGateway.Adapters;
using AssetUpgradeGateway.Application;
using AssetUpgradeGateway.Domain;
using AssetUpgradeGateway.Policies;
using AssetUpgradeGateway.Telemetry;

/// <summary>
/// Explicit constructor-wired composition root. No dependency-injection
/// container or vendor package is required: every adapter, policy, telemetry
/// surface and application service is created once and handed to the three
/// public gateway entry points, so the object graph is reusable and testable.
/// </summary>
public sealed class GatewayComposition
{
    // ---- Infrastructure adapters (in-memory, vendor neutral) --------------
    public SystemClock Clock { get; } = new();
    public InMemoryTenantAuthorizer Authorizer { get; } = new();
    public InMemoryIdempotencyStore Idempotency { get; } = new();
    public InMemoryAuditSink Audit { get; } = new();
    public InMemoryAttachmentRepository AttachmentRepository { get; } = new();
    public InMemoryAttachmentQuarantine AttachmentQuarantine { get; } = new();
    public InMemoryQuarantineLog QuarantineLog { get; } = new();
    public InMemoryDeadLetterSink DeadLetters { get; } = new();
    public InMemoryMetricsSink Metrics { get; } = new();
    public InMemoryRetryableEventStore RetryableEvents { get; } = new();
    public InMemoryWorkflowDispatcher WorkflowDispatcher { get; } = new();
    public InMemoryDispatchHistory DispatchHistory { get; } = new();
    public InMemoryInventoryGateway Inventory { get; } = new();
    public InMemoryOrderCommitter OrderCommitter { get; } = new();
    public InMemoryOrderRepository OrderAggregates { get; } = new();
    public InMemoryOrderRequestRepository Orders { get; } = new();
    public InMemoryPluginRegistry Plugins { get; } = new();
    public InMemoryLeaseStore Leases { get; } = new();
    public InMemoryCheckpointStore Checkpoints { get; } = new();
    public InMemoryTransactionBoundary Transactions { get; } = new();
    public InMemoryAssetRepository Assets { get; } = new();

    public InMemoryAttachmentScanner AttachmentScanner { get; }
    public CancellationAwareDispatcher Dispatcher { get; }
    public IAuditSink AuditedSink { get; }

    // ---- Policies ---------------------------------------------------------
    public WorkflowStateTransitionPolicy WorkflowPolicy { get; } = new();
    public ExponentialRetryPolicy RetryPolicy { get; } = new();
    public OrderValidationPolicy OrderValidator { get; } = new();
    public AttachmentValidationPipeline AttachmentValidation { get; } = new();
    public PluginCapabilityPolicy PluginPolicy { get; } = new();
    public PriceCalculationPolicy Pricing { get; } = new();
    public PaymentRequirementPolicy Payment { get; } = new();

    // ---- Telemetry --------------------------------------------------------
    public InMemoryTraceSink TraceSink { get; }
    public TraceFactory Tracer { get; }

    // ---- Application services --------------------------------------------
    public AttachmentIntakeService AttachmentIntake { get; }
    public WorkflowDeliveryCoordinator WorkflowDelivery { get; }
    public ReconciliationOrchestrator Reconciliation { get; }
    public OrderLifecycleService OrderLifecycle { get; }
    public PluginRegistryService PluginRegistry { get; }
    public AssetLifecycleCoordinator AssetLifecycle { get; }

    // ---- Public gateway entry points -------------------------------------
    public AssetUpgradeService AssetUpgrade { get; }
    public ReconciliationService ReconciliationGateway { get; }
    public OrderPluginBridge OrderPlugin { get; }

    public GatewayComposition()
    {
        TraceSink = new InMemoryTraceSink();
        Tracer = new TraceFactory(TraceSink);
        AttachmentScanner = new InMemoryAttachmentScanner(Clock);
        Dispatcher = new CancellationAwareDispatcher(WorkflowDispatcher);
        AuditedSink = TelemetryHealthComposition.Decorate(Audit, Metrics);

        AttachmentIntake = new AttachmentIntakeService(
            Authorizer, AttachmentRepository, AttachmentScanner, QuarantineLog, Audit, Metrics,
            Clock, AttachmentValidation, Tracer);

        WorkflowDelivery = new WorkflowDeliveryCoordinator(
            Authorizer, Dispatcher, RetryableEvents, DispatchHistory, DeadLetters, Audit, Metrics,
            Clock, WorkflowPolicy, RetryPolicy, Tracer);

        Reconciliation = new ReconciliationOrchestrator(
            Authorizer, RetryableEvents, Dispatcher, Idempotency, Audit, Checkpoints, Leases, Metrics,
            RetryPolicy, Tracer);

        OrderLifecycle = new OrderLifecycleService(
            OrderValidator, Inventory, OrderCommitter, OrderAggregates, Idempotency, Audit, Transactions,
            Clock, Pricing, Payment, Tracer, Metrics);

        PluginRegistry = new PluginRegistryService(Plugins, Authorizer, Audit);
        AssetLifecycle = new AssetLifecycleCoordinator(AttachmentIntake, WorkflowDelivery, Assets, Audit, Clock, Tracer);

        AssetUpgrade = new AssetUpgradeService(Authorizer, AttachmentQuarantine, Dispatcher, Idempotency, AuditedSink);
        ReconciliationGateway = new ReconciliationService(Authorizer, RetryableEvents, Dispatcher, Idempotency, AuditedSink);
        OrderPlugin = new OrderPluginBridge(OrderValidator, Inventory, Idempotency, OrderCommitter, AuditedSink);
    }

    public HealthProbeRunner CreateHealthRunner(string tenantId)
        => TelemetryHealthComposition.MetricsRunner(Metrics, tenantId, clock: Clock);
}

public static class Program
{
    public const string DemoTenant = "tenant-demo";
    public const string DemoActor = "actor-demo";
    public const string DemoSku = "sku-demo";

    public static GatewayComposition Compose() => new();

    public static void Main()
    {
        var composition = Compose();

        try
        {
            RunDemoAsync(composition).GetAwaiter().GetResult();
            Console.WriteLine("AssetUpgradeGateway demo completed.");
        }
        catch (Exception exception)
        {
            // The composition root is also a smoke test; never leak a stack trace
            // from the demo entry point.
            Console.WriteLine($"AssetUpgradeGateway demo failed: {exception.Message}");
        }
    }

    /// <summary>
    /// Deterministically exercises the public entry points without any external
    /// infrastructure: attachment accepted vs. quarantined, approved event
    /// dispatch, due retryable reconciliation and an order submission.
    /// </summary>
    public static async Task RunDemoAsync(GatewayComposition composition, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(composition);

        composition.Authorizer.Grant(DemoTenant, DemoActor, "assets:write", "orders:write", "reconciliation:run");
        composition.Inventory.Seed(DemoSku, 25);

        await composition.Plugins.RegisterAsync(
            new PluginDescriptor(
                "plugin-demo",
                DemoTenant,
                "Demo Plugin",
                new Version(1, 0, 0),
                new HashSet<string>(StringComparer.Ordinal) { "orders" },
                true),
            cancellationToken).ConfigureAwait(false);

        var factory = new AssetEventFactory(composition.Clock);
        var descriptor = new AssetDescriptor("asset-demo", DemoTenant, AssetKind.PluginPackage, "external-demo");

        // 1. Attachment that has passed scanning enters the workflow.
        var approved = factory.Create(descriptor, "asset.upgrade", "attachment-clean");
        var accepted = await composition.AssetUpgrade.SubmitAsync(
            DemoActor,
            approved,
            new AttachmentInput("attachment-clean", DemoTenant, "package.pdf", "application/pdf", "%PDF-1.4 demo package"u8.ToArray(), true),
            cancellationToken).ConfigureAwait(false);

        // 2. An unscanned attachment stays quarantined and never reaches dispatch.
        var quarantined = await composition.AssetUpgrade.SubmitAsync(
            DemoActor,
            factory.Create(descriptor, "asset.upgrade", "attachment-pending"),
            new AttachmentInput("attachment-pending", DemoTenant, "pending.pdf", "application/pdf", "%PDF-1.4 pending scan"u8.ToArray(), false),
            cancellationToken).ConfigureAwait(false);

        // 3. Approved event dispatch without an attachment.
        var dispatched = await composition.AssetUpgrade.SubmitAsync(
            DemoActor,
            factory.Create(descriptor, "asset.upgrade"),
            null,
            cancellationToken).ConfigureAwait(false);

        // 4. Scheduled reconciliation of a due, retryable event.
        var due = factory.Create(descriptor, "asset.upgrade", "attachment-retry");
        composition.RetryableEvents.Add(new PendingEvent(due, composition.Clock.UtcNow.AddMinutes(-1), 0, true));
        var report = await composition.ReconciliationGateway.RunAsync(
            DemoActor,
            composition.Clock.UtcNow,
            10,
            cancellationToken).ConfigureAwait(false);

        // 5. Order submission reserving inventory exactly once.
        var order = new OrderRequest(
            "order-demo",
            DemoTenant,
            DemoActor,
            new[] { new OrderLine(DemoSku, 2, 1500) },
            "USD");
        var orderResult = await composition.OrderPlugin.SubmitAsync(order, cancellationToken).ConfigureAwait(false);

        Console.WriteLine(
            $"attachment={accepted.Status}; quarantined={quarantined.Status}; dispatched={dispatched.Status}; " +
            $"reconciled(succeeded={report.Succeeded}); order={orderResult.Status}; auditRows={composition.Audit.Snapshot().Count}.");
    }
}
