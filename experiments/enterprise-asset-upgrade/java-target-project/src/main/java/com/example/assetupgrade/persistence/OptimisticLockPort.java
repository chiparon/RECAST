package com.example.assetupgrade.persistence;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ConflictException;

import java.util.Objects;
import java.util.function.Supplier;

/**
 * Tenant-scoped compare-and-swap (optimistic-lock) contract.
 *
 * <p>Every method is scoped to a single {@link TenantId} and key. A compare-and-swap whose
 * {@code expectedVersion} no longer matches the stored version fails with
 * {@link ConflictException} and must never overwrite a newer version. {@link #withLock} only runs
 * the operation when the expected version still matches. Provider persistence stays behind the
 * port.</p>
 */
public interface OptimisticLockPort {

    /** @return the current 1-based version of {@code key} within {@code tenantId}. */
    long version(TenantId tenantId, String key);

    /**
     * Atomically advances {@code key} from {@code expectedVersion} to {@code newVersion}.
     *
     * @return {@code true} when the swap succeeded
     * @throws ConflictException when {@code expectedVersion} is stale
     */
    boolean compareAndSwap(TenantId tenantId, String key, long expectedVersion, long newVersion);

    /**
     * Runs {@code operation} against {@code key} only when the version still matches
     * {@code expectedVersion}, advancing the version exactly once.
     *
     * @throws ConflictException when {@code expectedVersion} is stale
     */
    default <T> T withLock(TenantId tenantId, String key, long expectedVersion, Supplier<T> operation) {
        Objects.requireNonNull(operation, "operation");
        if (!compareAndSwap(tenantId, key, expectedVersion, expectedVersion + 1)) {
            throw new ConflictException("stale version " + expectedVersion + " for key " + key);
        }
        return operation.get();
    }

    /** Compatibility seam accepting a {@link LockRequest} holder. */
    default Object execute(Object input) {
        if (input instanceof LockRequest request) {
            return withLock(request.tenantId(), request.key(), request.expectedVersion(), request.operation());
        }
        throw new IllegalArgumentException("expected an OptimisticLockPort.LockRequest");
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param tenantId        the owning tenant
     * @param key             the locked key
     * @param expectedVersion the version that must still hold
     * @param operation       the operation to run under the lock
     */
    record LockRequest(TenantId tenantId, String key, long expectedVersion, Supplier<?> operation) {}
}
