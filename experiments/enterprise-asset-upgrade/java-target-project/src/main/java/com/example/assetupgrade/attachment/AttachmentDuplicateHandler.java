package com.example.assetupgrade.attachment;

import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;

import java.util.Optional;

/**
 * Detects and coordinates duplicate tenant-scoped attachment commands.
 *
 * <p>A successful command is claimed in the {@link IdempotencyPort} under a tenant-qualified
 * key; a replay observes the completed key and returns the previously stored outcome without
 * re-running side effects or writing a second audit record. A failed command releases its
 * claim so a later retry can run again.</p>
 */
public final class AttachmentDuplicateHandler {

    private final IdempotencyPort idempotency;
    private final AttachmentRepository repository;

    /** Creates a handler with no idempotency store; nothing is ever considered a duplicate. */
    public AttachmentDuplicateHandler() {
        this(null, null);
    }

    /** Creates a handler backed by {@code idempotency}. */
    public AttachmentDuplicateHandler(IdempotencyPort idempotency) {
        this(idempotency, null);
    }

    /** Creates a handler backed by {@code idempotency} able to re-read the stored metadata. */
    public AttachmentDuplicateHandler(IdempotencyPort idempotency, AttachmentRepository repository) {
        this.idempotency = idempotency;
        this.repository = repository;
    }

    /** @return the tenant-qualified key for an attachment operation. */
    public IdempotencyKey key(TenantId tenantId, String operation, String attachmentId) {
        return IdempotencyKey.of(tenantId, operation, attachmentId);
    }

    /** @return {@code true} when {@code key} has already completed successfully. */
    public boolean isDuplicate(IdempotencyKey key) {
        return idempotency != null && idempotency.isCompleted(key);
    }

    /**
     * Atomically claims {@code key}.
     *
     * @return {@code true} when the caller may proceed, {@code false} when a concurrent caller
     *         already holds the claim
     */
    public boolean claim(IdempotencyKey key) {
        return idempotency == null || idempotency.tryMarkCompleted(key);
    }

    /** Releases the claim so a failed command remains retryable. */
    public void release(IdempotencyKey key) {
        if (idempotency != null && key != null) {
            idempotency.remove(key);
        }
    }

    /** @return an already-stored attachment for the tenant, if present. */
    public Optional<AttachmentMetadata> existing(TenantId tenantId, String attachmentId) {
        if (repository == null || tenantId == null || attachmentId == null) {
            return Optional.empty();
        }
        return repository.find(tenantId, attachmentId);
    }

    /** @return the backing idempotency port, or {@code null} when none is configured. */
    public IdempotencyPort port() {
        return idempotency;
    }

    /** Compatibility seam; accepts an {@link AttachmentIntakeCommand}. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return isDuplicate(key(command.metadata().tenantId(), "attachment.intake",
                    command.attachment().attachmentId()));
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand");
    }
}
