package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.ServiceResult;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.order.port.OrderPricingPort;

import java.util.List;

/**
 * Application-layer pricing policy.
 *
 * <p>{@link #totalMinor(OrderRequest)} resolves the order total through the configured
 * {@link OrderPricingPort}, falling back to the sum of the line prices when no pricing provider is
 * present. Negative totals and {@code long} overflow are rejected as invalid input rather than
 * silently wrapping, so the priced total that reaches the payment and commit boundaries is always
 * trustworthy.</p>
 */
public final class OrderPricingPolicy {

    private final OrderPricingPort pricing;

    /** Creates a policy that sums the line prices itself. */
    public OrderPricingPolicy() {
        this(null);
    }

    /** Creates a policy delegating to {@code pricing} when present. */
    public OrderPricingPolicy(OrderPricingPort pricing) {
        this.pricing = pricing;
    }

    /**
     * @return the priced order total in minor currency units
     * @throws ValidationException when the order is missing, the total is negative or it overflows
     */
    public long totalMinor(OrderRequest order) {
        if (order == null) {
            throw new ValidationException("order request is required for pricing");
        }
        long total;
        try {
            total = pricing != null ? pricing.totalMinor(order) : order.lineTotalMinor();
        } catch (ArithmeticException overflow) {
            throw new ValidationException("order total overflows a long: " + order.orderId(), overflow);
        } catch (RuntimeException failure) {
            throw new ValidationException("order could not be priced: " + describe(failure), failure);
        }
        if (total < 0) {
            throw new ValidationException("order total must be non-negative, got: " + total);
        }
        return total;
    }

    /** @return the priced total as a {@link ServiceResult}, avoiding exceptions on the rejection path. */
    public ServiceResult<Long> calculate(OrderRequest order) {
        try {
            return ServiceResult.success(totalMinor(order));
        } catch (ValidationException failure) {
            return ServiceResult.failure(ServiceProblem.of(ProblemCode.INVALID_INPUT, failure.getMessage(),
                    order == null ? null : order.orderId()));
        }
    }

    /** @return {@code true} when the order can be priced without overflow or a negative total. */
    public boolean isPriceable(OrderRequest order) {
        return calculate(order).isSuccess();
    }

    /** @return the pricing port, or {@code null} when the line sum is used. */
    public OrderPricingPort pricing() {
        return pricing;
    }

    /** Compatibility seam; accepts an {@link OrderRequest} and returns the total. */
    public Object execute(Object input) {
        if (input instanceof OrderRequest order) {
            return totalMinor(order);
        }
        throw new IllegalArgumentException("Expected an OrderRequest");
    }

    private static String describe(RuntimeException failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }
}
