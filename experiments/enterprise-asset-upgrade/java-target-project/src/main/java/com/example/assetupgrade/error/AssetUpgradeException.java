package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Base typed failure for the asset-upgrade module.
 *
 * <p>This class is the root of the module error hierarchy. The message-only constructor
 * is part of the public contract; code-bearing constructors have been added. The type
 * remains a {@link RuntimeException} so existing catch and propagation sites are
 * unaffected, and it is intentionally not final to allow the concrete subtypes.</p>
 */
public class AssetUpgradeException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final ProblemCode problemCode;

    /** Creates a failure with no associated {@link ProblemCode}. */
    public AssetUpgradeException(String message) {
        super(message);
        this.problemCode = null;
    }

    /** Creates a failure with no associated {@link ProblemCode} and a cause. */
    public AssetUpgradeException(String message, Throwable cause) {
        super(message, cause);
        this.problemCode = null;
    }

    /** Creates a failure classified by {@code code}. */
    public AssetUpgradeException(ProblemCode code, String message) {
        super(message);
        this.problemCode = code;
    }

    /** Creates a failure classified by {@code code} with a cause. */
    public AssetUpgradeException(ProblemCode code, String message, Throwable cause) {
        super(message, cause);
        this.problemCode = code;
    }

    /** @return the problem classification, or {@code null} for the message-only constructors. */
    public ProblemCode problemCode() {
        return problemCode;
    }
}
