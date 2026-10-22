package com.example.assetupgrade.error;

import com.example.assetupgrade.common.ProblemCode;

/**
 * Typed failure for the TenantAccessException condition, classified as {@link ProblemCode#TENANT_DENIED}.
 */
public class TenantAccessException extends AssetUpgradeException {

    private static final long serialVersionUID = 1L;

    public TenantAccessException(String message) {
        super(ProblemCode.TENANT_DENIED, message);
    }

    public TenantAccessException(String message, Throwable cause) {
        super(ProblemCode.TENANT_DENIED, message, cause);
    }
}
