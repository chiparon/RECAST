package com.example.assetupgrade.attachment;

import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.attachment.port.QuarantinePort;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;

import java.util.List;

/**
 * Moves an attachment into quarantine and records the reason.
 *
 * <p>The coordinator marks the metadata {@link AttachmentState#QUARANTINED}, persists that
 * state when a repository is available, and delegates the provider-specific hold to the
 * {@link QuarantinePort}. Release from quarantine is only ever performed by the release
 * coordinator after a clean scan.</p>
 */
public final class AttachmentQuarantineCoordinator {

    private final QuarantinePort quarantine;
    private final AttachmentRepository repository;

    /** Creates a coordinator with only a quarantine port. */
    public AttachmentQuarantineCoordinator(QuarantinePort quarantine) {
        this(quarantine, null);
    }

    /** Creates a coordinator. */
    public AttachmentQuarantineCoordinator(QuarantinePort quarantine, AttachmentRepository repository) {
        this.quarantine = quarantine;
        this.repository = repository;
    }

    /** Places {@code metadata} in quarantine for {@code reason} and returns the quarantined copy. */
    public AttachmentMetadata quarantine(AttachmentMetadata metadata, QuarantineReason reason) {
        if (metadata == null) {
            return null;
        }
        AttachmentMetadata quarantined = metadata.withScanned(false).withState(AttachmentState.QUARANTINED);
        if (repository != null) {
            repository.save(quarantined);
        }
        if (quarantine != null) {
            quarantine.quarantine(quarantined, reason == null ? QuarantineReason.SCAN_PENDING : reason);
        }
        return quarantined;
    }

    /** Releases the quarantine hold on {@code attachmentId} for {@code tenantId}. */
    public void release(TenantId tenantId, String attachmentId) {
        if (quarantine != null && tenantId != null && attachmentId != null) {
            quarantine.release(tenantId, attachmentId);
        }
    }

    /** @return the provider-specific quarantine port, or {@code null} when none is configured. */
    public QuarantinePort port() {
        return quarantine;
    }

    /** @return the reason that best describes {@code problems}. */
    public static QuarantineReason reasonFor(List<ServiceProblem> problems) {
        return QuarantineReason.from(problems);
    }

    /** Compatibility seam; accepts an attachment command and quarantines it. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return quarantine(command.attachment(), QuarantineReason.SCAN_PENDING);
        }
        if (input instanceof AttachmentMetadata metadata) {
            return quarantine(metadata, QuarantineReason.SCAN_PENDING);
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand");
    }
}
