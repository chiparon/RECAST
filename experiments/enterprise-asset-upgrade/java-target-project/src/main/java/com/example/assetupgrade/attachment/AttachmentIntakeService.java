package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

/**
 * Application-facing boundary for attachment intake and release.
 *
 * <p>{@link #intake(AttachmentIntakeCommand)} validates, quarantines, scans and (when the
 * scan is clean) releases an attachment. {@link #release(TenantId, ActorId, String,
 * CorrelationId)} releases an already cleanly scanned attachment and is idempotent. Neither
 * operation ever produces an approval event for an unscanned, rejected, cross-tenant,
 * unsafe, oversized or signature-mismatched attachment.</p>
 */
public interface AttachmentIntakeService {

    /** Accepts and processes an attachment submission. */
    AttachmentIntakeResult intake(AttachmentIntakeCommand command);

    /** Releases a cleanly scanned attachment for the owning tenant. */
    AttachmentIntakeResult release(TenantId tenantId, ActorId actorId, String attachmentId, CorrelationId correlationId);
}
