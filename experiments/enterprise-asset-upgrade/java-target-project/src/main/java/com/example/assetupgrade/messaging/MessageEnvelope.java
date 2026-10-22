package com.example.assetupgrade.messaging;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;

import java.time.Instant;
import java.util.Arrays;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable, tenant-aware message envelope exchanged with the messaging ports.
 *
 * <p>The envelope binds the owning {@link TenantId} and {@link CorrelationId} to a topic, a
 * {@link MessageHeaders} header set and an opaque payload. Headers are derived from the
 * tenant/correlation identity when absent, the payload is defensively copied, and a missing
 * occurrence time normalises to {@code Instant.now()} so identity and timing survive transport
 * unchanged. No provider (Kafka, Camel, BullMQ, Quartz) type appears in this contract.</p>
 *
 * @param tenantId      the owning tenant, never {@code null}
 * @param correlationId the correlation identity, may be {@code null}
 * @param topic         the resolved topic/marker, never blank
 * @param headers       the tenant-aware header set, never {@code null}
 * @param payload       the opaque payload bytes, never {@code null} (may be empty)
 * @param occurredAt    the occurrence instant, never {@code null}
 */
public record MessageEnvelope(
        TenantId tenantId,
        CorrelationId correlationId,
        String topic,
        MessageHeaders headers,
        byte[] payload,
        Instant occurredAt) {

    private static final byte[] EMPTY_PAYLOAD = new byte[0];

    public MessageEnvelope {
        tenantId = Objects.requireNonNull(tenantId, "tenantId");
        topic = requireTopic(topic);
        CorrelationId effectiveCorrelation = correlationId != null
                ? correlationId
                : (headers == null ? null : headers.correlationId());
        MessageHeaders effectiveHeaders = headers == null
                ? MessageHeaders.of(tenantId, effectiveCorrelation)
                : new MessageHeaders(tenantId, effectiveCorrelation, headers.contentType(),
                        headers.messageId(), headers.attempt(), headers.attributes());
        correlationId = effectiveCorrelation;
        headers = effectiveHeaders;
        payload = payload == null ? EMPTY_PAYLOAD : payload.clone();
        occurredAt = occurredAt == null ? Instant.now() : occurredAt;
    }

    private static String requireTopic(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("topic is required");
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("topic must not be blank");
        }
        return trimmed;
    }

    /** Creates an envelope stamped with the system clock. */
    public static MessageEnvelope of(TenantId tenantId, CorrelationId correlationId, String topic,
                                     MessageHeaders headers, byte[] payload) {
        return new MessageEnvelope(tenantId, correlationId, topic, headers, payload, Instant.now());
    }

    /** Creates a full envelope. */
    public static MessageEnvelope of(TenantId tenantId, CorrelationId correlationId, String topic,
                                     MessageHeaders headers, byte[] payload, Instant occurredAt) {
        return new MessageEnvelope(tenantId, correlationId, topic, headers, payload, occurredAt);
    }

    /** Creates an envelope whose occurrence time is read from {@code clock}. */
    public static MessageEnvelope of(TenantId tenantId, CorrelationId correlationId, String topic,
                                     MessageHeaders headers, byte[] payload, TimeProvider clock) {
        Objects.requireNonNull(clock, "clock");
        return new MessageEnvelope(tenantId, correlationId, topic, headers, payload, clock.now());
    }

    /** Creates an envelope with derived headers. */
    public static MessageEnvelope of(TenantId tenantId, CorrelationId correlationId, String topic, byte[] payload) {
        return of(tenantId, correlationId, topic, null, payload);
    }

    /** @return a defensive copy of the payload bytes. */
    public byte[] payloadCopy() {
        return payload.clone();
    }

    /** @return the payload length in bytes. */
    public int sizeBytes() {
        return payload.length;
    }

    /** @return a copy carrying {@code newHeaders}, re-scoped to this envelope's tenant. */
    public MessageEnvelope withHeaders(MessageHeaders newHeaders) {
        return new MessageEnvelope(tenantId, correlationId, topic, newHeaders, payload, occurredAt);
    }

    /** @return a copy carrying {@code newCorrelationId}. */
    public MessageEnvelope withCorrelationId(CorrelationId newCorrelationId) {
        return new MessageEnvelope(tenantId, newCorrelationId, topic, headers, payload, occurredAt);
    }

    /** @return a copy carrying {@code newPayload}. */
    public MessageEnvelope withPayload(byte[] newPayload) {
        return new MessageEnvelope(tenantId, correlationId, topic, headers, newPayload, occurredAt);
    }

    /** @return a copy stamped with {@code newOccurredAt}. */
    public MessageEnvelope withOccurredAt(Instant newOccurredAt) {
        return new MessageEnvelope(tenantId, correlationId, topic, headers, payload, newOccurredAt);
    }

    /** @return {@code true} when the headers mark this envelope as a retry (attempt greater than one). */
    public boolean isRetry() {
        return headers.attempt() > 1;
    }

    /** @return the topic marker; retained for the legacy single-marker envelope shape. */
    public String marker() {
        return topic;
    }

    /** @return the header attributes; retained for the legacy envelope shape. */
    public Map<String, String> attributes() {
        return headers.attributes();
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof MessageEnvelope that)) {
            return false;
        }
        return tenantId.equals(that.tenantId)
                && Objects.equals(correlationId, that.correlationId)
                && topic.equals(that.topic)
                && headers.equals(that.headers)
                && Arrays.equals(payload, that.payload)
                && occurredAt.equals(that.occurredAt);
    }

    @Override
    public int hashCode() {
        int result = Objects.hash(tenantId, correlationId, topic, headers, occurredAt);
        return 31 * result + Arrays.hashCode(payload);
    }

    @Override
    public String toString() {
        return "MessageEnvelope[tenantId=" + tenantId + ", correlationId=" + correlationId
                + ", topic=" + topic + ", headers=" + headers + ", payload=" + payload.length
                + " bytes, occurredAt=" + occurredAt + ']';
    }
}
