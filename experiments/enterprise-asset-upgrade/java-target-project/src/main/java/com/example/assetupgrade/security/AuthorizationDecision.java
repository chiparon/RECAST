package com.example.assetupgrade.security;

import java.util.Set;

/**
 * Explicit, data-only outcome of an authorization evaluation.
 *
 * <p>The record components are part of the public contract and must not change. A denial
 * is modeled as data and is never thrown from this type; boundary code decides whether a
 * denial becomes a typed failure.</p>
 */
public record AuthorizationDecision(boolean allowed, String reason, Set<Permission> evaluatedPermissions) {

    public AuthorizationDecision {
        reason = reason == null ? "" : reason;
        evaluatedPermissions = evaluatedPermissions == null ? Set.of() : Set.copyOf(evaluatedPermissions);
    }

    /** Creates an allow decision that records the permissions that were evaluated. */
    public static AuthorizationDecision allow(Set<Permission> evaluatedPermissions) {
        return new AuthorizationDecision(true, "", evaluatedPermissions);
    }

    /** Creates an allow decision with no recorded permissions. */
    public static AuthorizationDecision allow() {
        return allow(Set.of());
    }

    /** Creates a deny decision with a descriptive reason and the evaluated permissions. */
    public static AuthorizationDecision deny(String reason, Set<Permission> evaluatedPermissions) {
        return new AuthorizationDecision(false, reason, evaluatedPermissions);
    }

    /** Creates a deny decision with a descriptive reason and no recorded permissions. */
    public static AuthorizationDecision deny(String reason) {
        return deny(reason, Set.of());
    }

    /** @return {@code true} when the decision is an allow. */
    public boolean isAllowed() {
        return allowed;
    }

    /** @return {@code true} when the decision is a denial. */
    public boolean isDenied() {
        return !allowed;
    }

    /** @return {@code true} when no evaluated permissions were recorded. */
    public boolean hasEvaluatedPermissions() {
        return !evaluatedPermissions.isEmpty();
    }
}
