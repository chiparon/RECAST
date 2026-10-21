package com.example.assetupgrade.web;

import com.example.assetupgrade.order.OrderLine;

/**
 * Public web request describing one order line.
 *
 * <p>Mirrors the APScheduler shared-model pattern: the type is a permissive carrier so
 * the application-layer {@code OrderValidator} can report a structured problem instead of
 * the constructor throwing on a blank SKU, a non-positive quantity or a negative price.
 * {@link #toOrderLine()} bridges to the typed domain record.</p>
 */
public record OrderLineDto(String sku, int quantity, long unitPriceMinor) {

    public OrderLineDto {
        sku = sku == null ? null : sku.trim();
    }

    /** @return the typed order line described by this DTO. */
    public OrderLine toOrderLine() {
        return OrderLine.of(sku, quantity, unitPriceMinor);
    }

    /** @return a copy of this DTO with the supplied quantity. */
    public OrderLineDto withQuantity(int newQuantity) {
        return new OrderLineDto(sku, newQuantity, unitPriceMinor);
    }

    /** @return a copy of this DTO with the supplied unit price. */
    public OrderLineDto withUnitPriceMinor(long newUnitPriceMinor) {
        return new OrderLineDto(sku, quantity, newUnitPriceMinor);
    }
}
