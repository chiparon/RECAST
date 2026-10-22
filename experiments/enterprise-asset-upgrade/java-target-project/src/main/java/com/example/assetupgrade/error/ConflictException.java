package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Typed failure for the ConflictException condition, classified as {@link ProblemCode#CONFLICT}.
 */
public class ConflictException extends AssetUpgradeException {

    private static final long serialVersionUID = 1L;

    public ConflictException(String message) {
        super(ProblemCode.CONFLICT, message);
    }

    public ConflictException(String message, Throwable cause) {
        super(ProblemCode.CONFLICT, message, cause);
    }
}
