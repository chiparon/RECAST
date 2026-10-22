package com.example.assetupgrade.common;

import java.util.Objects;
import java.util.UUID;

/**
 * Vendor-neutral identifier for an isolated tenant.
 *
 * <p>The single record component {@code value} and its accessor are part of the public
 * contract: caller records across the order, attachment, workflow, reconciliation, audit
 * and security modules bind directly to them.</p>
 */
public record TenantId(String value) {

    public TenantId {
        value = normalize(value, "value");
    }

    private static String normalize(String raw, String name) {
        String trimmed = Objects.requireNonNull(raw, name).trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return trimmed;
    }

    /** Creates a tenant id from its textual representation, trimming surrounding whitespace. */
    public static TenantId of(String value) {
        return new TenantId(value);
    }

    /** Creates a tenant id from a UUID using its canonical textual form. */
    public static TenantId of(UUID value) {
        return new TenantId(Objects.requireNonNull(value, "value").toString());
    }

    /** Tenant ids are always present; provided as a symmetric guard with other identity types. */
    public boolean isPresent() {
        return !value.isEmpty();
    }

    @Override
    public String toString() {
        return value;
    }
}
