package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Typed failure for the ValidationException condition, classified as {@link ProblemCode#INVALID_INPUT}.
 */
public class ValidationException extends AssetUpgradeException {

    private static final long serialVersionUID = 1L;

    public ValidationException(String message) {
        super(ProblemCode.INVALID_INPUT, message);
    }

    public ValidationException(String message, Throwable cause) {
        super(ProblemCode.INVALID_INPUT, message, cause);
    }
}
