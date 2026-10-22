package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Typed failure for the RetryableTransportException condition, classified as {@link ProblemCode#TRANSPORT_FAILURE}.
 */
public class RetryableTransportException extends AssetUpgradeException {

    private static final long serialVersionUID = 1L;

    public RetryableTransportException(String message) {
        super(ProblemCode.TRANSPORT_FAILURE, message);
    }

    public RetryableTransportException(String message, Throwable cause) {
        super(ProblemCode.TRANSPORT_FAILURE, message, cause);
    }

    /** @return always {@code true}; this failure is transiently retryable. */
    public boolean retryable() {
        return true;
    }
}
