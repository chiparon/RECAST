package com.example.assetupgrade.order;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;

import java.util.ArrayList;
import java.util.Currency;
import java.util.List;
import java.util.Locale;

/**
 * Application-layer validation seam for an {@link OrderRequest}.
 *
 * <p>Implementations return every {@link ServiceProblem} that blocks submission; an empty list
 * means the order is acceptable. Validation is a provider-neutral decision: tenant and actor
 * presence, order identity, currency, line structure, positive quantities and non-negative prices
 * are decided here and never leak into adapters. The order is validated before inventory is
 * touched.</p>
 */
public interface OrderValidator {

    /**
     * Validates {@code order}.
     *
     * @param order the order to validate, possibly {@code null}
     * @return the blocking problems, empty when the order is acceptable
     */
    List<ServiceProblem> validate(OrderRequest order);

    /** @return the default structural validator. */
    static OrderValidator defaults() {
        return Validator.INSTANCE;
    }

    /** Alias of {@link #defaults()} matching the history validator naming. */
    static OrderValidator standard() {
        return defaults();
    }

    /**
     * Default validator translating the history field validators ({@code positive_number},
     * {@code non_negative_number}, {@code valid_metadata}) into explicit order decisions.
     */
    final class Validator implements OrderValidator {

        /** Shared stateless instance. */
        public static final Validator INSTANCE = new Validator();

        @Override
        public List<ServiceProblem> validate(OrderRequest order) {
            List<ServiceProblem> problems = new ArrayList<>();
            if (order == null) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "order request is required"));
                return problems;
            }
            if (order.tenantId() == null) {
                problems.add(ServiceProblem.of(ProblemCode.TENANT_DENIED, "order tenant is required", order.orderId()));
            }
            if (order.actorId() == null) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "order actor is required", order.orderId()));
            }
            if (order.orderId() == null || order.orderId().isBlank()) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "orderId is required"));
            }
            validateCurrency(order, problems);
            List<OrderLine> lines = order.lines();
            if (lines.isEmpty()) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "at least one order line is required", order.orderId()));
            }
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
                }
                if (!line.isPositiveQuantity()) {
                    problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                            "order line " + index + " quantity must be positive, got: " + line.quantity(),
                            order.orderId()).withAttribute("sku", String.valueOf(line.sku())));
                }
                if (!line.isNonNegativePrice()) {
                    problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                            "order line " + index + " unit price must be non-negative, got: " + line.unitPriceMinor(),
                            order.orderId()).withAttribute("sku", String.valueOf(line.sku())));
                }
            }
            return problems;
        }

        private void validateCurrency(OrderRequest order, List<ServiceProblem> problems) {
            String currency = order.currency();
            if (currency == null || currency.isBlank()) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT, "order currency is required", order.orderId()));
                return;
            }
            String code = currency.trim().toUpperCase(Locale.ROOT);
            if (code.length() != 3 || !code.chars().allMatch(Character::isLetter)) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "unknown order currency: " + currency, order.orderId()));
                return;
            }
            try {
                Currency.getInstance(code);
            } catch (IllegalArgumentException unknown) {
                problems.add(ServiceProblem.of(ProblemCode.INVALID_INPUT,
                        "unknown order currency: " + currency, order.orderId()));
            }
        }
    }
}
