package com.example.assetupgrade.application;

import com.example.assetupgrade.attachment.AttachmentIntakeHandler;
import com.example.assetupgrade.attachment.AttachmentIntakeService;
import com.example.assetupgrade.audit.AuditDecorator;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditFailureHandler;
import com.example.assetupgrade.audit.AuditFailurePolicy;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditQuery;
import com.example.assetupgrade.audit.AuditWriter;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.observability.CorrelationPort;
import com.example.assetupgrade.observability.MetricPort;
import com.example.assetupgrade.observability.TracePort;
import com.example.assetupgrade.order.OrderLifecycleCoordinator;
import com.example.assetupgrade.order.OrderPluginBridge;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.reconciliation.ReconciliationOrchestrator;
import com.example.assetupgrade.reconciliation.ReconciliationService;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.telemetry.CorrelationIdProvider;
import com.example.assetupgrade.telemetry.HealthEndpoint;
import com.example.assetupgrade.telemetry.MetricsAdapter;
import com.example.assetupgrade.telemetry.ReadinessProbe;
import com.example.assetupgrade.telemetry.StructuredLogAdapter;
import com.example.assetupgrade.telemetry.TracingAdapter;
import com.example.assetupgrade.workflow.WorkflowDeliveryCoordinator;
import com.example.assetupgrade.workflow.WorkflowDeliveryService;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Composition root for the asset-upgrade application module.
 *
 * <p>Builds the four application use-case services, the lifecycle coordinator and the public
 * façade over the reused feature boundaries (attachment intake, workflow delivery, order
 * plugin bridge, reconciliation) and the audit, observability, security, retry and
 * persistence ports. The no-arg construction wires a fail-closed in-memory graph - no
 * provider type is constructed here and no scanner, dispatcher, plugin registry or due
 * window is invented - while an explicit constructor accepts already-composed feature
 * services for production wiring. The typed accessors below keep the existing
 * {@code ModuleWiring} accessor signatures compiling unchanged.</p>
 */
public final class ApplicationModule {

    private final CommandValidator commandValidator;
    private final AttachmentApplicationService attachmentApplicationService;
    private final WorkflowApplicationService workflowApplicationService;
    private final OrderApplicationService orderApplicationService;
    private final ReconciliationApplicationService reconciliationApplicationService;
    private final AssetLifecycleCoordinator assetLifecycleCoordinator;
    private final AssetUpgradeApplication assetUpgradeApplication;

    private final AuditPort auditPort;
    private final AuditDecorator auditDecorator;
    private final IdempotencyPort idempotency;
    private final TransactionPort transaction;
    private final CorrelationPort correlationPort;
    private final MetricPort metricPort;
    private final TracePort tracePort;
    private final StructuredLogAdapter logs;
    private final HealthEndpoint healthEndpoint;
    private final ReadinessProbe readinessProbe;
    private final TimeProvider clock;

    /** Wires the fail-closed default graph. */
    public ApplicationModule() {
        this(new Graph(null, null, null, null, null, null, null, null, null, null, null, null));
    }

    /** Wires the module over the four reused feature boundaries. */
    public ApplicationModule(AttachmentIntakeService attachmentIntakeService,
                             WorkflowDeliveryService workflowDeliveryService,
                             OrderPluginBridge orderPluginBridge,
                             ReconciliationService reconciliationService) {
        this(new Graph(attachmentIntakeService, workflowDeliveryService, orderPluginBridge, reconciliationService,
                null, null, null, null, null, null, null, null));
    }

    /** Wires the module with the full collaborator set. */
    public ApplicationModule(AttachmentIntakeService attachmentIntakeService,
                             WorkflowDeliveryService workflowDeliveryService,
                             OrderPluginBridge orderPluginBridge,
                             ReconciliationService reconciliationService,
                             CommandValidator commandValidator,
                             TenantAuthorizer authorizer,
                             IdempotencyPort idempotency,
                             TransactionPort transaction,
                             AuditPort auditPort,
                             CorrelationPort correlationPort,
                             MetricPort metricPort,
                             TracePort tracePort) {
        this(new Graph(attachmentIntakeService, workflowDeliveryService, orderPluginBridge, reconciliationService,
                commandValidator, authorizer, idempotency, transaction, auditPort, correlationPort, metricPort,
                tracePort));
    }

