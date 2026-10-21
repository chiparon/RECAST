# Attachment quarantine

Implement a tenant-aware attachment intake boundary for the new Java module.
The endpoint accepts a stream and metadata, validates the tenant and actor,
normalises the filename, checks size and content signatures against the declared
MIME type, persists the attachment in quarantine, and only releases it after a
clean scan. An unscanned, rejected, cross-tenant, unsafe, oversized, or
signature-mismatched attachment must never create an approval event. Repeating
the same tenant-scoped attachment command must be idempotent and must emit one
audit record containing the attachment and correlation identifiers.

Use the declared ports for object storage, scanning, metadata, quarantine,
locking, event publication, and audit. Keep policy decisions in the application
layer and leave provider-specific details to adapters.
