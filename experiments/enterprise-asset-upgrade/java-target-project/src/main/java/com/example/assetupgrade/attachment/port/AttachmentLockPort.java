package com.example.assetupgrade.attachment.port;

import java.util.concurrent.locks.Lock;

/**
 * Tenant-scoped locking boundary guarding release of a single attachment.
 *
 * <p>A lock acquired for {@code (tenantId, attachmentId)} must never conflict with another
 * tenant's lock, and the returned {@link Lock} must already be held by the time
 * {@code lock} returns (or the caller acquires it).</p>
 */
public interface AttachmentLockPort {

    /** @return an acquired lock guarding {@code attachmentId} for {@code tenantId}. */
    Lock lock(com.example.assetupgrade.common.TenantId tenantId, String attachmentId);

    /** Compatibility seam; the typed contract is {@link #lock}. */
    default Object execute(Object input) {
        if (input instanceof LockRequest request) {
            return lock(request.tenantId(), request.attachmentId());
        }
        throw new IllegalArgumentException("Expected a LockRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record LockRequest(com.example.assetupgrade.common.TenantId tenantId, String attachmentId) {
    }
}
