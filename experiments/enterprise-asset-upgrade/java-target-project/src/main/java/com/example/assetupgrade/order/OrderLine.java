package com.example.assetupgrade.order;

/**
 * One requested line of an order: a stock-keeping unit, a quantity and a unit price in the
 * minor unit of the order currency.
 *
 * <p>The record components are the public contract. The type is intentionally a permissive
 * data carrier so that {@link OrderValidator} can report a {@code ServiceProblem} for a blank
 * SKU, a non-positive quantity or a negative price rather than throwing during construction.</p>
 *
 * @param sku            the requested stock-keeping unit
 * @param quantity       the requested quantity; must be positive to be valid
 * @param unitPriceMinor the unit price in minor currency units; must be non-negative to be valid
 */
public record OrderLine(String sku, int quantity, long unitPriceMinor) {

    /** @return the tenant-neutral total of this line in minor currency units. */
    public long lineTotalMinor() {
        return Math.multiplyExact(unitPriceMinor, (long) quantity);
    }

    /** @return {@code true} when a SKU is present. */
    public boolean hasSku() {
        return sku != null && !sku.isBlank();
    }

    /** @return {@code true} when the requested quantity is strictly positive. */
    public boolean isPositiveQuantity() {
        return quantity > 0;
    }

    /** @return {@code true} when the unit price is non-negative. */
    public boolean isNonNegativePrice() {
        return unitPriceMinor >= 0;
    }

    /** @return {@code true} when the line satisfies every structural intake rule. */
    public boolean isValid() {
        return hasSku() && isPositiveQuantity() && isNonNegativePrice();
    }

    /** @return a copy of this line with the supplied quantity. */
    public OrderLine withQuantity(int newQuantity) {
        return new OrderLine(sku, newQuantity, unitPriceMinor);
    }

    /** @return a copy of this line with the supplied unit price. */
    public OrderLine withUnitPriceMinor(long newUnitPriceMinor) {
        return new OrderLine(sku, quantity, newUnitPriceMinor);
    }

    /** Creates a line from its parts. */
    public static OrderLine of(String sku, int quantity, long unitPriceMinor) {
        return new OrderLine(sku, quantity, unitPriceMinor);
    }
}
