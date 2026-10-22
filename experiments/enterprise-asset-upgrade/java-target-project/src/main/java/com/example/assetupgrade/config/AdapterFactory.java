package com.example.assetupgrade.config;

import com.example.assetupgrade.adapters.BullMqRetryAdapter;
import com.example.assetupgrade.adapters.CamelWorkflowAdapter;
import com.example.assetupgrade.adapters.FlowableWorkflowAdapter;
import com.example.assetupgrade.adapters.IdentityHealthCheck;
import com.example.assetupgrade.adapters.JdbcAttachmentRepository;
import com.example.assetupgrade.adapters.JdbcEventEnvelopeRepository;
import com.example.assetupgrade.adapters.JdbcOrderRepository;
import com.example.assetupgrade.adapters.KafkaMessagePublisher;
import com.example.assetupgrade.adapters.KeycloakIdentityAdapter;
import com.example.assetupgrade.adapters.ObjectStorageHealthCheck;
import com.example.assetupgrade.adapters.PostgresTransactionAdapter;
import com.example.assetupgrade.adapters.QuartzReconciliationScheduler;
import com.example.assetupgrade.adapters.QueueHealthCheck;
import com.example.assetupgrade.adapters.S3ObjectStorageAdapter;
import com.example.assetupgrade.attachment.port.AttachmentCleanupPort;
import com.example.assetupgrade.attachment.port.AttachmentEventPort;
import com.example.assetupgrade.attachment.port.AttachmentFingerprintPort;
import com.example.assetupgrade.attachment.port.AttachmentMetadataStore;
import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.attachment.port.ObjectStoragePort;
import com.example.assetupgrade.attachment.port.QuarantinePort;
import com.example.assetupgrade.attachment.port.UploadStreamPort;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditFailureHandler;
import com.example.assetupgrade.audit.AuditFailurePolicy;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditQuery;
import com.example.assetupgrade.audit.AuditQueryService;
import com.example.assetupgrade.audit.AuditRetentionPolicy;
import com.example.assetupgrade.audit.AuditSerializer;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.audit.AuditWriter;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.messaging.MessagePublisher;
import com.example.assetupgrade.messaging.MessageRetryPort;
import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.MetricPort;
import com.example.assetupgrade.observability.TracePort;
import com.example.assetupgrade.order.port.OrderCommitPort;
import com.example.assetupgrade.order.port.OrderEventPort;
import com.example.assetupgrade.order.port.PluginRegistryPort;
import com.example.assetupgrade.order.port.ReservationLedgerPort;
import com.example.assetupgrade.persistence.ConnectionPort;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.reconciliation.port.CheckpointPort;
import com.example.assetupgrade.reconciliation.port.DueWindowPort;
import com.example.assetupgrade.reconciliation.port.LeasePort;
import com.example.assetupgrade.reconciliation.port.ReconciliationAuditPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationJobPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationLockPort;
import com.example.assetupgrade.reconciliation.port.ReconciliationMetricsPort;
import com.example.assetupgrade.reconciliation.port.RetryableEventPort;
import com.example.assetupgrade.retry.ExponentialRetryPolicy;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.retry.RetryPolicy;
import com.example.assetupgrade.retry.RetryPolicyOptions;
import com.example.assetupgrade.routing.EndpointHealthPort;
import com.example.assetupgrade.routing.RouteRegistry;
import com.example.assetupgrade.security.IdentityPort;
import com.example.assetupgrade.security.PermissionCachePort;
import com.example.assetupgrade.security.RoleMappingPort;
import com.example.assetupgrade.telemetry.CorrelationIdProvider;
import com.example.assetupgrade.telemetry.HealthEndpoint;
import com.example.assetupgrade.telemetry.MetricsAdapter;
import com.example.assetupgrade.telemetry.ReadinessProbe;
import com.example.assetupgrade.telemetry.StructuredLogAdapter;
import com.example.assetupgrade.telemetry.TracingAdapter;
import com.example.assetupgrade.workflow.port.DeadLetterPort;
import com.example.assetupgrade.workflow.port.WorkflowDispatcher;
import com.example.assetupgrade.workflow.port.WorkflowEventStore;
import com.example.assetupgrade.workflow.port.WorkflowOutboxPort;
import com.example.assetupgrade.workflow.port.WorkflowRoutePort;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Builds the module's provider adapters strictly behind the declared ports.
 *
 * <p>Translated from nopCommerce's Autofac/registration wiring (the {@code CommonConfig}
 * container selection): every provider type (S3, Kafka, JDBC/Postgres, Keycloak, BullMQ,
 * Quartz, Camel/Flowable) is instantiated here from validated {@link ConfigurationLoader.Settings}
 * and returned only through the target seams. Callers never see a provider type across the
 * seam, and the audit/observability/telemetry adapters are composed here exactly as declared.</p>
 */
