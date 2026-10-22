package com.example.assetupgrade.common;

import java.util.Objects;
import java.util.UUID;

/**
 * Vendor-neutral identifier for the principal performing an operation.
 *
 * <p>The single record component {@code value} and its accessor are part of the public
 * contract; identity, order, attachment and security seams bind directly to them.</p>
 */
public record ActorId(String value) {

    public ActorId {
        value = normalize(value, "value");
    }

    private static String normalize(String raw, String name) {
        String trimmed = Objects.requireNonNull(raw, name).trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return trimmed;
    }

    /** Creates an actor id from its textual representation, trimming surrounding whitespace. */
    public static ActorId of(String value) {
        return new ActorId(value);
    }

    /** Creates an actor id from a UUID using its canonical textual form. */
    public static ActorId of(UUID value) {
        return new ActorId(Objects.requireNonNull(value, "value").toString());
    }

    /** Actor ids are always present; provided as a symmetric guard with other identity types. */
    public boolean isPresent() {
        return !value.isEmpty();
    }

    @Override
    public String toString() {
        return value;
    }
}
