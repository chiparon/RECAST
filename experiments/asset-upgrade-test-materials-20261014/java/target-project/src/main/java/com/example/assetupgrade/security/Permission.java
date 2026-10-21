package com.example.assetupgrade.security;

/**
 * Skeleton seam for Permission.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum Permission { ATTACHMENT_SUBMIT, ATTACHMENT_RELEASE, WORKFLOW_DISPATCH, RECONCILIATION_RUN, ORDER_SUBMIT, AUDIT_READ, PLUGIN_REGISTER }
