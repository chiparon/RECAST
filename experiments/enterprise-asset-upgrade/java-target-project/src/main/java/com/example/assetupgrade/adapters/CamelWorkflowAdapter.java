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
 * Camel-shaped workflow dispatcher implementing {@link WorkflowDispatcher} and
 * {@link WorkflowRoutePort}.
 *
 * <p>{@link #resolve(String, WorkflowEvent)} resolves the tenant-scoped route registered under
 * {@code routeKey} and returns its concrete target; {@link #dispatch(WorkflowEvent, String, int)}
 * performs the in-process delivery step and returns a fully populated {@link DeliveryAttempt}. Route
 * resolution failures, unhealthy endpoints and transport exceptions are converted into a
 * {@link DeliveryStatus#RETRYABLE} attempt - the adapter never fabricates an {@code ACCEPTED}
 * delivery. All Camel-specific routing concepts stay inside this adapter; the application layer
 * only ever sees the ports.</p>
 *
 * <p>Only {@code direct:}/{@code local:}/{@code seda:}/{@code vm:} (and an unspecified protocol)
 * targets are delivered in-process. A remote protocol such as {@code http}, {@code kafka} or
 * {@code mqtt} has no transport configured here, so it is reported {@code RETRYABLE} rather than
 * falsely acknowledged.</p>
 */
public final class CamelWorkflowAdapter implements WorkflowDispatcher, WorkflowRoutePort {

    private final RouteRegistry registry;
    private final EndpointHealthPort health;
    private final TimeProvider clock;
    private final Map<String, List<DeliveryRecord>> deliveredByTenant = new ConcurrentHashMap<>();

    /** Creates a dispatcher with an empty in-memory route registry and the system clock. */
    public CamelWorkflowAdapter() {
        this(RouteRegistry.inMemory(), null, TimeProvider.system());
    }

    /** Creates a dispatcher over {@code registry} with the system clock. */
    public CamelWorkflowAdapter(RouteRegistry registry) {
        this(registry, null, TimeProvider.system());
    }

    /** Creates a dispatcher over {@code registry} using {@code clock}. */
    public CamelWorkflowAdapter(RouteRegistry registry, TimeProvider clock) {
        this(registry, null, clock);
    }

    /** Creates a fully configured dispatcher. */
    public CamelWorkflowAdapter(RouteRegistry registry, EndpointHealthPort health, TimeProvider clock) {
        this.registry = registry == null ? RouteRegistry.inMemory() : registry;
        this.health = health;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** @return a dispatcher over an empty in-memory registry. */
    public static CamelWorkflowAdapter local() {
        return new CamelWorkflowAdapter();
    }

    /** @return the transport protocol reported by this adapter. */
    public String protocol() {
        return "camel";
    }

    /** Registers {@code route} for {@code tenantId}. */
    public CamelWorkflowAdapter register(TenantId tenantId, RouteDefinition route) {
        registry.register(tenantId, route);
        return this;
    }

    @Override
    public String resolve(String routeKey, WorkflowEvent event) {
        if (routeKey == null || routeKey.isBlank() || event == null || event.tenantId() == null) {
            return null;
        }
        Optional<RouteDefinition> route = registry.find(event.tenantId(), routeKey.trim());
        if (route.isEmpty()) {
            return null;
        }
        RouteDefinition definition = route.get();
        String target = definition.target();
        return target == null || target.isBlank() ? definition.routeKey() : target;
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
        RouteDefinition route = registry.find(tenantId, routeKey.trim()).orElse(null);
        if (route == null) {
            return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                    "no route registered for key " + routeKey, startedAt, clock.now());
        }
        if (health != null) {
            boolean healthy;
            try {
                healthy = health.isHealthy(tenantId, route);
            } catch (RuntimeException failure) {
                healthy = false;
            }
            if (!healthy) {
                return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                        "endpoint for route " + routeKey + " is unhealthy", startedAt, clock.now());
            }
        }
        String protocol = route.protocol();
        if (protocol != null && !isLocalProtocol(protocol)) {
            return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                    "transport for protocol '" + protocol + "' is not configured", startedAt, clock.now());
        }
        try {
            record(tenantId, event, route);
        } catch (RuntimeException failure) {
            return attempt(tenantId, event.eventId(), attempt, false, DeliveryStatus.RETRYABLE,
                    "camel delivery failed: " + failure.getMessage(), startedAt, clock.now());
        }
        String target = route.target() == null ? route.routeKey() : route.target();
        return attempt(tenantId, event.eventId(), attempt, true, DeliveryStatus.ACCEPTED,
                "delivered to " + target, startedAt, clock.now());
    }

    /** @return the in-process deliveries recorded for {@code tenantId}. */
    public List<DeliveryRecord> deliveries(TenantId tenantId) {
        if (tenantId == null) {
            return List.of();
        }
        List<DeliveryRecord> records = deliveredByTenant.get(tenantId.value());
        return records == null ? List.of() : List.copyOf(records);
    }

    /** @return the number of in-process deliveries recorded for {@code tenantId}. */
    public int deliveryCount(TenantId tenantId) {
        if (tenantId == null) {
            return 0;
        }
        List<DeliveryRecord> records = deliveredByTenant.get(tenantId.value());
        return records == null ? 0 : records.size();
    }

    private void record(TenantId tenantId, WorkflowEvent event, RouteDefinition route) {
        deliveredByTenant.computeIfAbsent(tenantId.value(), key -> new ArrayList<>())
                .add(new DeliveryRecord(event.eventId(), route.routeKey(),
                        route.target() == null ? route.routeKey() : route.target(), clock.now()));
    }

    private static boolean isLocalProtocol(String protocol) {
        String normalized = protocol.trim().toLowerCase(java.util.Locale.ROOT);
        return switch (normalized) {
            case "direct", "local", "in-process", "inprocess", "seda", "vm", "camel", "flowable", "test" -> true;
            default -> false;
        };
    }

    private static DeliveryAttempt attempt(TenantId tenantId, String eventId, int attemptNumber,
                                           boolean accepted, DeliveryStatus status, String detail,
                                           Instant startedAt, Instant finishedAt) {
        return new DeliveryAttempt(eventId, tenantId, attemptNumber, accepted, status, detail,
                startedAt, finishedAt);
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof DispatchRequest request) {
            return dispatch(request.event(), request.routeKey(), request.attemptNumber());
        }
        if (input instanceof RouteRequest request) {
            return resolve(request.routeKey(), request.event());
        }
        throw new IllegalArgumentException("unsupported camel workflow request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record DispatchRequest(WorkflowEvent event, String routeKey, int attemptNumber) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record RouteRequest(String routeKey, WorkflowEvent event) {
    }

    /**
     * A single in-process delivery recorded by this adapter.
     *
     * @param eventId the delivered event identity
     * @param routeKey the route key used for resolution
     * @param target   the concrete endpoint target
     * @param at       the instant the delivery was recorded
     */
    public record DeliveryRecord(String eventId, String routeKey, String target, Instant at) {
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
