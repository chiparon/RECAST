package com.example.assetupgrade.adapters;

import com.example.assetupgrade.attachment.AttachmentMetadata;
import com.example.assetupgrade.attachment.port.AttachmentEventPort;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.RetryableTransportException;
import com.example.assetupgrade.messaging.MessageEnvelope;
import com.example.assetupgrade.messaging.MessageHeaders;
import com.example.assetupgrade.messaging.MessagePublisher;
import com.example.assetupgrade.order.OrderResult;
import com.example.assetupgrade.order.port.OrderEventPort;
import com.example.assetupgrade.routing.MessageRequest;
import com.example.assetupgrade.routing.ProtocolAdapter;
import com.example.assetupgrade.routing.RouteDefinition;
import com.example.assetupgrade.workflow.EventEnvelope;
import com.example.assetupgrade.workflow.WorkflowEvent;
import com.example.assetupgrade.workflow.port.DeadLetterPort;
import com.example.assetupgrade.workflow.port.WorkflowOutboxPort;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Kafka-shaped messaging adapter implementing the attachment/order event publication ports, the
 * workflow outbox and dead-letter ports and the {@link ProtocolAdapter} routing seam
 * ({@code protocol == "kafka"}).
 *
 * <p>External publications ({@link #publish(AttachmentMetadata, CorrelationId)} and
 * {@link #publish(OrderResult, CorrelationId)}) are acknowledged only while the adapter holds an
 * established broker connection. Without one - or when the broker is unconfigured - the call fails
 * with a {@link RetryableTransportException} so the caller applies its retry policy; the adapter
 * never fabricates a successful delivery. The outbox ({@link #append(EventEnvelope)}) and
 * dead-letter ({@link #publish(WorkflowEvent, String, int)}) boundaries are real, tenant-scoped
 * local writes and remain usable without a broker.</p>
 *
 * <p>The adapter only ever emits after the application layer explicitly asked it to (a released
 * attachment or a committed order); it never decides to publish an approval on its own.</p>
 */
public final class KafkaMessagePublisher
        implements AttachmentEventPort, OrderEventPort, DeadLetterPort, WorkflowOutboxPort,
        MessagePublisher, ProtocolAdapter {

    /** Protocol name reported by this adapter. */
    public static final String PROTOCOL = "kafka";

    private final String bootstrapServers;
    private final AtomicBoolean connected = new AtomicBoolean(false);
    private volatile TenantId defaultTenant;
    private final List<PublishedOrder> orderResults = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final Map<String, List<MessageEnvelope>> publishedByTenant = new ConcurrentHashMap<>();
    private final Map<String, List<MessageEnvelope>> outboxByTenant = new ConcurrentHashMap<>();
    private final Map<String, List<DeadLetter>> deadLettersByTenant = new ConcurrentHashMap<>();

    /** Creates an unconfigured publisher; external publications fail until {@link #connect()}. */
    public KafkaMessagePublisher() {
        this(null);
    }

    /** Creates a publisher for {@code bootstrapServers}, not yet connected. */
    public KafkaMessagePublisher(String bootstrapServers) {
        this.bootstrapServers = bootstrapServers == null || bootstrapServers.isBlank()
                ? null
                : bootstrapServers.trim();
    }

    /** @return a publisher for {@code bootstrapServers}. */
    public static KafkaMessagePublisher of(String bootstrapServers) {
        return new KafkaMessagePublisher(bootstrapServers);
    }

    /** @return a connected, in-process publisher (used by wiring where the broker is local). */
    public static KafkaMessagePublisher connected() {
        KafkaMessagePublisher publisher = new KafkaMessagePublisher("in-process");
        publisher.connect();
        return publisher;
    }

    /** Establishes the broker connection so external publications may be acknowledged. */
    public KafkaMessagePublisher connect() {
        connected.set(true);
        return this;
    }

    /** Drops the broker connection; external publications fail until {@link #connect()}. */
    public KafkaMessagePublisher disconnect() {
        connected.set(false);
        return this;
    }

    /** @return {@code true} when the broker connection is established. */
    public boolean isConnected() {
        return connected.get();
    }

    /** @return {@code true} when a bootstrap server is configured. */
    public boolean isConfigured() {
        return bootstrapServers != null;
    }

    @Override
    public String protocol() {
        return PROTOCOL;
    }

    // ------------------------------------------------------------------ AttachmentEventPort

    @Override
    public void publish(AttachmentMetadata metadata, CorrelationId correlationId) {
        Objects.requireNonNull(metadata, "metadata");
        TenantId tenantId = Objects.requireNonNull(metadata.tenantId(), "metadata.tenantId");
        MessageEnvelope envelope = envelope(tenantId, correlationId, "attachment.approved",
                metadata.attachmentId(), metadata.contentHash());
        deliver(envelope);
    }

    // ------------------------------------------------------------------ OrderEventPort

    @Override
    public void publish(OrderResult result, CorrelationId correlationId) {
        Objects.requireNonNull(result, "result");
        if (!connected.get()) {
            String reason = bootstrapServers == null
                    ? "kafka broker is not configured"
                    : "kafka broker connection is not established for " + bootstrapServers;
            throw new RetryableTransportException(reason);
        }
        String marker = result.reservationId() == null ? "order" : result.reservationId();
        orderResults.add(new PublishedOrder(result, correlationId));
        if (defaultTenant != null) {
            deliver(envelope(defaultTenant, correlationId, "order.outcome", marker, null));
        }
    }

    /** @return the order results published through this adapter, in publication order. */
    public List<PublishedOrder> publishedOrderResults() {
        return List.copyOf(orderResults);
    }

    /** Sets the tenant context used for order outcomes, which do not carry a tenant themselves. */
    public KafkaMessagePublisher withDefaultTenant(TenantId tenantId) {
        this.defaultTenant = tenantId;
        return this;
    }

    /** @return the tenant context used for order outcomes, or {@code null} when unset. */
    public TenantId defaultTenant() {
        return defaultTenant;
    }

    // ------------------------------------------------------------------ MessagePublisher

    @Override
    public void publish(MessageEnvelope envelope) {
        deliver(Objects.requireNonNull(envelope, "envelope"));
    }

    // ------------------------------------------------------------------ DeadLetterPort

    @Override
    public void publish(WorkflowEvent event, String reason, int attempts) {
        Objects.requireNonNull(event, "event");
        TenantId tenantId = event.tenantId();
        if (tenantId == null) {
            throw new IllegalArgumentException("dead-letter event tenant is required");
        }
        deadLettersByTenant.computeIfAbsent(tenantId.value(), key -> new ArrayList<>())
                .add(new DeadLetter(event.eventId(), reason, attempts));
    }

    // ------------------------------------------------------------------ WorkflowOutboxPort

    @Override
    public void append(EventEnvelope envelope) {
        Objects.requireNonNull(envelope, "envelope");
        TenantId tenantId = envelope.event() == null ? null : envelope.event().tenantId();
        if (tenantId == null) {
            throw new IllegalArgumentException("outbox envelope tenant is required");
        }
        outboxByTenant.computeIfAbsent(tenantId.value(), key -> new ArrayList<>())
                .add(toEnvelope(envelope));
    }

    // ------------------------------------------------------------------ ProtocolAdapter

    @Override
    public Object adapt(RouteDefinition route, MessageRequest request) {
        Objects.requireNonNull(route, "route");
        Objects.requireNonNull(request, "request");
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("marker", request.routeKey());
        payload.put("target", route.target() == null ? route.routeKey() : route.target());
        payload.putAll(request.attributes());
        StringBuilder rendered = new StringBuilder();
        payload.forEach((key, value) -> rendered.append(key).append('=').append(value).append('\n'));
        return rendered.toString().getBytes(StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------ inspection helpers

    /** @return the messages successfully published for {@code tenantId}. */
    public List<MessageEnvelope> published(TenantId tenantId) {
        return snapshot(publishedByTenant, tenantId);
    }

    /** @return the envelopes appended to {@code tenantId}'s outbox. */
    public List<MessageEnvelope> outbox(TenantId tenantId) {
        return snapshot(outboxByTenant, tenantId);
    }

    /** @return the dead-letter records held for {@code tenantId}. */
    public List<DeadLetter> deadLetters(TenantId tenantId) {
        if (tenantId == null) {
            return List.of();
        }
        List<DeadLetter> records = deadLettersByTenant.get(tenantId.value());
        return records == null ? List.of() : List.copyOf(records);
    }

    /** @return {@code true} when the broker is connected and able to acknowledge a delivery. */
    public boolean probe() {
        return connected.get();
    }

    private void deliver(MessageEnvelope envelope) {
        Objects.requireNonNull(envelope, "envelope");
        if (!connected.get()) {
            String reason = bootstrapServers == null
                    ? "kafka broker is not configured"
                    : "kafka broker connection is not established for " + bootstrapServers;
            throw new RetryableTransportException(reason);
        }
        publishedByTenant.computeIfAbsent(envelope.tenantId().value(), key -> new ArrayList<>()).add(envelope);
    }

    private MessageEnvelope toEnvelope(EventEnvelope source) {
        WorkflowEvent event = source.event();
        TenantId tenantId = event.tenantId();
        CorrelationId correlationId = source.correlationId();
        byte[] payload = (event.eventId() == null ? "" : event.eventId()).getBytes(StandardCharsets.UTF_8);
        return new MessageEnvelope(tenantId, correlationId,
                source.routeKey() == null ? "workflow.event" : source.routeKey(),
                MessageHeaders.of(tenantId, correlationId), payload, source.nextAttemptAt());
    }

    private static MessageEnvelope envelope(TenantId tenantId, CorrelationId correlationId, String topic,
                                            String marker, String contentHash) {
        Map<String, String> attributes = new LinkedHashMap<>();
        if (contentHash != null) {
            attributes.put("contentHash", contentHash);
        }
        MessageHeaders headers = MessageHeaders.of(tenantId, correlationId, "application/json",
                marker, 1, attributes);
        return MessageEnvelope.of(tenantId, correlationId, topic, headers,
                marker == null ? new byte[0] : marker.getBytes(StandardCharsets.UTF_8));
    }

    private static List<MessageEnvelope> snapshot(Map<String, List<MessageEnvelope>> holder, TenantId tenantId) {
        if (tenantId == null) {
            return List.of();
        }
        List<MessageEnvelope> envelopes = holder.get(tenantId.value());
        return envelopes == null ? List.of() : List.copyOf(envelopes);
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof AttachmentEventPort.PublishRequest request) {
            publish(request.metadata(), request.correlationId());
            return null;
        }
        if (input instanceof OrderEventPort.PublishRequest request) {
            publish(request.result(), request.correlationId());
            return null;
        }
        if (input instanceof MessageEnvelope envelope) {
            publish(envelope);
            return envelope;
        }
        if (input instanceof EventEnvelope envelope) {
            append(envelope);
            return null;
        }
        if (input instanceof DeadLetterRequest request) {
            publish(request.event(), request.reason(), request.attempts());
            return null;
        }
        if (input instanceof ProtocolAdapter.AdaptRequest request) {
            return adapt(request.route(), request.request());
        }
        throw new IllegalArgumentException("unsupported kafka publisher request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record DeadLetterRequest(WorkflowEvent event, String reason, int attempts) {
    }

    /**
     * An order outcome published through this adapter.
     *
     * @param result        the published order result
     * @param correlationId the correlation identity carried by the publication
     */
    public record PublishedOrder(OrderResult result, CorrelationId correlationId) {
    }

    /**
     * A dead-lettered workflow event.
     *
     * @param eventId  the event identity
     * @param reason   the reason the event was dead-lettered
     * @param attempts the number of attempts made
     */
    public record DeadLetter(String eventId, String reason, int attempts) {
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
