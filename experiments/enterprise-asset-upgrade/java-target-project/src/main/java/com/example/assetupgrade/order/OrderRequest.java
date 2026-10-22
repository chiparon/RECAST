package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.TenantId;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tenant-scoped order submission carried by an {@link OrderCommand}.
 *
 * <p>The record components {@code orderId, tenantId, actorId, lines, currency} are the public
 * contract. {@code lines} is defensively copied into an unmodifiable list that tolerates a
 * {@code null} element so {@link OrderValidator} can report the problem instead of the
 * constructor failing. Duplicate SKUs are aggregated on demand through {@link #demandBySku()};
 * the submitted line list is preserved unchanged.</p>
 *
 * @param orderId  the order identity
 * @param tenantId the owning tenant
 * @param actorId  the actor submitting the order
 * @param lines    the requested order lines
 * @param currency the ISO-shaped currency code of the order
 */
public record OrderRequest(String orderId, TenantId tenantId, ActorId actorId, List<OrderLine> lines,
                           String currency) {

    public OrderRequest {
        lines = lines == null
                ? List.of()
                : Collections.unmodifiableList(new ArrayList<>(lines));
    }

    /** @return {@code true} when {@code tenantId} owns this order. */
    public boolean belongsTo(TenantId tenantId) {
        return tenantId != null && tenantId.equals(this.tenantId);
    }

    /** @return {@code true} when at least one order line was requested. */
    public boolean hasLines() {
        return !lines.isEmpty();
    }

    /** @return the number of submitted order lines. */
    public int lineCount() {
        return lines.size();
    }

    /**
     * @return the total of the line prices in minor currency units.
     * @throws ArithmeticException when a line total or the running total overflows a {@code long}
     */
    public long lineTotalMinor() {
        long total = 0L;
        for (OrderLine line : lines) {
            if (line == null) {
                continue;
            }
            total = Math.addExact(total, line.lineTotalMinor());
        }
        return total;
    }

    /** @return the aggregated requested quantity keyed by SKU, preserving submission order. */
    public Map<String, Integer> demandBySku() {
        Map<String, Integer> demand = new LinkedHashMap<>();
        for (OrderLine line : lines) {
            if (line == null || line.sku() == null) {
                continue;
            }
            demand.merge(line.sku(), line.quantity(), Integer::sum);
        }
        return Collections.unmodifiableMap(demand);
    }

    /** @return the distinct SKUs requested by this order, preserving submission order. */
    public List<String> skus() {
        List<String> ordered = new ArrayList<>();
        for (OrderLine line : lines) {
            if (line == null || line.sku() == null || ordered.contains(line.sku())) {
                continue;
            }
            ordered.add(line.sku());
        }
        return Collections.unmodifiableList(ordered);
    }

    /** Creates an order request from its parts. */
    public static OrderRequest of(String orderId, TenantId tenantId, ActorId actorId, List<OrderLine> lines,
                                  String currency) {
        return new OrderRequest(orderId, tenantId, actorId, lines, currency);
    }
}
