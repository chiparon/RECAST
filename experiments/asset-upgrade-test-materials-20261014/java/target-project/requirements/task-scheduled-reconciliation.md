# Scheduled reconciliation

Implement a periodic, tenant-scoped reconciliation job for due retryable
workflow events. The scheduler acquires a lease, reads only events whose retry
window has elapsed and whose retry budget is still open, and dispatches them
through the same workflow boundary. A successful dispatch removes or closes
the retry record; a failure increments the attempt and leaves a rerunnable
record. Re-running the same window must be safe and must not dispatch a
completed event twice. Persist a checkpoint and an audit entry for every run,
including an empty run, and never read or mutate another tenant's records.

Use the due-window, retryable-event, lease, checkpoint, metrics, audit, and
clock ports. Quartz or another scheduler belongs behind an adapter.
