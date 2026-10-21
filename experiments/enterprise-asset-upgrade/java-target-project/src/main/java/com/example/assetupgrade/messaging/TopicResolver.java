package com.example.assetupgrade.messaging;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ValidationException;

import java.util.Objects;
import java.util.Optional;

/**
 * Resolves a {@link MessageEnvelope} to exactly one topic for a tenant.
 *
 * <p>Resolution is tenant-scoped: only the requested tenant's topic space is considered, so an
 * envelope belonging to another tenant never resolves here. A missing topic fails with
 * {@link ValidationException}; a registry-backed implementation that matches more than one topic
 * fails with {@code ConflictException}. The default algorithm derives the topic from the envelope
 * itself (its topic marker), which is sufficient for direct dispatch and lets adapters override
 * {@link #find(TenantId, MessageEnvelope)} with a tenant-scoped registry lookup.</p>
 */
public interface TopicResolver {

    /**
     * @return the single topic for {@code envelope}
     * @throws ValidationException when no topic matches within {@code tenantId}
     */
    default String resolve(TenantId tenantId, MessageEnvelope envelope) {
        return find(tenantId, envelope).orElseThrow(() -> new ValidationException(
                "no topic for message " + (envelope == null ? null : envelope.marker())
                        + " in tenant " + (tenantId == null ? null : tenantId.value())));
    }

    /** @return the single topic for {@code envelope}, or empty when none matches. */
    default Optional<String> find(TenantId tenantId, MessageEnvelope envelope) {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(envelope, "envelope");
        if (!tenantId.equals(envelope.tenantId())) {
            return Optional.empty();
        }
        String topic = envelope.topic() == null ? null : envelope.topic().trim();
        return (topic == null || topic.isEmpty()) ? Optional.empty() : Optional.of(topic);
    }

    /** Compatibility seam accepting a {@link TopicRequest} holder. */
    default Object execute(Object input) {
        if (input instanceof TopicRequest request) {
            return resolve(request.tenantId(), request.envelope());
        }
        if (input instanceof MessageEnvelope envelope) {
            return resolve(envelope.tenantId(), envelope);
        }
        throw new IllegalArgumentException("expected a TopicResolver.TopicRequest or MessageEnvelope");
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param tenantId the owning tenant
     * @param envelope the envelope to resolve
     */
    record TopicRequest(TenantId tenantId, MessageEnvelope envelope) {}
}
