package com.example.assetupgrade.web;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.order.OrderCommand;
import com.example.assetupgrade.order.OrderLine;
import com.example.assetupgrade.order.OrderRequest;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Public web request describing one order submission.
 *
 * <p>Translated from the APScheduler shared-model normalisation pattern: identifiers are
 * trimmed, the line list is defensively copied tolerating a {@code null} element so the
 * application validator can report the problem, and {@link #toOrderRequest()} bridges to
 * the typed {@link OrderRequest}. Tenant, actor and correlation identity are textual
 * because they arrive from the transport layer.</p>
 */
public record OrderRequestDto(
        String orderId,
        String tenantId,
        String actorId,
        String currency,
        List<OrderLineDto> lines,
        String pluginId) {

    public OrderRequestDto {
        orderId = trim(orderId);
        tenantId = trim(tenantId);
        actorId = trim(actorId);
        currency = trim(currency);
        pluginId = trim(pluginId);
        lines = lines == null
                ? List.of()
                : Collections.unmodifiableList(new ArrayList<>(lines));
    }

    private static String trim(String value) {
        return value == null ? null : value.trim();
    }

    /** @return the typed order lines described by this DTO. */
    public List<OrderLine> toOrderLines() {
        List<OrderLine> result = new ArrayList<>(lines.size());
        for (OrderLineDto line : lines) {
            result.add(line == null ? null : line.toOrderLine());
        }
        return Collections.unmodifiableList(result);
    }

    /** @return the typed order request derived from this DTO. */
    public OrderRequest toOrderRequest() {
        return OrderRequest.of(orderId, tenantOrNull(tenantId), actorOrNull(actorId), toOrderLines(), currency);
    }

    /** @return the typed order request bound to the resolved metadata identity. */
    public OrderRequest toOrderRequest(TenantId tenant, ActorId actor) {
        return OrderRequest.of(orderId, tenant, actor, toOrderLines(), currency);
    }

    /** @return the order command bridging this request for {@code metadata}. */
    public OrderCommand toCommand(CommandMetadata metadata) {
        TenantId tenant = metadata == null ? null : metadata.tenantId();
        ActorId actor = metadata == null ? null : metadata.actorId();
        return OrderCommand.of(metadata, toOrderRequest(tenant, actor), pluginId);
    }

    /** @return a copy of this request bound to an explicit plugin identity. */
    public OrderRequestDto withPluginId(String newPluginId) {
        return new OrderRequestDto(orderId, tenantId, actorId, currency, lines, trim(newPluginId));
    }

    static TenantId tenantOrNull(String value) {
        return value == null || value.isBlank() ? null : TenantId.of(value);
    }

    static ActorId actorOrNull(String value) {
        return value == null || value.isBlank() ? null : ActorId.of(value);
    }
}
