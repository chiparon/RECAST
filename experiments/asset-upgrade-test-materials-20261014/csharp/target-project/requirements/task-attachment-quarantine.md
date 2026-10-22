# Attachment quarantine

Implement the attachment intake path for the current tenant. Validate tenant
ownership, safe filenames, size limits and content signatures. An attachment
that has not passed scanning must remain quarantined and must not enter the
approval workflow. Repeated submission of the same attachment must be
idempotent and auditable.

The public interfaces in `src/AssetUpgradeGateway/Contracts.cs` are the target
contract. Keep the implementation independent from a particular identity or
queue vendor.
