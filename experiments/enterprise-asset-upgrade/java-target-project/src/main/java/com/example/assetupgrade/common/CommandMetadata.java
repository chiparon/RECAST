package com.example.assetupgrade.common;

import java.time.Instant;
import java.util.Objects;

/**
 * Identity, correlation and timing metadata carried by every command.
 *
 * <p>The record component order and types are part of the public contract: order,
 * workflow, reconciliation and attachment commands bind directly to them.</p>
 */
public record CommandMetadata(TenantId tenantId, ActorId actorId, CorrelationId correlationId, Instant receivedAt) {

    public CommandMetadata {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(actorId, "actorId");
        Objects.requireNonNull(correlationId, "correlationId");
        Objects.requireNonNull(receivedAt, "receivedAt");
    }

    /** Convenience factory matching the canonical record construction. */
    public static CommandMetadata of(TenantId tenantId, ActorId actorId, CorrelationId correlationId, Instant receivedAt) {
        return new CommandMetadata(tenantId, actorId, correlationId, receivedAt);
    }

    /** Builds an {@link OperationContext} for the given operation using this metadata. */
    public OperationContext toContext(String operationName) {
        return new OperationContext(this, operationName, null);
    }
}
