package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ServiceProblem;

import java.util.List;

/**
 * Outcome of an attachment intake or release operation.
 *
 * <p>The record components {@code accepted, state, fingerprint, problems} are the public
 * contract. An accepted result carries the terminal state reached by the operation; a
 * rejected or quarantined result carries the {@link ServiceProblem}s that explain the
 * decision. Duplicate replays are reported as accepted without any accompanying problems.</p>
 */
public record AttachmentIntakeResult(
        boolean accepted,
        AttachmentState state,
        String fingerprint,
        List<ServiceProblem> problems) {

    public AttachmentIntakeResult {
        state = state == null ? AttachmentState.REJECTED : state;
        fingerprint = fingerprint == null || fingerprint.isBlank() ? null : fingerprint;
        problems = problems == null ? List.of() : List.copyOf(problems);
    }

    /** Creates an accepted result ending in {@code state}. */
    public static AttachmentIntakeResult accepted(AttachmentState state, String fingerprint) {
        return new AttachmentIntakeResult(true, state, fingerprint, List.of());
    }

    /** Creates a rejected result carrying the supplied problems. */
    public static AttachmentIntakeResult rejected(AttachmentState state, String fingerprint, List<ServiceProblem> problems) {
        return new AttachmentIntakeResult(false, state, fingerprint, problems);
    }

    /** Creates a rejected result carrying a single problem. */
    public static AttachmentIntakeResult rejected(AttachmentState state, ServiceProblem problem) {
        return rejected(state, null, problem == null ? List.of() : List.of(problem));
    }

    /** Creates an accepted result describing a duplicate replay of a completed command. */
    public static AttachmentIntakeResult duplicate(AttachmentState state, String fingerprint) {
        return new AttachmentIntakeResult(true, state, fingerprint, List.of());
    }

    /** @return {@code true} when the operation succeeded. */
    public boolean isAccepted() {
        return accepted;
    }

    /** @return {@code true} when the operation did not succeed. */
    public boolean isRejected() {
        return !accepted;
    }

    /** @return {@code true} when the attachment was quarantined or rejected with evidence. */
    public boolean hasProblems() {
        return !problems.isEmpty();
    }

    /** @return {@code true} when the result reflects a clean, released attachment. */
    public boolean isReleased() {
        return accepted && state == AttachmentState.RELEASED;
    }

    /** @return the first problem, or {@code null} when none was reported. */
    public ServiceProblem firstProblem() {
        return problems.isEmpty() ? null : problems.get(0);
    }
}
