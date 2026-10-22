package com.example.assetupgrade.audit;

import java.util.Objects;
import java.util.Set;

/**
 * Decision seam consulted when an {@link AuditEntry} cannot be persisted.
 *
 * <p>The single abstract method {@code completionMayBeReportedWhenAuditFails} returns
 * {@code true} when the business outcome may still be reported despite the audit failure,
 * and {@code false} when the caller must surface a storage failure. Implementations must
 * never return {@code true} silently: making an audit failure observable is the caller's
 * responsibility.</p>
 */
public interface AuditFailurePolicy {

    boolean completionMayBeReportedWhenAuditFails(AuditEntry attemptedEntry);

    /** A policy that forbids reporting completion for any entry. */
    static AuditFailurePolicy forbidCompletion() {
        return attemptedEntry -> false;
    }

    /** A policy that allows reporting completion for any entry. */
    static AuditFailurePolicy allowCompletion() {
        return attemptedEntry -> true;
    }

    /** A policy that allows reporting completion only for the supplied final statuses. */
    static AuditFailurePolicy allowCompletionFor(AuditStatus... statuses) {
        Objects.requireNonNull(statuses, "statuses");
        Set<AuditStatus> allowed = Set.of(statuses);
        return attemptedEntry -> attemptedEntry != null && allowed.contains(attemptedEntry.status());
    }
}
