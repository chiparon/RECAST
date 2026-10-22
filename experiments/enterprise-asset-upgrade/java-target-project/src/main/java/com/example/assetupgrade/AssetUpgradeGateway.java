package com.example.assetupgrade;

import com.example.assetupgrade.adapters.JdbcEventEnvelopeRepository;
import com.example.assetupgrade.adapters.KeycloakIdentityAdapter;
import com.example.assetupgrade.application.ApplicationModule;
import com.example.assetupgrade.application.CommandValidator;
import com.example.assetupgrade.attachment.AttachmentContent;
import com.example.assetupgrade.attachment.AttachmentIntakeHandler;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.config.AdapterFactory;
import com.example.assetupgrade.config.ConfigurationLoader;
import com.example.assetupgrade.observability.LogContext;
import com.example.assetupgrade.order.OrderLifecycleCoordinator;
import com.example.assetupgrade.order.OrderValidator;
import com.example.assetupgrade.reconciliation.ReconciliationOrchestrator;
import com.example.assetupgrade.security.AuthorizationAuditHandler;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.PermissionPolicy;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantBoundaryFilter;
import com.example.assetupgrade.security.TenantScopeResolver;
import com.example.assetupgrade.telemetry.StructuredLogAdapter;
import com.example.assetupgrade.web.ApiError;
import com.example.assetupgrade.web.AssetUpgradeEndpoints;
import com.example.assetupgrade.web.AttachmentRequest;
import com.example.assetupgrade.web.OrderLineDto;
import com.example.assetupgrade.web.OrderRequestDto;
import com.example.assetupgrade.web.RequestContextResolver;
import com.example.assetupgrade.web.ResponseMapper;
import com.example.assetupgrade.web.WorkflowEventRequest;
import com.example.assetupgrade.workflow.DeliveryAttempt;
import com.example.assetupgrade.workflow.WorkflowDeliveryCoordinator;
import com.example.assetupgrade.workflow.WorkflowState;
import com.example.assetupgrade.workflow.port.DeliveryAttemptRepository;

import java.nio.charset.StandardCharsets;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;

/**
 * Executable entrypoint for the asset-upgrade gateway.
 *
 * <p>Closes the call chain over the real adapter composition root: the validated
 * {@link ConfigurationLoader} settings build an {@link AdapterFactory}, the four feature
 * boundaries are composed from the adapter ports through their documented constructors, and
 * an {@link ApplicationModule} exposes the completed service chain behind
 * {@link AssetUpgradeEndpoints}. No provider type is fabricated and every tenant, quarantine,
 * delivery, idempotency and audit rule stays in the application and feature services.</p>
 *
 * <p>{@link #main(String[])} drives the four public requirements end to end so a normal
 * caller exercises the completed chain; a clean bootstrap returns exit code {@code 0} and a
 * bootstrap or execution failure returns a non-zero code with an {@link ApiError}-derived
 * message.</p>
 */
public final class AssetUpgradeGateway {

    /** Tenant used by the executable demonstration when no argument is supplied. */
    public static final String DEMO_TENANT = "tenant-demo";

    /** Actor used by the executable demonstration when no argument is supplied. */
    public static final String DEMO_ACTOR = "actor-demo";

    /** Utility entry point. */
    public AssetUpgradeGateway() {
    }

    /**
     * Executable entrypoint required by the jar manifest.
     *
     * <p>Delegates to {@link #run(String[])} and reports the outcome. The JVM exit code is
     * left to the caller so the bootstrap can also be exercised in-process.</p>
     */
    public static void main(String[] args) {
        int exitCode = run(args);
        if (exitCode != 0) {
            System.err.println("asset-upgrade gateway exited with code " + exitCode);
        }
    }

