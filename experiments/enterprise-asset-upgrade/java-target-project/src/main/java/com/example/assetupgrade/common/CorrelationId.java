package com.example.assetupgrade.common;

import java.util.Objects;
import java.util.UUID;

/**
 * Vendor-neutral correlation identifier propagated across commands, events and audits.
 *
 * <p>The single record component {@code value} and its accessor are part of the public
 * contract; attachment, order, workflow and audit records bind directly to them.</p>
 */
public record CorrelationId(String value) {

    public CorrelationId {
        value = normalize(value, "value");
    }

    private static String normalize(String raw, String name) {
        String trimmed = Objects.requireNonNull(raw, name).trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return trimmed;
    }

    /** Creates a correlation id from its textual representation, trimming surrounding whitespace. */
    public static CorrelationId of(String value) {
        return new CorrelationId(value);
    }

    /** Creates a correlation id from a UUID using its canonical textual form. */
    public static CorrelationId of(UUID value) {
        return new CorrelationId(Objects.requireNonNull(value, "value").toString());
    }

    /** Generates a fresh, request-scoped correlation id. */
    public static CorrelationId generate() {
        return new CorrelationId(UUID.randomUUID().toString());
    }

    /** Alias of {@link #generate()} for call sites that prefer an explicit random name. */
    public static CorrelationId random() {
        return generate();
    }

    /** Correlation ids are always present; provided as a symmetric guard with other identity types. */
    public boolean isPresent() {
        return !value.isEmpty();
    }

    @Override
    public String toString() {
        return value;
    }
}
