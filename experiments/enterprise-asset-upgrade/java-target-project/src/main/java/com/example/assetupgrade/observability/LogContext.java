package com.example.assetupgrade.observability;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable correlation-and-tenant key/value context used to build structured log records.
 *
 * <p>Retains the correlation and tenant identity of the current operation together with
 * any additional string attributes. Structured logging adapters render this context into
 * their record field set so that an event can be traced back to its originating command.</p>
 */
public final class LogContext {

    private final CorrelationId correlationId;
    private final TenantId tenantId;
    private final Map<String, String> attributes;

    public LogContext(CorrelationId correlationId, TenantId tenantId, Map<String, String> attributes) {
        this.correlationId = correlationId;
        this.tenantId = tenantId;
        this.attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    public LogContext(CorrelationId correlationId, TenantId tenantId) {
        this(correlationId, tenantId, Map.of());
    }

    /** Creates an empty context with neither correlation nor tenant identity. */
    public static LogContext empty() {
        return new LogContext(null, null, Map.of());
    }

    /** Creates a context carrying the supplied identity. */
    public static LogContext of(CorrelationId correlationId, TenantId tenantId) {
        return new LogContext(correlationId, tenantId);
    }

    /** Creates a context carrying the supplied identity and attributes. */
    public static LogContext of(CorrelationId correlationId, TenantId tenantId, Map<String, String> attributes) {
        return new LogContext(correlationId, tenantId, attributes);
    }

    /** @return the correlation identity, or {@code null} when unbound. */
    public CorrelationId correlationId() {
        return correlationId;
    }

    /** @return the tenant identity, or {@code null} when unbound. */
    public TenantId tenantId() {
        return tenantId;
    }

    /** @return the immutable additional attributes. */
    public Map<String, String> attributes() {
        return attributes;
    }

    /** Returns a new immutable context with the given attribute added or replaced. */
    public LogContext withAttribute(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new LogContext(correlationId, tenantId, copy);
    }

    /** Returns a new immutable context bound to the supplied correlation identity. */
    public LogContext withCorrelationId(CorrelationId newCorrelationId) {
        return new LogContext(newCorrelationId, tenantId, attributes);
    }

    /** Returns a new immutable context bound to the supplied tenant identity. */
    public LogContext withTenantId(TenantId newTenantId) {
        return new LogContext(correlationId, newTenantId, attributes);
    }

    /**
     * Flattens this context into a string-keyed field map, exposing the correlation and
     * tenant identity under the {@code correlationId} and {@code tenantId} keys.
     */
    public Map<String, String> toMap() {
        Map<String, String> fields = new LinkedHashMap<>();
        if (correlationId != null) {
            fields.put("correlationId", correlationId.value());
        }
        if (tenantId != null) {
            fields.put("tenantId", tenantId.value());
        }
        fields.putAll(attributes);
        return Map.copyOf(fields);
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof LogContext that)) {
            return false;
        }
        return Objects.equals(correlationId, that.correlationId)
                && Objects.equals(tenantId, that.tenantId)
                && attributes.equals(that.attributes);
    }

    @Override
    public int hashCode() {
        return Objects.hash(correlationId, tenantId, attributes);
    }

    @Override
    public String toString() {
        return "LogContext[correlationId=" + correlationId + ", tenantId=" + tenantId
                + ", attributes=" + attributes + "]";
    }
}
