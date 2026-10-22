package com.example.assetupgrade.config;

import com.example.assetupgrade.application.AssetUpgradeApplication;
import com.example.assetupgrade.application.AttachmentApplicationService;
import com.example.assetupgrade.application.OrderApplicationService;
import com.example.assetupgrade.application.ReconciliationApplicationService;
import com.example.assetupgrade.application.WorkflowApplicationService;
import com.example.assetupgrade.attachment.AttachmentPolicy;
import com.example.assetupgrade.attachment.AttachmentScanResult;
import com.example.assetupgrade.attachment.port.AttachmentLockPort;
import com.example.assetupgrade.attachment.port.AttachmentMetadataStore;
import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.attachment.port.AttachmentScanner;
import com.example.assetupgrade.attachment.port.ObjectStoragePort;
import com.example.assetupgrade.attachment.port.QuarantinePort;
import com.example.assetupgrade.audit.AuditDecorator;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditQueryService;
import com.example.assetupgrade.audit.AuditWriter;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.messaging.MessageRetryPort;
import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.order.port.OrderCommitPort;
import com.example.assetupgrade.order.port.PluginRegistryPort;
import com.example.assetupgrade.order.port.ReservationLedgerPort;
import com.example.assetupgrade.reconciliation.DueWindow;
import com.example.assetupgrade.reconciliation.port.CheckpointPort;
import com.example.assetupgrade.reconciliation.port.DueWindowPort;
import com.example.assetupgrade.reconciliation.port.LeasePort;
import com.example.assetupgrade.reconciliation.port.ReconciliationJobPort;
import com.example.assetupgrade.reconciliation.port.RetryableEventPort;
import com.example.assetupgrade.retry.ExponentialRetryPolicy;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.retry.RetryPolicyOptions;
import com.example.assetupgrade.telemetry.HealthEndpoint;
import com.example.assetupgrade.telemetry.ReadinessProbe;
import com.example.assetupgrade.workflow.WorkflowState;
import com.example.assetupgrade.workflow.WorkflowStatePolicy;
import com.example.assetupgrade.workflow.port.DeadLetterPort;
import com.example.assetupgrade.workflow.port.WorkflowDispatcher;
import com.example.assetupgrade.workflow.port.WorkflowEventStore;
import com.example.assetupgrade.workflow.port.WorkflowOutboxPort;
import com.example.assetupgrade.workflow.port.WorkflowRoutePort;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Module composition root.
 *
 * <p>Translated from {@code AppSettingsHelper.SaveAppSettings} (build and publish the
 * running settings singleton) into a deterministic object graph: validated settings are
 * composed with the adapters from {@link AdapterFactory}, the application policies
 * (attachment, retry, due-window, workflow state) and the existing application-service
 * seams. The clean-scan-before-release rule and every tenant-scoped port are honoured here
 * by wiring the fail-closed scanner and the tenant-isolated adapters, never by weakening a
 * contract. No file outside the configuration set is modified.</p>
 */
public final class ModuleWiring {

    /** Default maximum number of events considered by one reconciliation window. */
    public static final int DEFAULT_DUE_WINDOW_LIMIT = 100;

    private final ConfigurationLoader.Settings settings;
    private final TimeProvider clock;
    private final AdapterFactory adapters;

    private final AuditDecorator auditDecorator;
    private final AttachmentPolicy attachmentPolicy;
    private final RetryPolicyOptions retryOptions;
    private final ExponentialRetryPolicy retryPolicy;
    private final DueWindow dueWindow;
    private final WorkflowStatePolicy workflowStatePolicy;
    private final AttachmentScanner attachmentScanner;
    private final AttachmentLockPort attachmentLockPort;

    private final AttachmentApplicationService attachmentApplicationService;
    private final OrderApplicationService orderApplicationService;
    private final WorkflowApplicationService workflowApplicationService;
    private final ReconciliationApplicationService reconciliationApplicationService;
    private final AssetUpgradeApplication assetUpgradeApplication;

