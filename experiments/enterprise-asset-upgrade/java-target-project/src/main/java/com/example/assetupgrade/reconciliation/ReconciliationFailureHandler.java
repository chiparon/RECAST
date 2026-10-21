package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.reconciliation.port.RetryableEventPort;
import com.example.assetupgrade.retry.ExponentialRetryPolicy;
import com.example.assetupgrade.retry.RetryPolicy;
import com.example.assetupgrade.retry.RetryPolicyOptions;
import com.example.assetupgrade.workflow.EventEnvelope;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Preserves retryability when a reconciliation dispatch fails.
 *
 * <p>A failed dispatch calls {@link RetryableEventPort#markRetryable(EventEnvelope, Instant)} so
 * the attempt is incremented and the record remains rerunnable for the next window; the retry
 * budget decides when a record is exhausted. A successful or terminal dispatch calls
 * {@link RetryableEventPort#close(EventEnvelope)} so a completed event is never dispatched twice.
 * When the budget is spent the record is closed rather than left open, which is the datastore's
 * release-with-outcome analogue.</p>
 */
public final class ReconciliationFailureHandler {

    /** Backoff applied by the default policy to the first retry. */
    public static final Duration DEFAULT_INITIAL_DELAY = Duration.ofSeconds(5);
    /** Upper bound applied by the default policy. */
    public static final Duration DEFAULT_MAXIMUM_DELAY = Duration.ofMinutes(10);
    /** Total attempts allowed by the default policy. */
    public static final int DEFAULT_MAXIMUM_ATTEMPTS = 5;

    private static final RetryPolicyOptions DEFAULT_OPTIONS = RetryPolicyOptions.exponential(
            DEFAULT_MAXIMUM_ATTEMPTS, DEFAULT_INITIAL_DELAY, DEFAULT_MAXIMUM_DELAY, 2.0d, false);

    private final RetryableEventPort retryableEvents;
    private final RetryPolicy retryPolicy;
    private final TimeProvider clock;

    /** Creates an unconfigured handler; recovery is a no-op. */
    public ReconciliationFailureHandler() {
        this(null, null, null);
    }

    /** Creates a handler over the retryable-event port with the default retry policy. */
    public ReconciliationFailureHandler(RetryableEventPort retryableEvents) {
        this(retryableEvents, null, null);
    }

    /** Creates a handler over the retryable-event port with an explicit retry policy. */
    public ReconciliationFailureHandler(RetryableEventPort retryableEvents, RetryPolicy retryPolicy) {
        this(retryableEvents, retryPolicy, null);
    }

    /** Creates a handler with an explicit retry policy and clock. */
    public ReconciliationFailureHandler(RetryableEventPort retryableEvents, RetryPolicy retryPolicy,
                                        TimeProvider clock) {
        this.retryableEvents = retryableEvents;
        this.retryPolicy = retryPolicy == null ? new ExponentialRetryPolicy(DEFAULT_OPTIONS) : retryPolicy;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** @return the 1-based attempt number recorded on {@code envelope}. */
    public int attemptOf(EventEnvelope envelope) {
        return envelope == null ? 0 : Math.max(0, envelope.deliveryAttempt());
    }

    /** @return {@code true} when the retry window for {@code envelope} has elapsed. */
    public boolean windowElapsed(EventEnvelope envelope, Instant now) {
        if (envelope == null) {
            return false;
        }
        Instant reference = now == null ? clock.now() : now;
        Instant next = envelope.nextAttemptAt();
        return next == null || !next.isAfter(reference);
    }

    /** @return {@code true} when {@code envelope} still has retry budget available. */
    public boolean hasBudget(EventEnvelope envelope) {
        return retryPolicy.canRetry(attemptOf(envelope));
    }

    /** @return the instant the next attempt should be scheduled for. */
    public Instant nextAttemptAt(EventEnvelope envelope) {
        return retryPolicy.nextAttempt(clock.now(), attemptOf(envelope));
    }

    /** Marks {@code envelope} rerunnable at the policy's next attempt instant. */
    public boolean markRetryable(EventEnvelope envelope) {
        if (envelope == null || retryableEvents == null) {
            return false;
        }
        retryableEvents.markRetryable(envelope, nextAttemptAt(envelope));
        return true;
    }

    /** Closes {@code envelope} so a completed or exhausted event is never replayed. */
    public boolean close(EventEnvelope envelope) {
        if (envelope == null || retryableEvents == null) {
            return false;
        }
        retryableEvents.close(envelope);
        return true;
    }

    /**
     * Recovers a failed dispatch: rerunnable when budget remains, otherwise closed as exhausted.
     *
     * @return {@code true} when the record was left rerunnable, {@code false} when it was closed
     */
    public boolean recover(EventEnvelope envelope, Throwable failure) {
        if (hasBudget(envelope)) {
            return markRetryable(envelope);
        }
        close(envelope);
        return false;
    }

    /** Recovery without an explicit failure: rerunnable when budget remains, otherwise closed. */
    public boolean recover(EventEnvelope envelope) {
        return recover(envelope, (Throwable) null);
    }

    /** Closes each envelope, returning the number successfully closed. */
    public int closeAll(List<EventEnvelope> envelopes) {
        if (envelopes == null || envelopes.isEmpty()) {
            return 0;
        }
        int closed = 0;
        for (EventEnvelope envelope : envelopes) {
            if (close(envelope)) {
                closed++;
            }
        }
        return closed;
    }

    /** @return the retry policy applied by this handler. */
    public RetryPolicy policy() {
        return retryPolicy;
    }

    /** @return the backing retryable-event port, or {@code null} when none is configured. */
    public RetryableEventPort port() {
        return retryableEvents;
    }

    /** Compatibility seam; recovers the supplied envelope. */
    public Object execute(Object input) {
        if (input instanceof EventEnvelope envelope) {
            return recover(envelope, null);
        }
        throw new IllegalArgumentException("Expected an EventEnvelope");
    }
}
