package com.example.assetupgrade.common;

/**
 * Vendor-neutral classification of a failure that can be surfaced through the shared
 * service result and problem contracts.
 *
 * <p>The constant set and declaration order are part of the public contract; callers in
 * the order, attachment, workflow, reconciliation, audit and security modules depend on
 * these names. Only behavioral helpers are added here.</p>
 */
public enum ProblemCode {
    INVALID_INPUT,
    TENANT_DENIED,
    NOT_FOUND,
    CONFLICT,
    QUARANTINED,
    RETRYABLE,
    RETRY_EXHAUSTED,
    TRANSPORT_FAILURE,
    AUDIT_FAILURE,
    STORAGE_FAILURE;

    /**
     * @return {@code true} when the operation may be retried without changing the input,
     *         i.e. the failure is considered transient.
     */
    public boolean isRetryable() {
        return this == RETRYABLE || this == TRANSPORT_FAILURE;
    }

    /**
     * @return {@code true} when the failure is attributable to the caller's input or
     *         authority rather than to the server or a dependency.
     */
    public boolean isClientError() {
        return switch (this) {
            case INVALID_INPUT, TENANT_DENIED, NOT_FOUND, CONFLICT, QUARANTINED -> true;
            case RETRYABLE, RETRY_EXHAUSTED, TRANSPORT_FAILURE, AUDIT_FAILURE, STORAGE_FAILURE -> false;
        };
    }

    /**
     * @return {@code true} when the failure originates on the server or in a dependency.
     */
    public boolean isServerError() {
        return !isClientError();
    }

    /**
     * @return {@code true} when no further automatic attempt should be made for this
     *         failure, i.e. it is not retryable.
     */
    public boolean isTerminal() {
        return !isRetryable();
    }
}
