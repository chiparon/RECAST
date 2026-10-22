package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Typed failure for the StorageFailureException condition, classified as {@link ProblemCode#STORAGE_FAILURE}.
 */
public class StorageFailureException extends AssetUpgradeException {

    private static final long serialVersionUID = 1L;

    public StorageFailureException(String message) {
        super(ProblemCode.STORAGE_FAILURE, message);
    }

    public StorageFailureException(String message, Throwable cause) {
        super(ProblemCode.STORAGE_FAILURE, message, cause);
    }
}