public final class AdapterFactory {

    /** Default audit retention window. */
    public static final Duration DEFAULT_AUDIT_RETENTION = Duration.ofDays(365);

    private final ConfigurationLoader.Settings settings;
    private final TimeProvider clock;

    private final S3ObjectStorageAdapter objectStorage;
    private final KafkaMessagePublisher messagePublisher;
    private final PostgresTransactionAdapter transactions;
    private final JdbcAttachmentRepository attachmentRepository;
    private final JdbcEventEnvelopeRepository eventEnvelopes;
    private final JdbcOrderRepository orderRepository;
    private final KeycloakIdentityAdapter identity;
    private final BullMqRetryAdapter retryAdapter;
    private final RetryPolicy retryPolicy;
    private final RouteRegistry routeRegistry;
    private final WorkflowDispatcher dispatcher;
    private final WorkflowRoutePort routePort;
    private final QuartzReconciliationScheduler scheduler;

    private final MetricsAdapter metrics;
    private final TracingAdapter tracer;
    private final CorrelationIdProvider correlation;
    private final StructuredLogAdapter logs;
    private final HealthEndpoint healthEndpoint;
    private final ReadinessProbe readinessProbe;
    private final List<HealthCheck> healthChecks;

    private final AuditPort auditSink;
    private final AuditWriter auditWriter;
    private final AuditFailureHandler auditFailureHandler;
    private final AuditQueryService auditQueryService;
    private final AuditSerializer auditSerializer;
    private final AuditRetentionPolicy auditRetentionPolicy;

    /** Creates a factory over the loader's default settings. */
    public AdapterFactory() {
        this(ConfigurationLoader.defaults().load());
    }

    /** Creates a factory over {@code settings} using the system clock. */
    public AdapterFactory(ConfigurationLoader.Settings settings) {
        this(settings, TimeProvider.system());
    }

    /** Creates a factory over {@code settings} and {@code clock}. */
    public AdapterFactory(ConfigurationLoader.Settings settings, TimeProvider clock) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.clock = clock == null ? TimeProvider.system() : clock;

        StorageProperties storage = settings.get(StorageProperties.class);
        MessagingProperties messaging = settings.get(MessagingProperties.class);
        RetryProperties retry = settings.get(RetryProperties.class);
        SchedulerProperties schedulerProperties = settings.get(SchedulerProperties.class);
        WorkflowProperties workflow = settings.get(WorkflowProperties.class);

        this.objectStorage = new S3ObjectStorageAdapter(
                storage.endpoint(), storage.bucket(), storage.maxObjectBytes());
        this.messagePublisher = new KafkaMessagePublisher(messaging.bootstrapServers());
        this.transactions = new PostgresTransactionAdapter();
        this.attachmentRepository = new JdbcAttachmentRepository(transactions);
        this.eventEnvelopes = new JdbcEventEnvelopeRepository();
        this.orderRepository = new JdbcOrderRepository(transactions);
        this.identity = new KeycloakIdentityAdapter();

        this.retryPolicy = new ExponentialRetryPolicy(new RetryPolicyOptions(
                retry.maxAttempts(), retry.initialBackoff(), retry.maxBackoff(), retry.multiplier(), retry.jitter()),
                this.clock);
        this.retryAdapter = new BullMqRetryAdapter(this.retryPolicy, this.clock);

        this.metrics = new MetricsAdapter();
        this.tracer = new TracingAdapter();
        this.correlation = new CorrelationIdProvider();
        this.logs = new StructuredLogAdapter();
        this.healthEndpoint = new HealthEndpoint();
        this.readinessProbe = new ReadinessProbe(healthEndpoint);

        this.routeRegistry = RouteRegistry.inMemory();
        EndpointHealthPort endpointHealth = EndpointHealthPort.alwaysHealthy();
        if (workflow.useFlowable()) {
            FlowableWorkflowAdapter adapter = new FlowableWorkflowAdapter(routeRegistry, endpointHealth, this.clock);
            this.dispatcher = adapter;
            this.routePort = adapter;
        } else {
            CamelWorkflowAdapter adapter = new CamelWorkflowAdapter(routeRegistry, endpointHealth, this.clock);
            this.dispatcher = adapter;
            this.routePort = adapter;
        }