    /**
     * Boots the gateway and drives the four public requirements.
     *
     * @return {@code 0} on a clean run, {@code 1} when bootstrap or execution fails
     */
    public static int run(String[] args) {
        Wiring wiring;
        try {
            wiring = bootstrap();
        } catch (RuntimeException failure) {
            System.err.println("asset-upgrade gateway bootstrap failed: " + describe(failure));
            return 1;
        }

        String tenant = argument(args, 0, DEMO_TENANT);
        String actor = argument(args, 1, DEMO_ACTOR);
        String correlation = CorrelationId.generate().value();
        LogContext log = LogContext.of(CorrelationId.of(correlation), TenantId.of(tenant));
        StructuredLogAdapter logs = wiring.module().logs();

        emit(logs, "INFO", "asset-upgrade gateway starting", log);
        emit(logs, "INFO", "health=" + wiring.module().healthEndpoint().status().marker()
                + " ready=" + wiring.module().readinessProbe().isReady(), log);

        seedDemoPrincipal(wiring, tenant, actor);

        try {
            report("attachment-intake", wiring.endpoints().intakeAttachment(attachmentRequest(tenant, actor, correlation)),
                    logs, log);
            report("workflow-delivery", wiring.endpoints().deliverWorkflowEvent(workflowRequest(tenant, actor, correlation)),
                    logs, log);
            report("order-submission", wiring.endpoints().submitOrder(orderRequest(tenant, actor)), logs, log);
            report("reconciliation-run",
                    wiring.endpoints().runReconciliation(tenant, actor, correlation,
                            AssetUpgradeEndpoints.DEFAULT_RECONCILIATION_LIMIT, "reconciliation-demo"),
                    logs, log);
        } catch (RuntimeException failure) {
            emit(logs, "ERROR", "asset-upgrade gateway run failed: " + describe(failure), log);
            return 1;
        }

        emit(logs, "INFO", "asset-upgrade gateway completed", log);
        return 0;
    }

    /** @return the validated settings, adapters, module and endpoints graph. */
    public static Wiring bootstrap() {
        ConfigurationLoader.Settings settings = ConfigurationLoader.defaults().load();
        AdapterFactory adapters = new AdapterFactory(settings);
        return wire(settings, adapters);
    }

    /** Alias of {@link #bootstrap()} matching the composition-root naming. */
    public static Wiring wire() {
        return bootstrap();
    }

    /** @return the completed application service chain over the real adapters. */
    public static ApplicationModule module() {
        return bootstrap().module();
    }

    /** @return the public API surface over the completed application service chain. */
    public static AssetUpgradeEndpoints endpoints() {
        return bootstrap().endpoints();
    }

    /**
     * Composes the module over {@code settings} and {@code adapters}.
     *
     * <p>Only ports with a real adapter accessor are injected; an absent optional port is
     * left {@code null} so the feature boundaries keep their documented fail-closed
     * degradation rather than a fabricated provider.</p>
     */
    public static Wiring wire(ConfigurationLoader.Settings settings, AdapterFactory adapters) {
        TenantAuthorizer authorizer = authorizer(adapters);

        AttachmentIntakeHandler attachment = new AttachmentIntakeHandler(
                authorizer,
                null,
                null,
                adapters.attachments(),
                adapters.quarantine(),
                adapters.attachmentEvents(),
                adapters.auditPort(),
                adapters.idempotency(),
                adapters.attachmentFingerprint(),
                null,
                adapters.attachmentMetadata(),
                adapters.objectStoragePort(),
                adapters.uploadStream(),
                adapters.metricPort());

        JdbcEventEnvelopeRepository envelopes = adapters.eventEnvelopes();
        DeliveryAttemptRepository attempts = attempts(envelopes);

        WorkflowDeliveryCoordinator workflow = new WorkflowDeliveryCoordinator(
                authorizer,
                adapters.workflowDispatcher(),
                envelopes,
                attempts,
                adapters.auditPort(),
                adapters.idempotency(),
                adapters.retryPolicy(),
                adapters.deadLetters(),
                adapters.workflowRoutes(),
                adapters.workflowOutbox(),
                null,
                envelopes,
                adapters.workflowEvents(),
                adapters.clock());

        OrderLifecycleCoordinator order = new OrderLifecycleCoordinator(
                OrderValidator.defaults(),
                null,
                adapters.orderCommit(),
                adapters.reservationLedger(),
                null,
                adapters.pluginRegistry(),
                adapters.auditPort(),
                adapters.idempotency(),
                adapters.transactions(),
                null,
                null,
                null,
                adapters.orderEvents(),
                adapters.clock());

        ReconciliationOrchestrator reconciliation = new ReconciliationOrchestrator(
                authorizer,
                adapters.dueWindow(),
                adapters.retryableEvents(),
                adapters.leases(),
                adapters.checkpoints(),
                adapters.auditPort(),
                workflow,
                adapters.reconciliationMetrics(),
                adapters.reconciliationLock(),
                adapters.clock());

        CommandValidator commandValidator = new CommandValidator(adapters.correlation());
        ApplicationModule module = new ApplicationModule(
                attachment,
                workflow,
                order,
                reconciliation,
                commandValidator,
                authorizer,
                adapters.idempotency(),
                adapters.transactions(),
                adapters.auditPort(),
                adapters.correlation(),
                adapters.metricPort(),
                adapters.tracePort());

        RequestContextResolver contexts = RequestContextResolver.of(adapters.correlation());
        ResponseMapper mapper = ResponseMapper.defaults();
        AssetUpgradeEndpoints endpoints = AssetUpgradeEndpoints.of(module.assetUpgradeApplication(), contexts, mapper);
        return new Wiring(settings, adapters, module, endpoints, contexts, mapper);
    }

