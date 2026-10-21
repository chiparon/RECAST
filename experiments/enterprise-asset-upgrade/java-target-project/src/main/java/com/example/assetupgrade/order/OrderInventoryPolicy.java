package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.order.port.InventoryPort;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Application-layer inventory policy that aggregates per-SKU demand before the inventory port is
 * touched.
 *
 * <p>{@link #validate(OrderRequest)} verifies that the order carries at least one line, that every
 * requested quantity is strictly positive and that aggregating duplicate SKUs does not overflow.
 * Availability itself is enforced atomically by {@link InventoryPort#reserve(OrderRequest)}; this
 * policy only decides whether the demand is well formed enough to attempt a reservation, so no
 * inventory side effect is performed during validation.</p>
 */
public final class OrderInventoryPolicy {

    private final InventoryPort inventory;

    /** Creates a policy with no inventory port; demand validation still applies. */
    public OrderInventoryPolicy() {
        this(null);
    }

    /** Creates a policy aware of the inventory port it guards. */
    public OrderInventoryPolicy(InventoryPort inventory) {
        this.inventory = inventory;
    }

    /**
     * @return the blocking problems for {@code order}, empty when the demand may be reserved
     */
    public List<ServiceProblem> validate(OrderRequest order) {
        List<ServiceProblem> problems = new ArrayList<>();
        if (order == null) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "order request is required"));
            return problems;
        }
        List<OrderLine> lines = order.lines();
        if (lines.isEmpty()) {
            problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                    "at least one order line is required", order.orderId()));
            return problems;
        }
        Map<String, Integer> demand = new LinkedHashMap<>();
        for (int index = 0; index < lines.size(); index++) {
            OrderLine line = lines.get(index);
            if (line == null) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "order line " + index + " is required", order.orderId()));
                continue;
            }
            if (!line.hasSku()) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "order line " + index + " sku is required", order.orderId()));
                continue;
            }
            if (!line.isPositiveQuantity()) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "order line " + index + " quantity must be positive, got: " + line.quantity(),
                        order.orderId()).withAttribute("sku", line.sku()));
                continue;
            }
            try {
                demand.merge(line.sku(), line.quantity(), Math::addExact);
            } catch (ArithmeticException overflow) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "aggregated demand overflows for sku: " + line.sku(), order.orderId()));
            }
        }
        return problems;
    }

    /** @return {@code true} when the order demand may be reserved. */
    public boolean isSatisfiable(OrderRequest order) {
        return validate(order).isEmpty();
    }

    /** @return the first blocking problem, or {@code null} when the demand is acceptable. */
    public ServiceProblem firstProblem(OrderRequest order) {
        List<ServiceProblem> problems = validate(order);
        return problems.isEmpty() ? null : problems.get(0);
    }

    /** @return the aggregated requested quantity keyed by SKU. */
    public Map<String, Integer> demandBySku(OrderRequest order) {
        return order == null ? Map.of() : order.demandBySku();
    }

    /** @return the guarded inventory port, or {@code null} when none is configured. */
    public InventoryPort inventory() {
        return inventory;
    }

    /** Compatibility seam; accepts an {@link OrderRequest} and returns the blocking problems. */
    public Object execute(Object input) {
        if (input instanceof OrderRequest order) {
            return validate(order);
        }
        throw new IllegalArgumentException("Expected an OrderRequest");
    }
}
