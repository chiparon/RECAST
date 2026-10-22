# AssetUpgradeGateway requirements

Implement all four requirements below for the current AssetUpgradeGateway target project.

## Attachment quarantine

Implement the attachment intake path for the current tenant. Validate tenant
ownership, safe filenames, size limits and content signatures. An attachment
that has not passed scanning must remain quarantined and must not enter the
approval workflow. Repeated submission of the same attachment must be
idempotent and auditable.

The public interfaces in `src/AssetUpgradeGateway/Contracts.cs` are the target
contract. Keep the implementation independent from a particular identity or
queue vendor.

## Workflow event delivery

Dispatch an approved asset event to a workflow. Transport failure must leave
the event retryable. A successful retry may advance the workflow only once.
The event identity and final state must appear in the audit record.

Use the target ports and preserve tenant boundaries. The implementation should
not depend directly on a historical project API.

## Scheduled reconciliation

Implement a periodic reconciliation operation for timed-out events. It may
process only events that are still retryable, must isolate tenants, and must be
safe to run repeatedly. A failed reconciliation can be retried and every run
must produce a traceable audit record.

## Order plugin bridge

Expose a stable port for a new order plugin. Validation, inventory reservation
and audit writing form one logical operation: incomplete input or a failed
reservation must leave the order state unchanged. Repeated requests must not
reserve inventory twice, and the plugin must depend on ports rather than a
concrete infrastructure implementation.
