# Complete Java engineering scope

This document supplements, and does not replace, the four business requirements.
Deliver a complete implementation of the existing 250-file Java skeleton, not
just the four coordinators. Preserve all existing public records, methods,
constructor signatures, packages and port boundaries. You may add constructors,
implementations and typed overloads. Interfaces, records and enums need not grow
artificial behavior; every concrete executable skeleton seam must have meaningful
behavior and be reachable from its intended application, adapter or utility API.
Do not delete skeleton files, bypass build sources, relax compiler settings,
return identity/no-op results or retain placeholder UnsupportedOperationException
methods as substitutes for implementation. Invalid or unsupported requests may
be rejected explicitly with a meaningful argument/security/domain exception.
There is no minimum or maximum line count; do not add filler.

## Functional coverage

* Implement attachment validation, stream size bounds, filename/MIME/signature
  checks, fingerprinting, quarantine, clean-scan release, metadata lookup,
  object storage, cleanup, locking and tenant-scoped idempotency. Do not release
  during intake. Implement all declared attachment helpers and coordinators.
* Implement approved workflow delivery, envelopes, attempts, state transitions,
  payload mapping, route selection, tenant locks, idempotency, durable outbox,
  retries, dead letters, batch dispatch and workflow health/audit handlers.
* Implement order/plugin validation, pricing/payment/capability policies,
  reservation accounting, repository lookup, atomic commit and audit,
  compensation, duplicate handling and retryable rollback outcomes.
* Implement reconciliation windows, leases, checkpoints, retries, tenant
  filtering, batch orchestration, reports, metrics and audit even for empty runs.
* Complete shared identity/error types and every security concrete helper:
  resolve actor/tenant scopes, roles and permissions; deny expired scopes;
  partition permission caches by tenant and actor; audit denials without leaking
  another tenant's data. Enforce these decisions at application and web boundaries.
* Complete audit writing, query filtering/pagination, serialization, retention,
  decorators and failure policy. Audit failure must not falsely claim successful
  atomic business completion. Keep correlation and tenant identity throughout.
* Complete persistence connection/migration, optimistic locking, paging,
  transactions and outbox behavior. JDBC adapters must actually use JDBC and
  survive recreation against the same database; never replace JDBC/Postgres
  classes with process-local maps. Use parameterized SQL and tenant-scoped keys.
  Transactions must commit on success and roll back on failure.
* Complete messaging serialization, headers, topics, consumption, publication,
  retries and dead-letter handling. Preserve tenant/correlation/event identity
  across round trips and do not acknowledge failed delivery as success.
* Complete route registration/resolution, filters, transforms, protocol and
  endpoint health boundaries. Reject inactive/cross-tenant routes.
* Complete configuration loading/validation, all properties, adapter factory and
  module wiring. Validate missing or contradictory values before side effects.
  Wire usable services for all four business capabilities through the ports.
* Complete application façades, validators and asset lifecycle coordination.
  Complete web request/context/response mapping and AssetUpgradeEndpoints:
  requests must reach the application services, with tenant/actor validation
  and stable domain-error responses. A JDK HTTP server or a callable endpoint
  façade is acceptable; a message merely saying 'ready' is not an endpoint.
* Complete metrics, tracing, structured logging, correlation, liveness and
  readiness. Partition metrics by tenant, close traces on failure too, and
  report not-ready when a required dependency is unhealthy.
* Complete every declared provider adapter (JDBC, Postgres transaction, Kafka,
  S3, Keycloak, Camel, Flowable, BullMQ, Quartz, clock and health adapters).
  External services need not be deployed for this run. Accept injected clients
  or transports so provider behavior can be exercised offline; explicitly fail
  if an external provider is unconfigured instead of fabricating success.
  Provide an independently usable local profile with actual local adapters.

## Stable boundary contracts for underspecified skeleton seams

Many original seams expose Object execute(Object) or invoke(Object), so their
input formats were previously undefined. Implement the contracts below in
addition to any typed APIs you add. These are public API requirements, available
equally to both agents. They do not specify the host's test cases.

* ConfigurationLoader retains a public no-arg constructor. execute accepts a
  Map with `defaults` and `overrides` maps of String keys/values, returns a fresh
  merged Map<String,String>, overrides take precedence, inputs stay unchanged.
* ConfigurationValidator retains a public no-arg constructor. execute accepts
  Map<String,String>; `retry.maximumAttempts` must be positive,
  `attachment.maximumBytes` positive, and `environment` nonempty. Reject invalid
  input with IllegalArgumentException and return the validated map otherwise.
* JdbcOrderRepository adds public JdbcOrderRepository(javax.sql.DataSource).
  invoke accepts a Map: `action` save/find/delete, `tenantId`, `id`, and `record`
  (Map<String,String> for save). Save is an upsert. Find returns a copy of the
  record or null when absent. Delete removes only the matching tenant/id.
  Initialize the required schema without destroying existing data.
* PostgresTransactionAdapter adds public
  PostgresTransactionAdapter(javax.sql.DataSource), implements TransactionPort,
  and supplies <T> T inTransaction(Supplier<T>). JdbcOrderRepository operations
  with the same DataSource participate in that transaction. Exceptions roll
  back all its writes and propagate. Normal completion commits and returns T.
* MessageSerializer exposes public static String serialize(MessageEnvelope) and
  public static MessageEnvelope deserialize(String). Round trips preserve marker
  and all String attributes, including Unicode, quotes and escaped characters;
  reject malformed payloads. Use a real structured encoding, not toString().
* RouteFilter exposes public static boolean allows(RouteDefinition,MessageRequest).
  Their attributes carry `tenantId`; a route's attributes also carry `active`.
  Allow only an active route for the same nonempty tenant, deny otherwise.
* TenantBoundaryFilter retains a public no-arg constructor. execute accepts a
  map containing `requestTenantId` and `resourceTenantId`; allow only equal
  nonempty strings and throw SecurityException otherwise.
* MetricsAdapter retains a public no-arg constructor. execute accepts maps:
  `action=increment, tenantId, metric, delta` (Number), or
  `action=snapshot, tenantId`. Snapshot returns Map<String,Number>; increments
  accumulate, missing counters read as zero, tenant snapshots stay isolated.
* ReadinessProbe retains a public no-arg constructor. execute accepts
  Map<String,Boolean> required dependency health and returns Boolean: true only
  when the nonempty set of required dependencies are all healthy. Do not catch
  failures and return true.
* ApplicationModule exposes public static ApplicationModule createLocal(),
  and nonnull typed getters attachmentService(), workflowService(),
  reconciliationService(), orderService() using the original service interfaces.
  Each invocation creates an independently usable local service composition,
  using functional adapters, with shared state within that composition.
  AssetUpgradeGateway.main must initialize usable application wiring and exit
  cleanly for a local smoke run; document how to access its endpoint façade.

## Verification and completion

Use Java 21. Preserve the Maven release and -Xlint settings. Run Maven package
and your visible tests. Check the complete source inventory, not just files on
the four shortest call chains. Document provider injection, local startup and
any unresolved limitations honestly. Do not claim that compilation alone proves
all requirements. Tests owned by the host remain outside your workspace.
