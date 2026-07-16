# ADR-001: Modular Monolith with Durable Asynchronous Workers

- **Status:** Product direction approved 16 July 2026; Engineering, Security, Operations, Management, D-13/D-19/D-20 evidence, and every production gate remain pending/not passed
- **Date:** 2026-07-15
- **Decision owners:** Product (direction approved in this task; named record pending) and Engineering (technical approval pending)
- **Related:** `docs/CRM_PRODUCTION_PRD_V2_2026-07-15.md`, `docs/architecture/DATA_MODEL.md`, `db/migrations/0001_foundation.sql`

## Context

CRM Salam Fortress must become the trusted operational system for Salam Land, Bumi Hayat Printing, Barakah Emas, and future business units. It must preserve the useful workflow knowledge in the current CRM while replacing whole-state JSON persistence, shared identities, browser-owned business rules, local public files, synchronous provider processing, and ambiguous deployment/data ownership.

The proposed, unapproved design envelope is up to 20 business units, 500 named users, two million contacts/leads, 20 million activities/messages, 500 concurrent sessions, and webhook bursts of 100 events per second. PRD decision `D-18` must approve the envelope, workload skew and SLO contract. The system must remain correct during concurrent lead assignment, stage changes, lot holds, order approval, payment posting, refund processing, webhook replay, and deployment.

An immediate microservice decomposition would introduce distributed transactions, duplicated authorization, event-versioning overhead, and a much larger operational surface before the domain boundaries and production load are proven. Retaining the current unbounded monolith would preserve the same coupling and unsafe state model.

## Decision

Build V2 as a **modular monolith** with a single PostgreSQL transactional system of record and separately runnable asynchronous workers.

The deployable codebase may initially be one repository and one release version, but it has four runtime roles:

1. **Web/API:** stateless HTTP nodes serving authenticated product and command/query APIs.
2. **Dispatcher:** claims committed inbox/outbox rows and publishes durable work with stable event IDs.
3. **Worker:** performs provider normalization, assignment, messaging, sync, files, imports, exports, and other retryable jobs.
4. **Scheduler:** enqueues due work; it does not execute business mutations directly.

PostgreSQL is authoritative for business state, CRM session token hashes/metadata, transactional inbox/outbox records, idempotency decisions, and audit evidence. Redis may support reconstructable rate limits, short-lived caches/locks, and queue coordination, but Redis loss must not lose an authenticated identity decision or committed business work. Sensitive files live in private object storage. Credentials live in a secret manager and appear in the database only as opaque references.

## Module boundaries

The initial modules are:

1. Identity & Access
2. Organisation & Configuration
3. Contacts & Consent
4. Leads, Pipeline & Tasks
5. Assignment
6. Salam Land Inventory
7. Printing Operations
8. Gold Transactions
9. Orders & Finance
10. Marketing & Attribution
11. Conversations & Notifications
12. Integration Gateway
13. Files
14. Reporting
15. Audit & Privacy Operations

Each module owns its domain services, commands, queries, validation, tables, events, and tests. Modules may read another module only through an explicit query/service interface and may request mutation only through that module's command interface. Direct cross-module table mutation is prohibited outside a reviewed migration or repair tool.

The foundation migration groups related tables in one PostgreSQL schema for operational simplicity. Table proximity does not grant ownership: the module map above remains the write boundary.

## Transaction rules

A command runs inside one database transaction when it must preserve a business invariant. The transaction may include:

- the aggregate change;
- an optimistic-version comparison;
- the idempotency decision;
- append-only audit evidence; and
- one or more outbox events.

External network calls never occur while a business transaction is open. A worker performs the call after the transaction commits and records its outcome idempotently.

Examples of required atomic operations include:

- create or reuse Contact, create Lead, record attribution, and enqueue assignment;
- transition a Lead and append stage history;
- convert one Lead into one Opportunity;
- acquire the unique active allocation for a Lot;
- convert a Hold into a Reservation without an externally visible availability gap;
- approve an Order and create its Invoice/installment plan;
- settle a Payment, allocate it, append ledger entries, audit, and emit `PaymentSettled`;
- approve or settle a Refund without exceeding the eligible payment amount;
- withdraw Consent and enqueue suppression propagation.

## Tenancy and authorization

`organization_id` is the primary tenant boundary. Operational records also carry `business_unit_id`. Organisation-mastered parties such as Contacts and Accounts are visible to a business unit only through explicit relationship rows.