    private ApplicationModule(Graph graph) {
        CorrelationIdProvider defaultCorrelation = new CorrelationIdProvider();
        this.correlationPort = graph.correlationPort() == null ? defaultCorrelation : graph.correlationPort();
        this.metricPort = graph.metricPort() == null ? new MetricsAdapter() : graph.metricPort();
        this.tracePort = graph.tracePort() == null ? new TracingAdapter() : graph.tracePort();
        this.logs = new StructuredLogAdapter();
        this.healthEndpoint = new HealthEndpoint();
        this.readinessProbe = new ReadinessProbe(this.healthEndpoint);
        this.clock = TimeProvider.system();
        this.auditPort = graph.auditPort() == null ? new AuditWriter(new InMemoryAuditPort()) : graph.auditPort();
        AuditFailureHandler failureHandler = new AuditFailureHandler(auditPort,
                AuditFailurePolicy.forbidCompletion(), metricPort, tracePort);
        this.auditDecorator = new AuditDecorator(auditPort, failureHandler, clock);
        this.idempotency = graph.idempotency() == null ? new InMemoryIdempotencyPort() : graph.idempotency();
        this.transaction = graph.transaction();
        this.commandValidator = graph.commandValidator() == null
                ? new CommandValidator(correlationPort) : graph.commandValidator();

        WorkflowDeliveryService workflow = graph.workflowDeliveryService() == null
                ? new WorkflowDeliveryCoordinator(null, null, null, null, auditPort, idempotency, null, null)
                : graph.workflowDeliveryService();
        AttachmentIntakeService attachment = graph.attachmentIntakeService() == null
                ? new AttachmentIntakeHandler(null, null, null, null, null, null, auditPort, idempotency)
                : graph.attachmentIntakeService();
        OrderPluginBridge order = graph.orderPluginBridge() == null
                ? new OrderLifecycleCoordinator(null, null, null, null, null, null, auditPort, idempotency,
                        transaction)
                : graph.orderPluginBridge();
        ReconciliationService reconciliation = graph.reconciliationService() == null
                ? new ReconciliationOrchestrator(null, null, null, null, null, auditPort, workflow)
                : graph.reconciliationService();

        this.attachmentApplicationService = new AttachmentApplicationService(attachment, commandValidator,
                graph.authorizer(), correlationPort, auditDecorator, auditPort, idempotency, metricPort, clock);
        this.workflowApplicationService = new WorkflowApplicationService(workflow, commandValidator,
                graph.authorizer(), correlationPort, auditDecorator, auditPort, idempotency, metricPort, clock);
        this.orderApplicationService = new OrderApplicationService(order, commandValidator,
                graph.authorizer(), correlationPort, auditDecorator, auditPort, idempotency, transaction, metricPort,
                clock);
        this.reconciliationApplicationService = new ReconciliationApplicationService(reconciliation, commandValidator,
                graph.authorizer(), correlationPort, auditDecorator, auditPort, metricPort, clock);

        this.assetLifecycleCoordinator = new AssetLifecycleCoordinator(attachmentApplicationService,
                workflowApplicationService, orderApplicationService, reconciliationApplicationService,
                commandValidator);
        this.assetUpgradeApplication = new AssetUpgradeApplication(attachmentApplicationService,
                workflowApplicationService, orderApplicationService, reconciliationApplicationService,
                assetLifecycleCoordinator, correlationPort);
    }

    /** Creates a module over the four reused feature boundaries. */
    public static ApplicationModule of(AttachmentIntakeService attachmentIntakeService,
                                       WorkflowDeliveryService workflowDeliveryService,
                                       OrderPluginBridge orderPluginBridge,
                                       ReconciliationService reconciliationService) {
        return new ApplicationModule(attachmentIntakeService, workflowDeliveryService, orderPluginBridge,
                reconciliationService);
    }

    /** Compatibility seam: dispatches a command through the public façade. */
    public Object execute(Object input) {
        return assetUpgradeApplication.execute(input);
    }

    /** @return the identity/state validator shared by the application services. */
    public CommandValidator commandValidator() {
        return commandValidator;
    }

    /** @return the attachment application service. */
    public AttachmentApplicationService attachmentApplicationService() {
        return attachmentApplicationService;
    }

    /** @return the order application service. */
    public OrderApplicationService orderApplicationService() {
        return orderApplicationService;
    }

    /** @return the workflow application service. */
    public WorkflowApplicationService workflowApplicationService() {
        return workflowApplicationService;
    }

    /** @return the reconciliation application service. */
    public ReconciliationApplicationService reconciliationApplicationService() {
        return reconciliationApplicationService;
    }

    /** @return the cross-domain lifecycle coordinator. */
    public AssetLifecycleCoordinator assetLifecycleCoordinator() {
        return assetLifecycleCoordinator;
    }

    /** @return the public application façade. */
    public AssetUpgradeApplication assetUpgradeApplication() {
        return assetUpgradeApplication;
    }

    /** @return the audit append/query seam shared by the composed graph. */
    public AuditPort auditPort() {
        return auditPort;
    }

    /** @return the audit decorator over the composed audit port. */
    public AuditDecorator auditDecorator() {
        return auditDecorator;
    }

    /** @return the tenant-qualified idempotency seam. */
    public IdempotencyPort idempotency() {
        return idempotency;
    }

    /** @return the atomic transaction boundary, or {@code null} when unconfigured. */
    public TransactionPort transaction() {
        return transaction;
    }

    /** @return the correlation resolution port. */
    public CorrelationPort correlationPort() {
        return correlationPort;
    }

    /** @return the metrics seam. */
    public MetricPort metrics() {
        return metricPort;
    }

    /** @return the tracing seam. */
    public TracePort tracer() {
        return tracePort;
    }

    /** @return the structured logging adapter. */
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

    /** @return the injected clock. */
    public TimeProvider clock() {
        return clock;
    }

    /** Immutable parameter carrier so every public constructor shares one wiring path. */
    private record Graph(AttachmentIntakeService attachmentIntakeService,
                         WorkflowDeliveryService workflowDeliveryService,
                         OrderPluginBridge orderPluginBridge,
                         ReconciliationService reconciliationService,
                         CommandValidator commandValidator,
                         TenantAuthorizer authorizer,
                         IdempotencyPort idempotency,
                         TransactionPort transaction,
                         AuditPort auditPort,
                         CorrelationPort correlationPort,
                         MetricPort metricPort,
                         TracePort tracePort) {
    }

    /** Minimal tenant-scoped in-memory audit sink backing the default graph. */
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

    /** In-memory, tenant-qualified idempotency store backing the default graph. */
    private static final class InMemoryIdempotencyPort implements IdempotencyPort {

        private final Set<String> completed = ConcurrentHashMap.newKeySet();

        @Override
        public boolean isCompleted(IdempotencyKey key) {
            return key != null && completed.contains(key.asString());
        }

        @Override
        public boolean tryMarkCompleted(IdempotencyKey key) {
            return key != null && completed.add(key.asString());
        }

        @Override
        public void remove(IdempotencyKey key) {
            if (key != null) {
                completed.remove(key.asString());
            }
        }
    }
}