    private ModuleWiring(ConfigurationLoader.Settings settings, AdapterFactory adapters,
                         AttachmentApplicationService attachmentApplicationService,
                         OrderApplicationService orderApplicationService,
                         WorkflowApplicationService workflowApplicationService,
                         ReconciliationApplicationService reconciliationApplicationService,
                         AssetUpgradeApplication assetUpgradeApplication) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.adapters = Objects.requireNonNull(adapters, "adapters");
        this.clock = adapters.clock();
        this.attachmentApplicationService = attachmentApplicationService;
        this.orderApplicationService = orderApplicationService;
        this.workflowApplicationService = workflowApplicationService;
        this.reconciliationApplicationService = reconciliationApplicationService;
        this.assetUpgradeApplication = assetUpgradeApplication;

        this.auditDecorator = new AuditDecorator(
                adapters.auditWriter(), adapters.auditFailureHandler(), this.clock);
        this.attachmentPolicy = new AttachmentPolicy.Default(
                settings.get(AttachmentPolicyProperties.class).maxBytes());

        RetryProperties retry = settings.get(RetryProperties.class);
        this.retryOptions = new RetryPolicyOptions(
                retry.maxAttempts(), retry.initialBackoff(), retry.maxBackoff(), retry.multiplier(), retry.jitter());
        this.retryPolicy = new ExponentialRetryPolicy(this.retryOptions, this.clock);