Every command and query receives an authenticated actor context containing organization, permitted business-unit scopes, membership, capabilities, and correlation/request IDs. Authorization is enforced in domain services before mutation. Composite foreign keys prevent cross-tenant references. PostgreSQL row-level security is mandatory defence-in-depth for production tenant-owned tables, subject to D-19 approval and evidence for application/migration/reporting/support/break-glass roles, transaction-local tenant context, pool reset, bypass controls and policy tests. It is not a replacement for application authorization and is not yet implemented in the foundation migration.

No request may choose an arbitrary tenant merely by sending an ID. Tenant context comes from the authenticated session or narrow service credential and is checked against every target resource.

## Concurrency and idempotency

Mutable aggregates carry a monotonically increasing `version`. APIs require the expected version or ETag for stale-write-sensitive commands. The update uses `WHERE id = :id AND version = :expected`; zero updated rows returns `409 Conflict` with safe current-state metadata.

Unique constraints and transactional locks enforce invariants that optimistic concurrency alone cannot protect:

- one provider lead ID per business unit/provider;
- one accepted webhook event per provider event/deduplication key;
- one logical command result per actor/command/idempotency key;
- one active allocation across Hold and Reservation for a Lot;
- one Opportunity per converted Lead;
- one business-document number in its business-unit scope;
- allocations and active refunds not exceeding the settled Payment amount.

Transport delivery is at least once. Business effects are exactly once through idempotency records, aggregate constraints, and deterministic event IDs.

The current Lead-create slice establishes the minimum replay-evidence pattern for production commands. The persisted response snapshot contains only server-owned IDs, stage, version and timestamps. Caller PII/input is reconstructed only after the canonical request HMAC matches using timing-safe comparison. A timing-safe 32-byte HMAC-SHA256 response MAC, keyed by `AUTH_HASH_KEY`, binds the complete tenant/actor/command/key/request/result/status/code/snapshot decision envelope before replay parsing or hydration.

Database guards make the acquisition envelope immutable, allow expiry only to move later, freeze completed/failed terminal decisions, block deletion while a row is live, permit governed purge after expiry, and reject `TRUNCATE`. The current 24-hour retention uses an unversioned `AUTH_HASH_KEY`; production therefore requires an approved versioned/dual-key verification design or a deliberately drained retention window for rotation. This operational key-rotation decision remains open and must not be inferred from local replay tests.

## Integration inbox and outbox

Provider endpoints perform only the minimum synchronous work:

1. apply endpoint-specific size and rate limits;
2. verify signature/token, timestamp freshness, replay rules, and connection scope;
3. derive a provider event ID or approved deterministic deduplication key;
4. persist the sanitized/protected payload and inbox row;
5. acknowledge only after commit.

Workers claim inbox rows with bounded concurrency and `SKIP LOCKED`, normalize the provider contract, execute domain commands, and record processed, retryable, quarantined, or dead-letter outcomes.

Domain transactions insert outbox rows. The dispatcher publishes them with the same event ID until delivery is confirmed. Consumers must record their own idempotency boundary before applying effects.

## Data and file storage

- PostgreSQL stores transactional relational state, append-only histories, idempotency, inbox/outbox, and audit evidence.
- Redis stores only reconstructable or expiry-bound state.
- Private object storage stores attachments, exports, and large protected provider payloads; database rows store ownership, checksum, scan state, classification, and object key.
- Secret manager/KMS stores provider and infrastructure credentials; integration rows store an opaque credential reference only.
- Reporting begins on PostgreSQL with indexed queries and controlled projections. A read replica or analytical store is introduced only when measured load justifies it.

## Financial and audit integrity

Planned installments and actual payment transactions are separate. Payment allocation, refund, reversal, and ledger entries are additive; settled financial facts are not overwritten. Corrections use explicit reversal/adjustment commands.

Stage histories, consent decisions, finance ledger entries, and audit events are append-only. Ordinary application roles cannot update or delete them. Audit payloads must minimize personal data and may reference protected before/after snapshots rather than embedding them.

## Deployment and operations

All runtime roles use the same immutable release version. Database migrations run once as a controlled deployment job before compatible application traffic is enabled. A release must remain backward compatible during rolling deployment or use an approved maintenance/cutover window.

