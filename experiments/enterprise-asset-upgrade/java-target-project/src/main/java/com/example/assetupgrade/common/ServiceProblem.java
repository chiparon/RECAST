package com.example.assetupgrade.common;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Vendor-neutral description of a single failure surfaced by a service.
 *
 * <p>The record components are part of the public contract; normalization, factories and
 * functional updates are added here. {@code attributes} is a string-keyed map so that it
 * can feed rendering seams such as {@code web.ApiError} without translation.</p>
 */
public record ServiceProblem(ProblemCode code, String message, String subjectId, Map<String, String> attributes) {

    public ServiceProblem {
        Objects.requireNonNull(code, "code");
        message = message == null ? "" : message;
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** Creates a problem with no subject identifier and no attributes. */
    public static ServiceProblem of(ProblemCode code, String message) {
        return new ServiceProblem(code, message, null, null);
    }

    /** Creates a problem bound to the subject that caused it. */
    public static ServiceProblem of(ProblemCode code, String message, String subjectId) {
        return new ServiceProblem(code, message, subjectId, null);
    }

    /** Returns a new immutable problem with the given attribute added or replaced. */
    public ServiceProblem withAttribute(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new ServiceProblem(code, message, subjectId, copy);
    }

    /** @return {@code true} when the underlying code is transiently retryable. */
    public boolean isRetryable() {
        return code.isRetryable();
    }
}