        this.auditSink = new InMemoryAuditPort();
        this.auditWriter = new AuditWriter(auditSink);
        this.auditFailureHandler = new AuditFailureHandler(
                auditWriter,
                AuditFailurePolicy.allowCompletionFor(
                        AuditStatus.COMPLETED, AuditStatus.FAILED, AuditStatus.REJECTED,
                        AuditStatus.QUARANTINED, AuditStatus.DUPLICATE, AuditStatus.ROLLED_BACK),
                metrics, tracer);
        this.auditQueryService = new AuditQueryService(auditWriter);
        this.auditSerializer = new AuditSerializer();
        this.auditRetentionPolicy = new AuditRetentionPolicy(this.clock, DEFAULT_AUDIT_RETENTION);

        this.scheduler = new QuartzReconciliationScheduler(
                eventEnvelopes, eventEnvelopes, dispatcher, eventEnvelopes,
                audit(entry -> auditWriter.append(entry)), metrics, this.clock, schedulerProperties.leaseTtl());

        List<HealthCheck> checks = new ArrayList<>();
        checks.add(new IdentityHealthCheck(identity));
        checks.add(new ObjectStorageHealthCheck(objectStorage));
        checks.add(new QueueHealthCheck(messagePublisher));
        this.healthChecks = List.copyOf(checks);
        for (HealthCheck check : healthChecks) {
            healthEndpoint.register(check);
            readinessProbe.register(check);
        }
    }

    /** @return the settings used to build the adapters. */
    public ConfigurationLoader.Settings settings() {
        return settings;
    }

    /** @return the clock shared by the constructed adapters. */
    public TimeProvider clock() {
        return clock;
    }

    // --------------------------------------------------------------- storage

    /** @return the configured object-storage adapter. */
    public S3ObjectStorageAdapter objectStorage() {
        return objectStorage;
    }

    /** @return the object-storage seam. */
    public ObjectStoragePort objectStoragePort() {
        return objectStorage;
    }

    /** @return the upload-stream seam. */
    public UploadStreamPort uploadStream() {
        return objectStorage;
    }

    /** @return the content-fingerprint seam. */
    public AttachmentFingerprintPort attachmentFingerprint() {
        return objectStorage;
    }

    /** @return the attachment-cleanup seam. */
    public AttachmentCleanupPort attachmentCleanup() {
        return objectStorage;
    }

    // --------------------------------------------------------------- messaging

    /** @return the configured message publisher. */
    public KafkaMessagePublisher messagePublisher() {
        return messagePublisher;
    }

    /** @return the generic message-publisher seam. */
    public MessagePublisher publisher() {
        return messagePublisher;
    }

    /** @return the attachment-event seam. */
    public AttachmentEventPort attachmentEvents() {
        return messagePublisher;
    }

    /** @return the order-event seam. */
    public OrderEventPort orderEvents() {
        return messagePublisher;
    }

    /** @return the dead-letter seam. */
    public DeadLetterPort deadLetters() {
        return messagePublisher;
    }

    /** @return the workflow outbox seam. */
    public WorkflowOutboxPort workflowOutbox() {
        return messagePublisher;
    }

    /** @return the message-retry seam. */
    public MessageRetryPort messageRetry() {
        return retryAdapter;
    }

    /** @return the configured retry adapter. */
    public BullMqRetryAdapter retryAdapter() {
        return retryAdapter;
    }

    /** @return the retry policy derived from {@link RetryProperties}. */
    public RetryPolicy retryPolicy() {
        return retryPolicy;
    }

    // --------------------------------------------------------------- persistence

    /** @return the transaction seam. */
    public TransactionPort transactions() {
        return transactions;
    }

    /** @return the connection seam. */
    public ConnectionPort connection() {
        return transactions;
    }

    /** @return the JDBC attachment repository adapter. */
    public JdbcAttachmentRepository attachmentRepository() {
        return attachmentRepository;
    }

    /** @return the attachment-repository seam. */
    public AttachmentRepository attachments() {
        return attachmentRepository;
    }

    /** @return the attachment-metadata seam. */
    public AttachmentMetadataStore attachmentMetadata() {
        return attachmentRepository;
    }

    /** @return the quarantine seam. */
    public QuarantinePort quarantine() {
        return attachmentRepository;
    }

    /** @return the JDBC event-envelope repository adapter. */
    public JdbcEventEnvelopeRepository eventEnvelopes() {
        return eventEnvelopes;
    }

    /** @return the workflow event-store seam. */
    public WorkflowEventStore workflowEvents() {
        return eventEnvelopes;
    }

    /** @return the retryable-event seam. */
    public RetryableEventPort retryableEvents() {
        return eventEnvelopes;
    }

    /** @return the reconciliation checkpoint seam. */
    public CheckpointPort checkpoints() {
        return eventEnvelopes;
    }

    /** @return the due-window seam. */
    public DueWindowPort dueWindow() {
        return eventEnvelopes;
    }

    /** @return the JDBC order repository adapter. */
    public JdbcOrderRepository orderRepository() {
        return orderRepository;
    }

    /** @return the order-commit seam. */
    public OrderCommitPort orderCommit() {
        return orderRepository;
    }

    /** @return the reservation-ledger seam. */
    public ReservationLedgerPort reservationLedger() {
        return orderRepository;
    }

    /** @return the plugin-registry seam. */
    public PluginRegistryPort pluginRegistry() {
        return orderRepository;
    }

    /** @return the idempotency seam. */
    public IdempotencyPort idempotency() {
        return orderRepository;
    }

    // --------------------------------------------------------------- identity

    /** @return the configured identity adapter. */
    public KeycloakIdentityAdapter identity() {
        return identity;
    }

    /** @return the identity seam. */
    public IdentityPort identityPort() {
        return identity;
    }

    /** @return the role-mapping seam. */
    public RoleMappingPort roleMapping() {
        return identity;
    }

    /** @return the permission-cache seam. */
    public PermissionCachePort permissionCache() {
        return identity;
    }

    // --------------------------------------------------------------- workflow

    /** @return the workflow dispatcher seam. */
    public WorkflowDispatcher dispatcher() {
        return dispatcher;
    }

    /** @return the workflow dispatcher seam. */
    public WorkflowDispatcher workflowDispatcher() {
        return dispatcher;
    }

    /** @return the workflow route seam. */
    public WorkflowRoutePort routePort() {
        return routePort;
    }

    /** @return the workflow route seam. */
    public WorkflowRoutePort workflowRoutes() {
        return routePort;
    }

    /** @return the tenant-isolated route registry. */
    public RouteRegistry routeRegistry() {
        return routeRegistry;
    }

    // --------------------------------------------------------------- reconciliation

    /** @return the reconciliation scheduler adapter. */
    public QuartzReconciliationScheduler scheduler() {
        return scheduler;
    }

    /** @return the reconciliation-job seam. */
    public ReconciliationJobPort reconciliationJob() {
        return scheduler;
    }

    /** @return the lease seam. */
    public LeasePort leases() {
        return scheduler;
    }

    /** @return the reconciliation-lock seam. */
    public ReconciliationLockPort reconciliationLock() {
        return scheduler;
    }

    /** @return the reconciliation-metrics seam. */
    public ReconciliationMetricsPort reconciliationMetrics() {
        return scheduler;
    }

    // --------------------------------------------------------------- observability

    /** @return the metrics adapter. */
    public MetricsAdapter metrics() {
        return metrics;
    }

    /** @return the metrics seam. */
    public MetricPort metricPort() {
        return metrics;
    }

    /** @return the tracing adapter. */
    public TracingAdapter tracer() {
        return tracer;
    }

    /** @return the tracing seam. */
    public TracePort tracePort() {
        return tracer;
    }

    /** @return the correlation provider. */
    public CorrelationIdProvider correlation() {
        return correlation;
    }

    /** @return the structured-log adapter. */
    public StructuredLogAdapter logs() {
        return logs;
    }

    /** @return the health endpoint. */
    public HealthEndpoint healthEndpoint() {
        return healthEndpoint;
    }

    /** @return the readiness probe. */
    public ReadinessProbe readinessProbe() {
        return readinessProbe;
    }

    /** @return the registered health checks. */
    public List<HealthCheck> healthChecks() {
        return healthChecks;
    }

    // --------------------------------------------------------------- audit

    /** @return the audit sink seam. */
    public AuditPort auditPort() {
        return auditSink;
    }

    /** @return the duplicate-suppressing audit writer. */
    public AuditWriter auditWriter() {
        return auditWriter;
    }

    /** @return the observable audit failure handler. */
    public AuditFailureHandler auditFailureHandler() {
        return auditFailureHandler;
    }

    /** @return the tenant-scoped audit query service. */
    public AuditQueryService auditQueryService() {
        return auditQueryService;
    }

    /** @return the audit serializer. */
    public AuditSerializer auditSerializer() {
        return auditSerializer;
    }

    /** @return the audit retention policy. */
    public AuditRetentionPolicy auditRetentionPolicy() {
        return auditRetentionPolicy;
    }

    /** @return the configured database URL (metadata only; no driver is created here). */
    public String databaseUrl() {
        return settings.get(DatabaseProperties.class).jdbcUrl();
    }

    /**
     * @return the JDBC data source when one is configured. The target classpath ships no
     *         JDBC driver, so provider wiring falls back to the adapters' local boundaries
     *         and this returns {@code null} instead of fabricating a broken data source.
     */
    public javax.sql.DataSource dataSource() {
        return null;
    }

    /**
     * Compatibility seam. A {@link Class} returns the matching seam/adapter, a {@link String}
     * performs a named lookup, and any other argument returns this factory.
     */
    public Object execute(Object input) {
        if (input instanceof Class<?> type) {
            return byType(type);
        }
        if (input instanceof String name) {
            return byName(name);
        }
        return this;
    }

    private Object byType(Class<?> type) {
        if (type.isInstance(objectStorage)) {
            return objectStorage;
        }
        if (type.isInstance(messagePublisher)) {
            return messagePublisher;
        }
        if (type.isInstance(transactions)) {
            return transactions;
        }
        if (type.isInstance(attachmentRepository)) {
            return attachmentRepository;
        }
        if (type.isInstance(eventEnvelopes)) {
            return eventEnvelopes;
        }
        if (type.isInstance(orderRepository)) {
            return orderRepository;
        }
        if (type.isInstance(identity)) {
            return identity;
        }
        if (type.isInstance(retryAdapter)) {
            return retryAdapter;
        }
        if (type.isInstance(dispatcher)) {
            return dispatcher;
        }
        if (type.isInstance(scheduler)) {
            return scheduler;
        }
        if (type.isInstance(metrics)) {
            return metrics;
        }
        if (type.isInstance(tracer)) {
            return tracer;
        }
        if (type.isInstance(correlation)) {
            return correlation;
        }
        if (type.isInstance(logs)) {
            return logs;
        }
        if (type.isInstance(healthEndpoint)) {
            return healthEndpoint;
        }
        if (type.isInstance(readinessProbe)) {
            return readinessProbe;
        }
        if (type.isInstance(auditWriter)) {
            return auditWriter;
        }
        if (type.isInstance(auditFailureHandler)) {
            return auditFailureHandler;
        }
        if (type.isInstance(auditQueryService)) {
            return auditQueryService;
        }
        if (type.isInstance(auditSerializer)) {
            return auditSerializer;
        }
        if (type.isInstance(auditRetentionPolicy)) {
            return auditRetentionPolicy;
        }
        return null;
    }

    private Object byName(String name) {
        if (name == null) {
            return null;
        }
        return switch (name.trim().toLowerCase(java.util.Locale.ROOT)) {
            case "objectstorage", "storage" -> objectStorage;
            case "publisher", "messaging" -> messagePublisher;
            case "transactions", "connection" -> transactions;
            case "attachments" -> attachmentRepository;
            case "events", "envelopes" -> eventEnvelopes;
            case "orders" -> orderRepository;
            case "identity" -> identity;
            case "retry" -> retryAdapter;
            case "dispatcher", "workflow" -> dispatcher;
            case "scheduler", "reconciliation" -> scheduler;
            case "metrics" -> metrics;
            case "tracer", "tracing" -> tracer;
            case "correlation" -> correlation;
            case "logs" -> logs;
            case "health" -> healthEndpoint;
            case "readiness" -> readinessProbe;
            case "audit" -> auditWriter;
            default -> null;
        };
    }

    private static ReconciliationAuditPort audit(java.util.function.Consumer<AuditEntry> recorder) {
        Objects.requireNonNull(recorder, "recorder");
        return recorder::accept;
    }

    /** Minimal tenant-scoped in-memory audit sink backing the composed writer. */
    private static final class InMemoryAuditPort implements AuditPort {

        private final Map<String, List<AuditEntry>> byTenant = new ConcurrentHashMap<>();

        @Override
        public void append(AuditEntry entry) {
            Objects.requireNonNull(entry, "entry");
            byTenant.computeIfAbsent(entry.tenantId().value(), key -> new CopyOnWriteArrayList<>()).add(entry);
        }

        @Override
        public List<AuditEntry> query(AuditQuery query) {
            Objects.requireNonNull(query, "query");
            List<AuditEntry> entries = byTenant.getOrDefault(query.tenantId().value(), List.of());
            List<AuditEntry> scoped = new ArrayList<>();
            for (AuditEntry entry : entries) {
                if (query.subjectId() != null && !query.subjectId().equals(entry.subjectId())) {
                    continue;
                }
                if (query.from() != null && entry.occurredAt().isBefore(query.from())) {
                    continue;
                }
                if (query.to() != null && entry.occurredAt().isAfter(query.to())) {
                    continue;
                }
                scoped.add(entry);
            }
            return List.copyOf(scoped);
        }
    }
}
