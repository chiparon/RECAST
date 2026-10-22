package com.example.assetupgrade.adapters;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.routing.EndpointHealthPort;
import com.example.assetupgrade.routing.RouteDefinition;
import com.example.assetupgrade.routing.RouteRegistry;
import com.example.assetupgrade.workflow.DeliveryAttempt;
import com.example.assetupgrade.workflow.DeliveryStatus;
import com.example.assetupgrade.workflow.WorkflowEvent;
import com.example.assetupgrade.workflow.port.WorkflowDispatcher;
import com.example.assetupgrade.workflow.port.WorkflowRoutePort;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Flowable-shaped workflow dispatcher implementing {@link WorkflowDispatcher} and
 * {@link WorkflowRoutePort}.
 *
 * <p>{@link #resolve(String, WorkflowEvent)} returns the process definition (route target) registered
 * for the event's tenant; {@link #dispatch(WorkflowEvent, String, int)} starts the in-process
 * process instance and returns a fully populated {@link DeliveryAttempt}. A missing process
 * definition, an unhealthy endpoint or a start failure is reported {@link DeliveryStatus#RETRYABLE}
 * (or {@link DeliveryStatus#REJECTED}), never a fabricated {@code ACCEPTED}. Flowable-specific
 * concepts remain inside this adapter.</p>
 */
public final class FlowableWorkflowAdapter implements WorkflowDispatcher, WorkflowRoutePort {

    private final RouteRegistry registry;
    private final EndpointHealthPort health;
    private final TimeProvider clock;
    private final Map<String, List<ProcessInstance>> instancesByTenant = new ConcurrentHashMap<>();

    /** Creates a dispatcher with an empty in-memory process registry and the system clock. */
    public FlowableWorkflowAdapter() {
        this(RouteRegistry.inMemory(), null, TimeProvider.system());
    }

    /** Creates a dispatcher over {@code registry} with the system clock. */
    public FlowableWorkflowAdapter(RouteRegistry registry) {
        this(registry, null, TimeProvider.system());
    }

    /** Creates a dispatcher over {@code registry} using {@code clock}. */
    public FlowableWorkflowAdapter(RouteRegistry registry, TimeProvider clock) {
        this(registry, null, clock);
    }

    /** Creates a fully configured dispatcher. */
    public FlowableWorkflowAdapter(RouteRegistry registry, EndpointHealthPort health, TimeProvider clock) {
        this.registry = registry == null ? RouteRegistry.inMemory() : registry;
        this.health = health;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** @return a dispatcher over an empty in-memory registry. */
    public static FlowableWorkflowAdapter local() {
        return new FlowableWorkflowAdapter();
    }

    /** @return the transport protocol reported by this adapter. */
    public String protocol() {
        return "flowable";
    }

    /** Registers {@code processDefinition} for {@code tenantId}. */
    public FlowableWorkflowAdapter register(TenantId tenantId, RouteDefinition processDefinition) {
        registry.register(tenantId, processDefinition);
        return this;
    }

    @Override
    public String resolve(String routeKey, WorkflowEvent event) {
        if (routeKey == null || routeKey.isBlank() || event == null || event.tenantId() == null) {
            return null;
        }
        Optional<RouteDefinition> definition = registry.find(event.tenantId(), routeKey.trim());
        if (definition.isEmpty()) {
            return null;
        }
        RouteDefinition route = definition.get();
        String target = route.target();
        return target == null || target.isBlank() ? route.routeKey() : target;
    }

    @Override
    public DeliveryAttempt dispatch(WorkflowEvent event, String routeKey, int attemptNumber) {
        Objects.requireNonNull(event, "event");
        Objects.requireNonNull(routeKey, "routeKey");
        int attempt = Math.max(1, attemptNumber);
        Instant startedAt = clock.now();
        if (event.tenantId() == null) {
            return attempt(null, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                    "event tenant is required", startedAt, clock.now());
        }
        TenantId tenantId = event.tenantId();
        RouteDefinition definition = registry.find(tenantId, routeKey.trim()).orElse(null);
        if (definition == null) {
            return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                    "no process definition registered for key " + routeKey, startedAt, clock.now());
        }
        if (health != null) {
            boolean healthy;
            try {
                healthy = health.isHealthy(tenantId, definition);
            } catch (RuntimeException failure) {
                healthy = false;
            }
            if (!healthy) {
                return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                        "process engine endpoint for " + routeKey + " is unhealthy", startedAt, clock.now());
            }
        }
        try {
            String processDefinitionKey = definition.target() == null ? definition.routeKey() : definition.target();
            instancesByTenant.computeIfAbsent(tenantId.value(), key -> new ArrayList<>())
                    .add(new ProcessInstance(event.eventId(), processDefinitionKey, clock.now()));
            return attempt(tenantId, event.eventId(), attempt, true, DeliveryStatus.ACCEPTED,
                    "started process " + processDefinitionKey, startedAt, clock.now());
        } catch (RuntimeException failure) {
            return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                    "flowable process start failed: " + failure.getMessage(), startedAt, clock.now());
        }
    }

    /** @return the in-process process instances recorded for {@code tenantId}. */
    public List<ProcessInstance> instances(TenantId tenantId) {
        if (tenantId == null) {
            return List.of();
        }
        List<ProcessInstance> instances = instancesByTenant.get(tenantId.value());
        return instances == null ? List.of() : List.copyOf(instances);
    }

    /** @return the number of process instances recorded for {@code tenantId}. */
    public int instanceCount(TenantId tenantId) {
        if (tenantId == null) {
            return 0;
        }
        List<ProcessInstance> instances = instancesByTenant.get(tenantId.value());
        return instances == null ? 0 : instances.size();
    }

    private static DeliveryAttempt attempt(TenantId tenantId, String eventId, int attemptNumber,
                                           boolean accepted, DeliveryStatus status, String detail,
                                           Instant startedAt, Instant finishedAt) {
        return new DeliveryAttempt(eventId, tenantId, attemptNumber, accepted, status, detail,
                startedAt, finishedAt);
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof CamelWorkflowAdapter.DispatchRequest request) {
            return dispatch(request.event(), request.routeKey(), request.attemptNumber());
        }
        if (input instanceof DispatchRequest request) {
            return dispatch(request.event(), request.routeKey(), request.attemptNumber());
        }
        if (input instanceof RouteRequest request) {
            return resolve(request.routeKey(), request.event());
        }
        throw new IllegalArgumentException("unsupported flowable workflow request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record DispatchRequest(WorkflowEvent event, String routeKey, int attemptNumber) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record RouteRequest(String routeKey, WorkflowEvent event) {
    }

    /**
     * A single in-process process instance started by this adapter.
     *
     * @param eventId                the business key event identity
     * @param processDefinitionKey   the started process definition key
     * @param startedAt              the instant the instance was started
     */
    public record ProcessInstance(String eventId, String processDefinitionKey, Instant startedAt) {
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
