package com.example.assetupgrade.common;

import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;

/**
 * Vendor-neutral outcome of a service operation: either a value or one or more problems.
 *
 * <p>The generic record shape is part of the public contract; consistency enforcement and
 * factory/helper methods are added here.</p>
 *
 * @param <T> payload type carried on success
 */
public record ServiceResult<T>(boolean successful, T value, List<ServiceProblem> problems) {

    public ServiceResult {
        problems = problems == null ? List.of() : List.copyOf(problems);
        if (successful && !problems.isEmpty()) {
            throw new IllegalArgumentException("a successful result must not carry problems");
        }
        if (!successful && problems.isEmpty()) {
            throw new IllegalArgumentException("a failed result must carry at least one problem");
        }
    }

    /** Creates a successful result carrying {@code value}. */
    public static <T> ServiceResult<T> success(T value) {
        return new ServiceResult<>(true, value, List.of());
    }

    /** Creates a failed result from one or more problems. */
    public static <T> ServiceResult<T> failure(ServiceProblem... problems) {
        Objects.requireNonNull(problems, "problems");
        return new ServiceResult<>(false, null, List.of(problems));
    }

    /** Creates a failed result from a list of problems. */
    public static <T> ServiceResult<T> failure(List<ServiceProblem> problems) {
        return new ServiceResult<>(false, null, problems);
    }

    /** @return {@code true} when the operation succeeded. */
    public boolean isSuccess() {
        return successful;
    }

    /** @return {@code true} when the operation failed. */
    public boolean isFailure() {
        return !successful;
    }

    /** @return the first problem, if any. */
    public Optional<ServiceProblem> firstProblem() {
        return problems.isEmpty() ? Optional.empty() : Optional.of(problems.get(0));
    }

    /** Maps the success payload while leaving a failure untouched. */
    public <R> ServiceResult<R> map(Function<? super T, ? extends R> mapper) {
        Objects.requireNonNull(mapper, "mapper");
        return successful ? ServiceResult.success(mapper.apply(value)) : ServiceResult.failure(problems);
    }
}
