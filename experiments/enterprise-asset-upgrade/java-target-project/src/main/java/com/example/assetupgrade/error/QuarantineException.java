package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Typed failure for the QuarantineException condition, classified as {@link ProblemCode#QUARANTINED}.
 */
public class QuarantineException extends AssetUpgradeException {

    private static final long serialVersionUID = 1L;

    public QuarantineException(String message) {
        super(ProblemCode.QUARANTINED, message);
    }

    public QuarantineException(String message, Throwable cause) {
        super(ProblemCode.QUARANTINED, message, cause);
    }
}
