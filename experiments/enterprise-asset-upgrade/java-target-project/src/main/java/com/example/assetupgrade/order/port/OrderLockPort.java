package com.example.assetupgrade.order.port;

import com.example.assetupgrade.common.TenantId;

import java.util.concurrent.locks.Lock;

/**
 * Tenant-scoped locking boundary guarding mutation of a single order.
 *
 * <p>A lock acquired for {@code (tenantId, orderId)} must never conflict with another tenant's
 * lock. The returned {@link Lock} must already be held by the time {@link #lock(TenantId, String)}
 * returns (or the caller acquires it).</p>
 */
public interface OrderLockPort {

    /** @return an acquired lock guarding {@code orderId} for {@code tenantId}. */
    Lock lock(TenantId tenantId, String orderId);

    /** Compatibility seam; the typed contract is {@link #lock}. */
    default Object execute(Object input) {
        if (input instanceof LockRequest request) {
            return lock(request.tenantId(), request.orderId());
        }
        throw new IllegalArgumentException("Expected a LockRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record LockRequest(TenantId tenantId, String orderId) {
    }
}
