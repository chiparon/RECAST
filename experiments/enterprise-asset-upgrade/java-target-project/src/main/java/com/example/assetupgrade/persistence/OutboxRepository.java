package com.example.assetupgrade.persistence;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.messaging.MessageEnvelope;

import java.util.List;
import java.util.Objects;

/**
 * Tenant-scoped transactional outbox.
 *
 * <p>{@link #append(TenantId, MessageEnvelope)} and {@link #markDispatched(TenantId, String)} are
 * idempotent per {@code (tenantId, messageId)}. {@link #pending(TenantId, int)} returns the oldest
 * envelopes first and never crosses a tenant boundary; after a successful
 * {@code markDispatched} the envelope is no longer returned, which gives duplicate-dispatch safety
 * for workflow event delivery. {@code append} is usable inside
 * {@link TransactionPort#inTransaction(java.util.function.Supplier)} so the outbox row commits
 * atomically with the business write. Provider storage stays behind the port.</p>
 */
public interface OutboxRepository {

    /** Appends {@code envelope} to {@code tenantId}'s outbox, idempotently per message id. */
    void append(TenantId tenantId, MessageEnvelope envelope);

    /** @return up to {@code limit} of {@code tenantId}'s oldest undispatched envelopes. */
    List<MessageEnvelope> pending(TenantId tenantId, int limit);

    /** Marks {@code messageId} dispatched for {@code tenantId}; subsequent pending queries exclude it. */
    boolean markDispatched(TenantId tenantId, String messageId);

    /** @return the number of undispatched envelopes in {@code tenantId}'s outbox. */
    long pendingCount(TenantId tenantId);

    /** Compatibility seam for early implementations; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof AppendRequest request) {
            append(request.tenantId(), request.envelope());
            return request.envelope();
        }
        if (input instanceof MessageEnvelope envelope) {
            append(envelope.tenantId(), envelope);
            return envelope;
        }
        throw new IllegalArgumentException("expected an OutboxRepository.AppendRequest or MessageEnvelope");
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param tenantId the owning tenant
     * @param envelope the envelope to append
     */
    record AppendRequest(TenantId tenantId, MessageEnvelope envelope) {
        public AppendRequest {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(envelope, "envelope");
        }
    }
}
