package com.example.assetupgrade.attachment;

import com.example.assetupgrade.attachment.port.AttachmentEventPort;
import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.attachment.port.QuarantinePort;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

/**
 * Releases a cleanly scanned attachment and publishes its approval event.
 *
 * <p>Release is gated by a successful scan: {@link #canRelease(AttachmentMetadata)} is only
 * true for an attachment whose {@code scanned} flag is set and whose state not rejected.
 * {@link #release(AttachmentMetadata, CorrelationId)} persists the
 * {@link AttachmentState#RELEASED} state, drops the quarantine hold and publishes the event
 * exactly once per release. An unscanned or rejected attachment returns {@code null} and no
 * event is published.</p>
 */
public final class AttachmentReleaseCoordinator {

    private final QuarantinePort quarantine;
    private final AttachmentEventPort events;
    private final AttachmentRepository repository;

    /** Creates a coordinator with the release collaborators. */
    public AttachmentReleaseCoordinator(QuarantinePort quarantine, AttachmentEventPort events,
                                        AttachmentRepository repository) {
        this.quarantine = quarantine;
        this.events = events;
        this.repository = repository;
    }

    /** @return {@code true} when {@code metadata} may be released after a clean scan. */
    public boolean canRelease(AttachmentMetadata metadata) {
        return metadata != null
                && metadata.scanned()
                && metadata.state() != AttachmentState.REJECTED
                && metadata.state() != AttachmentState.RELEASED;
    }

    /**
     * Releases {@code metadata} and publishes its approval event.
     *
     * @return the released metadata, or {@code null} when the attachment was not eligible
     */
    public AttachmentMetadata release(AttachmentMetadata metadata, CorrelationId correlationId) {
        if (!canRelease(metadata)) {
            return null;
        }
        AttachmentMetadata released = metadata.withState(AttachmentState.RELEASED);
        if (repository != null) {
            repository.save(released);
        }
        releaseQuarantine(released);
        publish(released, correlationId);
        return released;
    }

    private void releaseQuarantine(AttachmentMetadata metadata) {
        TenantId tenantId = metadata.tenantId();
        if (quarantine != null && tenantId != null) {
            quarantine.release(tenantId, metadata.attachmentId());
        }
    }

    private void publish(AttachmentMetadata metadata, CorrelationId correlationId) {
        if (events != null) {
            events.publish(metadata, correlationId);
        }
    }

    /** Compatibility seam; accepts a command whose attachment was already scanned clean. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return release(command.attachment(), command.metadata().correlationId());
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand");
    }
}
