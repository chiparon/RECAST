package com.example.assetupgrade.order.port;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.OrderSnapshot;

import java.util.Optional;

/**
 * Tenant-scoped persistence boundary for order snapshots.
 *
 * <p>{@link #find(TenantId, String)} reads only the snapshot owned by {@code tenantId};
 * {@link #save(OrderSnapshot)} persists the current state. No provider type appears here.</p>
 */
public interface OrderRepository {

    /** @return the snapshot for {@code orderId} owned by {@code tenantId}, if present. */
    Optional<OrderSnapshot> find(TenantId tenantId, String orderId);

    /** Persists {@code snapshot}. */
    void save(OrderSnapshot snapshot);

    /** Compatibility seam; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof FindRequest request) {
            return find(request.tenantId(), request.orderId());
        }
        if (input instanceof OrderSnapshot snapshot) {
            save(snapshot);
            return null;
        }
        throw new IllegalArgumentException("Expected a FindRequest or OrderSnapshot");
    }

    /** Request holder accepted by the compatibility seam. */
    record FindRequest(TenantId tenantId, String orderId) {
    }
}
