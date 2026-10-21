package com.example.assetupgrade.order;

import com.example.assetupgrade.common.CommandMetadata;

/**
 * Tenant-scoped command carrying an order submission and the plugin it targets.
 *
 * <p>The record components {@code metadata, order, pluginId} are the public contract; the
 * metadata supplies the tenant, actor, correlation identity and receipt time used for
 * tenant-scoping, authorization and audit.</p>
 *
 * @param metadata the command metadata
 * @param order    the order request
 * @param pluginId the plugin the order is submitted through
 */
public record OrderCommand(CommandMetadata metadata, OrderRequest order, String pluginId) {

    /** @return the order identity, or {@code null} when the order is absent. */
    public String orderId() {
        return order == null ? null : order.orderId();
    }

    /** @return the tenant, or {@code null} when the metadata is absent. */
    public com.example.assetupgrade.common.TenantId tenantId() {
        return metadata == null ? null : metadata.tenantId();
    }

    /** Creates a command from its parts. */
    public static OrderCommand of(CommandMetadata metadata, OrderRequest order, String pluginId) {
        return new OrderCommand(metadata, order, pluginId);
    }
}
