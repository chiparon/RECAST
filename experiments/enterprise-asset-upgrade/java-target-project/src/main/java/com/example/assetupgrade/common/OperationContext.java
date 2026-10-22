package com.example.assetupgrade.common;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable per-operation context derived from {@link CommandMetadata}.
 *
 * <p>The record components are part of the public contract; convenience accessors,
 * defensive copying and functional updates are added here.</p>
 */
public record OperationContext(CommandMetadata metadata, String operationName, Map<String, String> attributes) {

    public OperationContext {
        Objects.requireNonNull(metadata, "metadata");
        operationName = Objects.requireNonNull(operationName, "operationName").trim();
        if (operationName.isEmpty()) {
            throw new IllegalArgumentException("operationName must not be blank");
        }
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** @return the tenant owning the operation. */
    public TenantId tenantId() {
        return metadata.tenantId();
    }

    /** @return the actor performing the operation. */
    public ActorId actorId() {
        return metadata.actorId();
    }

    /** @return the correlation id propagated across the operation. */
    public CorrelationId correlationId() {
        return metadata.correlationId();
    }

    /** @return the time at which the originating command was received. */
    public java.time.Instant receivedAt() {
        return metadata.receivedAt();
    }

    /** Returns a new immutable context with the given attribute added or replaced. */
    public OperationContext withAttribute(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new OperationContext(metadata, operationName, copy);
    }
}
