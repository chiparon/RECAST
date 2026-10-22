# Scheduled reconciliation

Implement a periodic reconciliation operation for timed-out events. It may
process only events that are still retryable, must isolate tenants, and must be
safe to run repeatedly. A failed reconciliation can be retried and every run
must produce a traceable audit record.
