# Workflow event delivery

Implement delivery of an approved workflow event from the Java module to a
configured route. The actor must be authorised for the event tenant and the
event must be in `APPROVED` state before dispatch. Persist an envelope and each
attempt, convert transport failures and dispatcher exceptions into a retryable
state, apply the retry policy, and dead-letter exhausted events. A successful
retry may advance the event only once; duplicate event identifiers must not
repeat a business side effect. Audit records must retain tenant, correlation,
event identity, attempt, and final state.

Use the workflow dispatcher, event store, outbox, lock, route, dead-letter, and
idempotency ports. The application layer must remain independent of Camel,
Flowable, Kafka, or any other provider adapter.
