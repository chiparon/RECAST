# Order plugin bridge

Implement the tenant-aware order-plugin boundary. Validate the command and
all order lines before touching inventory. Resolve the plugin capability,
reserve inventory through the port, and commit the order and its audit evidence
within an atomic transaction boundary. A duplicate command must return the
existing outcome without reserving or committing again. If commit or audit
fails, release the reservation, leave idempotency incomplete, record a
rollback/failure outcome, and allow a later retry. Tenant, actor, plugin
capability, pricing/payment, and authorization decisions must be explicit in
the application layer.

Use repository, inventory, reservation ledger, transaction, plugin registry,
order event, lock, idempotency, and audit ports. nopCommerce or Camel concepts
may guide the design, but provider code belongs only in adapters.
