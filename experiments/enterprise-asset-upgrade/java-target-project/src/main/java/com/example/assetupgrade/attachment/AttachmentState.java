package com.example.assetupgrade.attachment;

/**
 * Lifecycle of an attachment as it moves from receipt through quarantine and scanning to
 * release.
 *
 * <p>The constant set and declaration order are part of the public contract and must not
 * change. Behavioural helpers added here describe the transitions the intake boundary is
 * allowed to perform.</p>
 */
public enum AttachmentState {
    RECEIVED,
    SCANNING,
    QUARANTINED,
    SCANNED,
    RELEASED,
    REJECTED;

    /** @return {@code true} when the attachment may no longer change state. */
    public boolean isTerminal() {
        return this == RELEASED || this == REJECTED;
    }

    /** @return {@code true} when the attachment is being (or has been) held back from release. */
    public boolean isHeld() {
        return this == QUARANTINED || this == RECEIVED || this == SCANNING;
    }

    /** @return {@code true} when a clean scan has cleared the attachment. */
    public boolean isClean() {
        return this == SCANNED || this == RELEASED;
    }

    /** @return {@code true} once the attachment has been released to its consumers. */
    public boolean isReleased() {
        return this == RELEASED;
    }

    /** @return {@code true} when the attachment failed validation or a scan. */
    public boolean isRejected() {
        return this == REJECTED;
    }

    /**
     * @return {@code true} when an attachment currently in this state may be released. Only a
     *         cleanly scanned attachment qualifies; a released attachment is already out.
     */
    public boolean mayRelease() {
        return this == SCANNED;
    }
}