The current foundation runner registers only `0001_foundation.sql` at checksum `169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de`, rejects non-zero-padded/unregistered/changed files, uses an advisory lock with a 10-second lock timeout and five-minute statement timeout, and proves first apply, exact no-op replay and tampered-ledger failure. Application readiness also requires the exact expected ledger. These controls reduce local migration ambiguity but are not hosted deployment, rollback, HA/PITR or restore evidence.

The web/API role holds no unique state and can scale horizontally. Worker queues are separated by latency and risk. Scheduler singleton behavior is guaranteed through a durable lock. Readiness verifies required database/Redis/object-store dependencies for the role; liveness only verifies process health.

Every role emits structured, redacted logs, metrics, and traces with deployment version, organization/business-unit identifiers where safe, actor/service, correlation ID, operation, outcome, and duration.

## Extraction rule

A module is considered for extraction into a separate service only when at least one measured condition exists:

- sustained independent scaling need that cannot be handled by separate worker/runtime roles;
- a team needs an independent release cadence and can own its operations;
- a security or regulatory boundary requires independent isolation;
- a provider workload threatens the latency/reliability objectives of the core API; or
- PostgreSQL contention/availability analysis proves a separate data boundary is beneficial.

Extraction requires a separate ADR defining ownership, API/event contracts, migration, observability, failure semantics, and consistency trade-offs. Convenience or code size alone is not sufficient.

## Alternatives considered

### Keep the existing file-backed Node process

Rejected. It cannot provide safe concurrent writes, horizontal scale, durable sessions/jobs, relational constraints, private file authorization, reliable migrations, or production-grade recovery.

### Immediate microservices

Rejected for the foundation. It would move unresolved domain and data-consistency questions into distributed systems and materially increase deployment, security, tracing, incident, and test complexity.

### Serverless functions plus independent managed stores

Not selected as the primary architecture. Stateless execution is useful, but unconstrained function boundaries would fragment transaction ownership. The modular monolith may run on serverless/container infrastructure if connection management, background work, latency, and migration controls meet the same contracts.

### One database per business unit

Rejected for initial GA. It complicates organisation-mastered contact identity, management reporting, migrations, operations, and future business-unit onboarding. Tenant columns, composite constraints, authorization, and RLS-ready design provide the initial isolation boundary. Dedicated databases may be reconsidered for regulatory or very large tenants.

## Consequences

### Positive

- One transaction can protect the highest-risk sales, inventory, finance, consent, audit, and integration invariants.
- Module ownership is explicit without premature distributed-systems overhead.
- Web/API nodes and workers can scale independently.
- PostgreSQL constraints replace browser conventions and best-effort dedupe.
- Inbox/outbox and idempotency make provider retries and outages observable and recoverable.
- A future service extraction path exists without designing for it prematurely.

### Costs and trade-offs

- The team must actively enforce module boundaries in code review and tests.
- A shared database can become coupled if modules bypass their services.
- Schema migrations require cross-module coordination and backward compatibility.
- PostgreSQL is a critical dependency and needs managed availability, PITR, capacity monitoring, and restore drills.
- RLS increases defence but also test/operations complexity; rollout must be deliberate.

## Guardrails and acceptance criteria

This decision is implemented when:

- module ownership and dependency rules are represented in the repository;
- APIs expose resource/command operations rather than whole-state replacement;
- mutable aggregates use optimistic versions;
- tenant-consistent composite foreign keys and required uniqueness constraints exist;
- Lot allocation, Payment allocation/refund, webhook, and idempotency invariants have concurrent integration tests;
- each successful consequential command writes audit and outbox evidence in the same transaction;
- inbox/outbox workers can be stopped, restarted, and replayed without duplicate business effects;
- web/API nodes can run more than one instance without local state;
- backup/PITR and an isolated restore drill meet the approved RPO/RTO; and
- ordinary application roles cannot mutate append-only consent, stage-history, finance-ledger, or audit rows.

## Follow-up decisions

Separate ADRs are required for:

1. ADR-002 managed identity provider, session, MFA and emergency-access approval (`D-14` remains open);
2. RLS/application database roles and tenant-context propagation;
3. queue/dispatcher implementation and dead-letter operations;
4. private object storage, malware scanning, and file retention;
5. finance ledger/accounting export boundary;
6. encryption, secret references, and key rotation;
7. deployment topology and zero/low-downtime migration policy; and
8. data migration/cutover from all discovered legacy states.