    private static TenantAuthorizer authorizer(AdapterFactory adapters) {
        AuditPort audit = adapters.auditPort();
        return new TenantBoundaryFilter(
                new TenantScopeResolver(adapters.identityPort(), adapters.roleMapping(), adapters.permissionCache(),
                        adapters.clock()),
                new PermissionPolicy(adapters.roleMapping(), adapters.permissionCache(), adapters.clock()),
                new AuthorizationAuditHandler(audit, null, adapters.clock()));
    }

    private static DeliveryAttemptRepository attempts(JdbcEventEnvelopeRepository envelopes) {
        if (envelopes == null) {
            return null;
        }
        return new DeliveryAttemptRepository() {
            @Override
            public void append(DeliveryAttempt attempt) {
                envelopes.append(attempt);
            }

            @Override
            public List<DeliveryAttempt> find(TenantId tenantId, String eventId) {
                return envelopes.findAttempts(tenantId, eventId);
            }
        };
    }

    private static void seedDemoPrincipal(Wiring wiring, String tenant, String actor) {
        Object identity = wiring.adapters().identity();
        if (identity instanceof KeycloakIdentityAdapter keycloak) {
            keycloak.grant(TenantId.of(tenant), ActorId.of(actor),
                    EnumSet.of(Permission.ATTACHMENT_SUBMIT, Permission.WORKFLOW_DISPATCH,
                            Permission.ORDER_SUBMIT, Permission.RECONCILIATION_RUN));
        }
    }

    private static AttachmentRequest attachmentRequest(String tenant, String actor, String correlation) {
        AttachmentContent content = AttachmentContent.of("asset upgrade sample".getBytes(StandardCharsets.UTF_8));
        return new AttachmentRequest("attachment-demo", tenant, actor, correlation, "demo.txt", "text/plain",
                content.length(), content);
    }

    private static WorkflowEventRequest workflowRequest(String tenant, String actor, String correlation) {
        return new WorkflowEventRequest("event-demo", tenant, actor, WorkflowState.APPROVED, "route-demo",
                Map.of("eventType", "asset.upgrade.approved", "assetId", "asset-demo"), correlation);
    }

    private static OrderRequestDto orderRequest(String tenant, String actor) {
        List<OrderLineDto> lines = List.of(new OrderLineDto("SKU-1", 2, 1000L));
        return new OrderRequestDto("order-demo", tenant, actor, "USD", lines, "plugin-demo");
    }

    private static void report(String name, Object result, StructuredLogAdapter logs, LogContext log) {
        if (result instanceof ApiError error) {
            emit(logs, "WARN", name + " -> " + error.status() + " " + error.code() + ": " + error.message(), log);
            return;
        }
        if (result instanceof List<?> errors && !errors.isEmpty() && errors.get(0) instanceof ApiError first) {
            emit(logs, "WARN", name + " -> " + first.status() + " " + first.code() + ": " + first.message()
                    + " (" + errors.size() + ")", log);
            return;
        }
        emit(logs, "INFO", name + " -> " + String.valueOf(result), log);
    }

    private static void emit(StructuredLogAdapter logs, String level, String message, LogContext log) {
        logs.log(level, message, log);
        System.out.println(logs.render(level, message, log));
    }

    private static String argument(String[] args, int index, String fallback) {
        if (args == null || index >= args.length || args[index] == null || args[index].isBlank()) {
            return fallback;
        }
        return args[index].trim();
    }

    private static String describe(Throwable failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getName() : message;
    }

    /** Composed gateway graph exposed for callers and tests. */
    public record Wiring(ConfigurationLoader.Settings settings,
                         AdapterFactory adapters,
                         ApplicationModule module,
                         AssetUpgradeEndpoints endpoints,
                         RequestContextResolver contexts,
                         ResponseMapper mapper) {

        /** @return the completed application service chain. */
        public com.example.assetupgrade.application.AssetUpgradeApplication application() {
            return module.assetUpgradeApplication();
        }
    }
}
