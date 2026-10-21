package com.example.assetupgrade.messaging;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable, tenant-aware header set carried by every {@link MessageEnvelope}.
 *
 * <p>Every header carries the owning {@link TenantId} and, when known, the
 * {@link CorrelationId} so that identity survives transport unchanged. A blank content type
 * defaults to {@code application/json}, a blank message id normalises to {@code null}, and an
 * attempt below {@code 1} is raised to the first (1-based) attempt. Free-form attributes are
 * defensively copied into an unmodifiable, insertion-ordered map, mirroring the tenant-scoped
 * metadata convention used by routing.</p>
 *
 * @param tenantId      the owning tenant, never {@code null}
 * @param correlationId the correlation identity, may be {@code null}
 * @param contentType   the payload content type, never blank
 * @param messageId     the stable message identity, may be {@code null}
 * @param attempt       the 1-based delivery attempt, at least {@code 1}
 * @param attributes    immutable free-form metadata, never {@code null}
 */
public record MessageHeaders(
        TenantId tenantId,
        CorrelationId correlationId,
        String contentType,
        String messageId,
        int attempt,
        Map<String, String> attributes) {

    /** Attribute key of {@link #tenantId()}. */
    public static final String TENANT_ID = "tenantId";
    /** Attribute key of {@link #correlationId()}. */
    public static final String CORRELATION_ID = "correlationId";
    /** Attribute key of {@link #contentType()}. */
    public static final String CONTENT_TYPE = "contentType";
    /** Attribute key of {@link #messageId()}. */
    public static final String MESSAGE_ID = "messageId";
    /** Attribute key of {@link #attempt()}. */
    public static final String ATTEMPT = "attempt";
    /** Default content type applied when none is supplied. */
    public static final String DEFAULT_CONTENT_TYPE = "application/json";

    public MessageHeaders {
        tenantId = Objects.requireNonNull(tenantId, "tenantId");
        contentType = normalizeContentType(contentType);
        messageId = normalizeId(messageId);
        if (attempt < 1) {
            attempt = 1;
        }
        attributes = immutableCopy(attributes);
    }

    private static String normalizeContentType(String raw) {
        if (raw == null) {
            return DEFAULT_CONTENT_TYPE;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? DEFAULT_CONTENT_TYPE : trimmed;
    }

    private static String normalizeId(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    static Map<String, String> immutableCopy(Map<String, String> source) {
        if (source == null || source.isEmpty()) {
            return Map.of();
        }
        Map<String, String> copy = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                copy.put(entry.getKey(), entry.getValue());
            }
        }
        return Collections.unmodifiableMap(copy);
    }

    /** Creates a first-attempt header set for {@code tenantId} and {@code correlationId}. */
    public static MessageHeaders of(TenantId tenantId, CorrelationId correlationId) {
        return new MessageHeaders(tenantId, correlationId, null, null, 1, Map.of());
    }

    /** Creates a first-attempt header set carrying {@code attributes}. */
    public static MessageHeaders of(TenantId tenantId, CorrelationId correlationId, Map<String, String> attributes) {
        return new MessageHeaders(tenantId, correlationId, null, null, 1, attributes);
    }

    /** Creates a header set from its full component set. */
    public static MessageHeaders of(TenantId tenantId, CorrelationId correlationId, String contentType,
                                    String messageId, int attempt, Map<String, String> attributes) {
        return new MessageHeaders(tenantId, correlationId, contentType, messageId, attempt, attributes);
    }

    /**
     * Rebuilds a header set from a flat textual map, for example the value produced by
     * {@link #toMap()}. Reserved keys ({@code tenantId}, {@code correlationId}, {@code contentType},
     * {@code messageId}, {@code attempt}) are interpreted as components; every other key becomes an
     * attribute. The owning tenant is supplied explicitly so a map can never smuggle another tenant.
     */
    public static MessageHeaders fromMap(TenantId tenantId, Map<String, String> values) {
        Objects.requireNonNull(tenantId, "tenantId");
        Map<String, String> source = values == null ? Map.of() : values;
        CorrelationId correlationId = correlationId(source.get(CORRELATION_ID));
        String contentType = source.get(CONTENT_TYPE);
        String messageId = source.get(MESSAGE_ID);
        int attempt = parseAttempt(source.get(ATTEMPT));
        Map<String, String> attributes = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            String key = entry.getKey();
            if (key == null || isReserved(key)) {
                continue;
            }
            attributes.put(key, entry.getValue());
        }
        return new MessageHeaders(tenantId, correlationId, contentType, messageId, attempt, attributes);
    }

    private static boolean isReserved(String key) {
        return TENANT_ID.equals(key) || CORRELATION_ID.equals(key) || CONTENT_TYPE.equals(key)
                || MESSAGE_ID.equals(key) || ATTEMPT.equals(key);
    }

    private static CorrelationId correlationId(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? null : CorrelationId.of(trimmed);
    }

    private static int parseAttempt(String raw) {
        if (raw == null || raw.isBlank()) {
            return 1;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException ex) {
            return 1;
        }
    }

    /** @return the value of {@code name}, or {@code null} when absent. */
    public String attribute(String name) {
        return name == null ? null : attributes.get(name);
    }

    /** @return {@code true} when {@code name} is present. */
    public boolean hasAttribute(String name) {
        return name != null && attributes.containsKey(name);
    }

    /** @return {@code true} when this header set carries a correlation identity. */
    public boolean hasCorrelation() {
        return correlationId != null;
    }

    /** @return a copy with {@code name} set to {@code value}, or removed when {@code value} is null. */
    public MessageHeaders withAttribute(String name, String value) {
        Objects.requireNonNull(name, "name");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        if (value == null) {
            copy.remove(name);
        } else {
            copy.put(name, value);
        }
        return new MessageHeaders(tenantId, correlationId, contentType, messageId, attempt, copy);
    }

    /** @return a copy carrying {@code newCorrelationId}. */
    public MessageHeaders withCorrelationId(CorrelationId newCorrelationId) {
        return new MessageHeaders(tenantId, newCorrelationId, contentType, messageId, attempt, attributes);
    }

    /** @return a copy carrying the requested 1-based {@code newAttempt}. */
    public MessageHeaders withAttempt(int newAttempt) {
        return new MessageHeaders(tenantId, correlationId, contentType, messageId, newAttempt, attributes);
    }

    /** @return a copy carrying the next (1-based) delivery attempt. */
    public MessageHeaders nextAttempt() {
        return withAttempt(attempt + 1);
    }

    /** @return the stable message identity, or {@code null} when unset. */
    public String marker() {
        return messageId;
    }

    /** @return a flat, deterministic view including reserved identity keys and all attributes. */
    public Map<String, String> toMap() {
        Map<String, String> view = new LinkedHashMap<>();
        view.put(TENANT_ID, tenantId.value());
        if (correlationId != null) {
            view.put(CORRELATION_ID, correlationId.value());
        }
        view.put(CONTENT_TYPE, contentType);
        if (messageId != null) {
            view.put(MESSAGE_ID, messageId);
        }
        view.put(ATTEMPT, Integer.toString(attempt));
        view.putAll(attributes);
        return Collections.unmodifiableMap(view);
    }
}
