package com.example.assetupgrade.persistence;

import com.example.assetupgrade.common.TenantId;

/**
 * Typed failure raised by the persistence and serialization ports.
 *
 * <p>The exception keeps its original {@link RuntimeException} base and message-only constructor for
 * compatibility, while carrying the tenant, the failing operation and whether the failure may be
 * retried. Provider-specific storage or codec failures are wrapped in this type so that no raw
 * provider exception leaks out of a port.</p>
 */
public class RepositoryException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final TenantId tenantId;
    private final String operation;
    private final boolean retryable;

    /** Creates a failure with only a message. */
    public RepositoryException(String message) {
        this(null, null, message, null, false);
    }

    /** Creates a failure with a message and cause. */
    public RepositoryException(String message, Throwable cause) {
        this(null, null, message, cause, false);
    }

    /** Creates a tenant- and operation-scoped failure with a cause. */
    public RepositoryException(TenantId tenantId, String operation, String message, Throwable cause) {
        this(tenantId, operation, message, cause, false);
    }

    /** Creates a fully-scoped failure. */
    public RepositoryException(TenantId tenantId, String operation, String message, Throwable cause,
                               boolean retryable) {
        super(message, cause);
        this.tenantId = tenantId;
        this.operation = operation;
        this.retryable = retryable;
    }

    /** @return the owning tenant, or {@code null} when unknown. */
    public TenantId tenantId() {
        return tenantId;
    }

    /** @return the failing operation, or {@code null} when unknown. */
    public String operation() {
        return operation;
    }

    /** @return {@code true} when the failure may be retried without changing the input. */
    public boolean retryable() {
        return retryable;
    }
}
