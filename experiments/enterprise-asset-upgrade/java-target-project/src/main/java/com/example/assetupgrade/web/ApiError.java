package com.example.assetupgrade.web;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.error.AssetUpgradeException;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Public, provider-neutral error representation returned by the web API surface.
 *
 * <p>This record is the translation of the APScheduler {@code _exceptions.py} catalogue and
 * the {@code _enums.py} outcome vocabulary into a single deterministic error shape. It
 * carries a stable {@code code}, a human-readable {@code message}, an HTTP-shaped
 * {@code status}, the offending {@code subjectId}, a {@code retryable} flag and rendering
 * {@code attributes}. The canonical constructor normalises the code and defensively copies
 * the attribute map so an error can feed a transport seam without translation.</p>
 *
 * @param code       the stable, upper-case error code
 * @param message    the human-readable explanation
 * @param status     the HTTP-shaped status code
 * @param subjectId  the subject that caused the error, or {@code null}
 * @param retryable  whether the same request may be retried unchanged
 * @param attributes additional rendering attributes, never {@code null}
 */
public record ApiError(String code, String message, int status, String subjectId, boolean retryable,
                       Map<String, String> attributes) {

    /** Fallback code used when no classification is available. */
    public static final String UNKNOWN = "UNKNOWN";

    public ApiError {
        code = code == null || code.isBlank() ? UNKNOWN : code.trim();
        message = message == null ? "" : message;
        attributes = attributes == null ? Map.of() : Map.copyOf(attributes);
    }

    /** Creates an error with no subject or attributes. */
    public ApiError(String code, String message, int status) {
        this(code, message, status, null, false, Map.of());
    }

    /** Creates an error with a retryability flag and no subject or attributes. */
    public ApiError(String code, String message, int status, boolean retryable) {
        this(code, message, status, null, retryable, Map.of());
    }

    /** Creates an error without attributes. */
    public ApiError(String code, String message, int status, String subjectId, boolean retryable) {
        this(code, message, status, subjectId, retryable, Map.of());
    }

    /** Creates an error from its parts without attributes. */
    public static ApiError of(String code, String message, int status) {
        return new ApiError(code, message, status, null, false, Map.of());
    }

    /** Creates an error from its full parts. */
    public static ApiError of(String code, String message, int status, String subjectId, boolean retryable,
                              Map<String, String> attributes) {
        return new ApiError(code, message, status, subjectId, retryable, attributes);
    }

    /** Builds an error from a {@link ServiceProblem}, deriving the status from its code. */
    public static ApiError from(ServiceProblem problem) {
        if (problem == null) {
            return new ApiError(ProblemCode.INVALID_INPUT.name(), "service problem is required",
                    statusFor(ProblemCode.INVALID_INPUT), null, ProblemCode.INVALID_INPUT.isRetryable(), Map.of());
        }
        ProblemCode code = problem.code();
        return new ApiError(code.name(), problem.message(), statusFor(code), problem.subjectId(),
                code.isRetryable(), problem.attributes());
    }

    /** Alias of {@link #from(ServiceProblem)}. */
    public static ApiError fromProblem(ServiceProblem problem) {
        return from(problem);
    }

    /** Builds an error from a {@link ProblemCode} and message. */
    public static ApiError from(ProblemCode code, String message, String subjectId) {
        ProblemCode effective = code == null ? ProblemCode.INVALID_INPUT : code;
        return new ApiError(effective.name(), message, statusFor(effective), subjectId,
                effective.isRetryable(), Map.of());
    }

    /** Builds an error from a typed module failure, preserving its {@link ProblemCode}. */
    public static ApiError from(AssetUpgradeException failure) {
        if (failure == null) {
            return new ApiError(UNKNOWN, "failure is required", 500, null, false, Map.of());
        }
        ProblemCode code = failure.problemCode();
        String derivedCode = code == null ? failure.getClass().getSimpleName() : code.name();
        int status = code == null ? 500 : statusFor(code);
        boolean retryable = code != null && code.isRetryable();
        Map<String, String> attributes = new LinkedHashMap<>();
        attributes.put("exception", failure.getClass().getName());
        if (code != null) {
            attributes.put("problemCode", code.name());
        }
        return new ApiError(derivedCode, failure.getMessage(), status, null, retryable, attributes);
    }

    /** Alias of {@link #from(AssetUpgradeException)}. */
    public static ApiError fromException(AssetUpgradeException failure) {
        return from(failure);
    }

    /** Builds an error from an arbitrary throwable, keeping typed failures precise. */
    public static ApiError from(Throwable failure) {
        if (failure == null) {
            return new ApiError(UNKNOWN, "failure is required", 500, null, false, Map.of());
        }
        if (failure instanceof AssetUpgradeException typed) {
            return from(typed);
        }
        Map<String, String> attributes = new LinkedHashMap<>();
        attributes.put("exception", failure.getClass().getName());
        return new ApiError(failure.getClass().getSimpleName(), failure.getMessage(), 500, null, false, attributes);
    }

    /** Alias of {@link #from(Throwable)}. */
    public static ApiError fromException(Throwable failure) {
        return from(failure);
    }

    /** @return the deterministic HTTP-shaped status for {@code code}. */
    public static int statusFor(ProblemCode code) {
        if (code == null) {
            return 500;
        }
        return switch (code) {
            case INVALID_INPUT -> 400;
            case TENANT_DENIED -> 403;
            case NOT_FOUND -> 404;
            case CONFLICT -> 409;
            case QUARANTINED -> 422;
            case RETRYABLE -> 503;
            case TRANSPORT_FAILURE -> 502;
            case RETRY_EXHAUSTED -> 503;
            case AUDIT_FAILURE, STORAGE_FAILURE -> 500;
        };
    }

    /** @return {@code true} when the status classifies a caller error ({@code 4xx}). */
    public boolean isClientError() {
        return status >= 400 && status < 500;
    }

    /** @return {@code true} when the status classifies a server/dependency error ({@code 5xx}). */
    public boolean isServerError() {
        return status >= 500;
    }

    /** @return {@code true} when no automatic retry should be attempted. */
    public boolean isTerminal() {
        return !retryable;
    }

    /** @return a copy of this error carrying an additional rendering attribute. */
    public ApiError withAttribute(String key, String value) {
        Objects.requireNonNull(key, "key");
        Map<String, String> copy = new LinkedHashMap<>(attributes);
        copy.put(key, value);
        return new ApiError(code, message, status, subjectId, retryable, copy);
    }
}