        SchedulerProperties scheduler = settings.get(SchedulerProperties.class);
        this.dueWindow = new DueWindow(
                this.clock.now().minus(scheduler.interval()), this.clock.now(), DEFAULT_DUE_WINDOW_LIMIT);
        this.workflowStatePolicy = WorkflowStatePolicy.standard();
        this.attachmentScanner = new FailClosedAttachmentScanner();
        this.attachmentLockPort = new InMemoryAttachmentLockPort();
    }

    /** Validates and wires the loader's default settings. */
    public static ModuleWiring wiring() {
        return wiring(ConfigurationLoader.defaults().load());
    }

    /** Validates {@code settings} and wires the module over them. */
    public static ModuleWiring wiring(ConfigurationLoader.Settings settings) {
        new ConfigurationValidator().validate(settings);
        return new ModuleWiring(settings, new AdapterFactory(settings), null, null, null, null, null);
    }

    /** Wires {@code settings} over a caller-supplied adapter factory. */
    public static ModuleWiring wiring(ConfigurationLoader.Settings settings, AdapterFactory adapters) {
        new ConfigurationValidator().validate(settings);
        return new ModuleWiring(settings, adapters, null, null, null, null, null);
    }

    /** Wires {@code settings} plus the existing application-service seams. */
    public static ModuleWiring wiring(ConfigurationLoader.Settings settings,
                                      AttachmentApplicationService attachmentApplicationService,
                                      OrderApplicationService orderApplicationService,
                                      WorkflowApplicationService workflowApplicationService,
                                      ReconciliationApplicationService reconciliationApplicationService,
                                      AssetUpgradeApplication assetUpgradeApplication) {
        new ConfigurationValidator().validate(settings);
        return new ModuleWiring(settings, new AdapterFactory(settings), attachmentApplicationService,
                orderApplicationService, workflowApplicationService, reconciliationApplicationService,
                assetUpgradeApplication);
    }

    /** @return the validated settings. */
    public ConfigurationLoader.Settings settings() {
        return settings;
    }

    /** @return the adapter factory backing this graph. */
    public AdapterFactory adapters() {
        return adapters;
    }

    /** @return the shared clock. */
    public TimeProvider clock() {
        return clock;
    }

    // --------------------------------------------------------------- policies

    /** @return the audit decorator over the composed audit writer. */
    public AuditDecorator auditDecorator() {
        return auditDecorator;
    }

    /** @return the attachment policy sized from {@link AttachmentPolicyProperties}. */
    public AttachmentPolicy attachmentPolicy() {
        return attachmentPolicy;
    }

    /** @return the retry options derived from {@link RetryProperties}. */
    public RetryPolicyOptions retryOptions() {
        return retryOptions;
    }

    /** @return the exponential retry policy derived from {@link RetryProperties}. */
    public ExponentialRetryPolicy retryPolicy() {
        return retryPolicy;
    }

    /** @return the due window derived from {@link SchedulerProperties}. */
    public DueWindow dueWindow() {
        return dueWindow;
    }

    /** @return the workflow legal-transition policy. */
    public WorkflowStatePolicy workflowStatePolicy() {
        return workflowStatePolicy;
    }

    /** @return the configured approved state as a typed {@link WorkflowState}. */
    public WorkflowState approvedState() {
        String configured = settings.get(WorkflowProperties.class).approvedState();
        for (WorkflowState state : WorkflowState.values()) {
            if (state.name().equalsIgnoreCase(configured)) {
                return state;
            }
        }
        return WorkflowState.APPROVED;
    }

    // --------------------------------------------------------------- ports

    /** @return the object-storage seam. */
    public ObjectStoragePort objectStorage() {
        return adapters.objectStoragePort();
    }

    /** @return the attachment-repository seam. */
    public AttachmentRepository attachments() {
        return adapters.attachments();
    }

    /** @return the attachment-metadata seam. */
    public AttachmentMetadataStore attachmentMetadata() {
        return adapters.attachmentMetadata();
    }

    /** @return the quarantine seam. */
    public QuarantinePort quarantine() {
        return adapters.quarantine();
    }

    /**
     * @return the configured attachment scanner; the built-in default is fail-closed so an
     *         attachment is never released without an explicit clean verdict.
     */
    public AttachmentScanner attachmentScanner() {
        return attachmentScanner;
    }

    /** @return the tenant-scoped attachment lock seam. */
    public AttachmentLockPort attachmentLockPort() {
        return attachmentLockPort;
    }

    /** @return the order-commit seam. */
    public OrderCommitPort orderCommit() {
        return adapters.orderCommit();
    }

    /** @return the reservation-ledger seam. */
    public ReservationLedgerPort reservationLedger() {
        return adapters.reservationLedger();
    }

    /** @return the plugin-registry seam. */
    public PluginRegistryPort pluginRegistry() {
        return adapters.pluginRegistry();
    }

    /** @return the idempotency seam. */
    public IdempotencyPort idempotency() {
        return adapters.idempotency();
    }

    /** @return the workflow dispatcher seam. */
    public WorkflowDispatcher workflowDispatcher() {
        return adapters.workflowDispatcher();
    }

    /** @return the workflow route seam. */
    public WorkflowRoutePort workflowRoutes() {
        return adapters.workflowRoutes();
    }

    /** @return the workflow event-store seam. */
    public WorkflowEventStore workflowEventStore() {
        return adapters.workflowEvents();
    }

    /** @return the workflow outbox seam. */
    public WorkflowOutboxPort workflowOutbox() {
        return adapters.workflowOutbox();
    }

    /** @return the dead-letter seam. */
    public DeadLetterPort deadLetters() {
        return adapters.deadLetters();
    }

    /** @return the due-window seam. */
    public DueWindowPort dueWindowPort() {
        return adapters.dueWindow();
    }

    /** @return the lease seam. */
    public LeasePort leases() {
        return adapters.leases();
    }

    /** @return the checkpoint seam. */
    public CheckpointPort checkpoints() {
        return adapters.checkpoints();
    }

    /** @return the retryable-event seam. */
    public RetryableEventPort retryableEvents() {
        return adapters.retryableEvents();
    }

    /** @return the reconciliation-job seam. */
    public ReconciliationJobPort reconciliationJob() {
        return adapters.reconciliationJob();
    }

    /** @return the message-retry seam. */
    public MessageRetryPort messageRetry() {
        return adapters.messageRetry();
    }

    /** @return the audit writer. */
    public AuditWriter auditWriter() {
        return adapters.auditWriter();
    }

    /** @return the audit port seam. */
    public AuditPort auditPort() {
        return adapters.auditPort();
    }

    /** @return the tenant-scoped audit query service. */
    public AuditQueryService auditQueryService() {
        return adapters.auditQueryService();
    }

    /** @return the health endpoint with the registered checks. */
    public HealthEndpoint healthEndpoint() {
        return adapters.healthEndpoint();
    }

    /** @return the readiness probe with the registered checks. */
    public ReadinessProbe readinessProbe() {
        return adapters.readinessProbe();
    }

    /** @return the registered health checks. */
    public List<HealthCheck> healthChecks() {
        return adapters.healthChecks();
    }

    // --------------------------------------------------------------- application seams

    /** @return the supplied attachment application service, or {@code null} when not wired. */
    public AttachmentApplicationService attachmentApplicationService() {
        return attachmentApplicationService;
    }

    /** @return the supplied order application service, or {@code null} when not wired. */
    public OrderApplicationService orderApplicationService() {
        return orderApplicationService;
    }

    /** @return the supplied workflow application service, or {@code null} when not wired. */
    public WorkflowApplicationService workflowApplicationService() {
        return workflowApplicationService;
    }

    /** @return the supplied reconciliation application service, or {@code null} when not wired. */
    public ReconciliationApplicationService reconciliationApplicationService() {
        return reconciliationApplicationService;
    }

    /** @return the supplied asset-upgrade application, or {@code null} when not wired. */
    public AssetUpgradeApplication assetUpgradeApplication() {
        return assetUpgradeApplication;
    }

    /** Compatibility seam: delegates to the adapter factory's lookup. */
    public Object execute(Object input) {
        if (input instanceof ConfigurationLoader.Settings candidate) {
            return wiring(candidate);
        }
        return adapters.execute(input);
    }

    /** @return a copy of this wiring using {@code scanner} as the attachment scanner. */
    public ModuleWiring withAttachmentScanner(AttachmentScanner scanner) {
        return new ModuleWiring(this, scanner, null);
    }

    /** @return a copy of this wiring using {@code lockPort} as the attachment lock seam. */
    public ModuleWiring withAttachmentLockPort(AttachmentLockPort lockPort) {
        return new ModuleWiring(this, null, lockPort);
    }

    private ModuleWiring(ModuleWiring base, AttachmentScanner scanner, AttachmentLockPort lockPort) {
        this.settings = base.settings;
        this.adapters = base.adapters;
        this.clock = base.clock;
        this.attachmentApplicationService = base.attachmentApplicationService;
        this.orderApplicationService = base.orderApplicationService;
        this.workflowApplicationService = base.workflowApplicationService;
        this.reconciliationApplicationService = base.reconciliationApplicationService;
        this.assetUpgradeApplication = base.assetUpgradeApplication;
        this.auditDecorator = base.auditDecorator;
        this.attachmentPolicy = base.attachmentPolicy;
        this.retryOptions = base.retryOptions;
        this.retryPolicy = base.retryPolicy;
        this.dueWindow = base.dueWindow;
        this.workflowStatePolicy = base.workflowStatePolicy;
        this.attachmentScanner = scanner == null ? base.attachmentScanner : scanner;
        this.attachmentLockPort = lockPort == null ? base.attachmentLockPort : lockPort;
    }

    /** Fail-closed scanner: no provider scan means the attachment is never released. */
    private static final class FailClosedAttachmentScanner implements AttachmentScanner {

        @Override
        public AttachmentScanResult scan(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                                         com.example.assetupgrade.attachment.AttachmentContent content) {
            return AttachmentScanResult.failed("none", "no attachment scanner is configured");
        }
    }

    /** Tenant-isolated in-memory attachment lock seam. */
    private static final class InMemoryAttachmentLockPort implements AttachmentLockPort {

        private final Map<String, Lock> locks = new ConcurrentHashMap<>();

        @Override
        public Lock lock(com.example.assetupgrade.common.TenantId tenantId, String attachmentId) {
            Objects.requireNonNull(tenantId, "tenantId");
            String key = tenantId.value() + '\u001f' + (attachmentId == null ? "" : attachmentId);
            return locks.computeIfAbsent(key, ignored -> new ReentrantLock());
        }
    }
}
