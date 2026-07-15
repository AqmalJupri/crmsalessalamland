# CRM Salam Fortress V2 — Canonical Data Model

- **Status:** Draft canonical foundation; implementation and production gates remain incomplete
- **Database:** PostgreSQL 16+ proposed compatibility floor; production version remains open under `D-13`
- **Foundation migration:** `db/migrations/0001_foundation.sql`
- **Local PostgreSQL evidence:** source has 46 `CREATE TABLE`, 66 explicit `CREATE [UNIQUE] INDEX`, 50 total trigger declarations (46 ordinary plus 4 constraint triggers), and 8 `crm_*` function declarations. A clean first apply and second no-op pass on PostgreSQL 16.14; the fresh catalog has 47 public base tables including `schema_migrations`, 182 catalog indexes, 50 non-internal trigger rows (64 `information_schema` event rows), 8 `crm_*` functions, and one migration-ledger row. The ledger/source/manifest checksum is `169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de`; 57 PostgreSQL/API integration tests pass across 5 files
- **Architecture decision:** `docs/architecture/ADR-001-MODULAR-MONOLITH.md`

## 1. Purpose

This model is the canonical transactional foundation for multi-business-unit CRM operations. It separates customer identity, enquiries, commercial pipeline, inventory allocation, orders, planned receivables, actual cash movement, provider delivery, and audit evidence so that each concept has one meaning and one authoritative timestamp.

The model is designed for:

- strict organization and business-unit isolation;
- named users, memberships, roles, and capabilities;
- repeat enquiries without destructive contact deduplication;
- concurrent lot holding/reservation without double booking;
- fixed-precision finance with additive allocations/refunds/ledger entries;
- durable webhook acceptance, idempotent commands, and transactional outbox delivery;
- optimistic concurrency for mutable aggregates;
- append-only histories for consequential evidence; and
- later PostgreSQL row-level security without changing entity ownership.

## 2. Conventions

### 2.1 Keys and tenant ownership

- Primary keys are UUIDs generated with `gen_random_uuid()`.
- `organization_id` is the tenant boundary on every tenant-owned row.
- Operational rows also carry a non-null `business_unit_id`.
- Organisation-mastered Contacts and Accounts do not belong to a single business unit. Explicit `contact_business_units` and `account_business_units` relationships grant operational visibility.
- Composite foreign keys repeat the tenant columns. A valid UUID from another tenant is still an invalid relationship.
- IDs exposed by APIs are opaque. Human-facing document numbers have separate business-unit-scoped uniqueness.

### 2.2 Time

- All event timestamps are `timestamptz` and stored in UTC.
- Mutable rows have `created_at`, `updated_at`, and `version`.
- Domain-specific times are distinct: provider occurrence, receipt, ingestion, assignment, stage transition, due, settlement, release, and publication are never collapsed into one generic date.
- Business dates such as `due_date` and `expected_close_date` are PostgreSQL `date` values interpreted using the business unit's configured timezone.

### 2.3 Optimistic concurrency

Mutable aggregate roots begin with `version = 1`. The database update trigger increments the version and owns `updated_at`. API commands must use a compare-and-swap predicate:

```sql
UPDATE leads
SET owner_membership_id = :owner_membership_id
WHERE organization_id = :organization_id
  AND business_unit_id = :business_unit_id
  AND id = :lead_id
  AND version = :expected_version;
```

Zero affected rows is a conflict, not a successful no-op. A command that can return a no-op must first lock the aggregate row and compare the expected version; otherwise a concurrent committed change could be incorrectly acknowledged as unchanged. Append-only event/history tables do not have mutable versions.

### 2.4 Money and quantities

- Money uses `numeric(19,4)` plus an uppercase ISO 4217 `char(3)` currency.
- Amounts are never binary floating point.
- `numeric(19,6)` is used for item quantity where fractional units may be legitimate.
- Display rounding does not change ledger values.
- Order and invoice totals have database arithmetic checks; application services calculate them from permitted inputs before insert/update.

### 2.5 Lifecycle and deletion

- Business lifecycles use explicit status values and transition commands.
- Mutable commercial facts are not physically deleted by ordinary application roles.
- Retention/anonymisation is a separate governed operation with legal-hold checks and audit evidence.
- Authentication attempts, stage histories, consents, payment allocations, finance ledger entries, and audit events are append-only and protected by statement-level triggers that reject `UPDATE`, `DELETE`, and `TRUNCATE`.

### 2.6 Extensibility

- Stable relational facts use typed columns and constraints.
- `metadata jsonb` is permitted only for provider/legacy attributes that are not yet canonical business invariants.
- A value required for authorization, uniqueness, money, workflow transition, reporting definition, or retention must not live only in JSON.

## 3. Tenant, identity, and access

### 3.1 `organizations`

Top-level tenant/controller. Stores organization code, name, default timezone/currency, lifecycle status, and optimistic version.

### 3.2 `business_units`

Operational tenant partition within an Organization. Initial examples are Salam Land, Bumi Hayat Printing, and Barakah Emas. Business-unit code is unique within the Organization.

### 3.3 `users`

Global named human/service identity. Authentication is delegated to an approved identity provider through `auth_subject`; this foundation does not store passwords. Interactive OIDC/CRM sessions require an active `HUMAN` User; narrow service identities use separate non-browser credentials and scopes. A User gains no tenant access merely by existing.

### 3.4 `memberships`

Effective-dated User access to an Organization or one Business Unit. Organization-wide and business-unit memberships are unique separately. Suspension/expiry is represented explicitly. For the selected Business Unit, actor provenance is deterministic: prefer an effective Business-Unit Membership, otherwise use an effective Organization-wide Membership, with stable ID ordering as the tie-breaker.

### 3.5 `capabilities`, `roles`, `role_capabilities`, `membership_roles`

Capabilities use stable singular-resource action keys such as `lead.read`, `lead.assign`, `order.approve`, or `payment.refund`. Roles are Organization-owned bundles. Membership-role links grant bundles to a Membership. The implemented Lead-transition boundary accepts only explicit `constraints.recordScope` values `OWN` and elevated `BUSINESS_UNIT`; an empty, malformed, or unsupported value grants no record scope. Team, queue, amount, state, legal-hold, and other contextual policies remain target work and must also fail closed until implemented.

### 3.6 `teams`, `team_memberships`

Business-unit teams used for assignment, queue scope, and management views. Team membership is not a substitute for a valid User membership in the same Organization and Business Unit.

### 3.7 `sessions`

Server-managed authentication session metadata. PostgreSQL stores a one-way digest of the high-entropy random session token, never the bearer token itself, together with User, Organization, active Business Unit, assurance level, issue/last-seen/expiry times, status/revocation reason and approved network/device hashes. Membership is not copied into the row: each HTTP request re-evaluates current User, Organization, Business Unit, Membership, Role and effective-date state, then resolves the deterministic active Membership described above. React request-scoped caching deduplicates repeated layout/page reads only inside that render; separate requests and direct route calls remain fresh, so suspension is visible on the next request.

### 3.8 `auth_login_attempts`

Append-only CRM authentication evidence for successful and denied access decisions after the provider subject has been resolved. It stores a keyed attempted-subject/identifier hash rather than the submitted value, optional resolved User and Organization, outcome/failure code, correlation ID, approved network/device hashes and occurrence time. It is not a generic OIDC protocol log: missing, expired, tampered and otherwise anonymous callback failures create no row, so attacker-controlled public noise cannot grow this immutable table. Those failures and issuer/provider health belong in bounded, redacted edge/provider operational telemetry and rate limiting; neither operational control is complete in the current application. The table has no IdP/provider column unless a later approved migration adds a typed provider reference.

## 4. Parties, identities, and consent

### 4.1 `contacts`

Organisation-mastered natural person. A Contact may legitimately have many Leads, Opportunities, Orders, Accounts, and identities. `status = POSSIBLE_DUPLICATE` starts a review; it does not hide or merge data automatically.

### 4.2 `accounts`

Organisation-mastered business/institution/household customer. The foundation stores business accounts; additional household and party-role detail can be added without changing Lead/Order ownership.

### 4.3 `contact_business_units`, `account_business_units`

Effective business-unit relationship and purpose. These rows are the ordinary visibility bridge from organization-mastered party data into a business unit. Matching a phone/email in another business unit must not create this relationship or reveal the other unit automatically.

The current Lead-create transaction serializes contact identity reuse with an Organization + keyed-phone advisory lock, locks an existing Contact–Business Unit relationship, performs an active-only relationship upsert, and rechecks the returned Contact and status. If restriction wins the race, creation fails closed with `CONTACT_RELATIONSHIP_AUTHORIZATION_CHANGED`; it does not reactivate the relationship or attach a new Lead to the restricted Contact. The concurrent restriction fixture proves the waiting create instead follows the separate possible-duplicate path without mutating the restricted relationship.

### 4.4 `contact_identifiers`

Typed identity such as phone, email, provider identity, or approved protected national identifier. It stores:

- normalized value when permitted for operational use;
- keyed/approved hash for matching;
- verification state and timestamps;
- source and primary marker; and
- optional protected-value reference for high-sensitivity values.

The identity hash is indexed but deliberately not globally unique. Shared household numbers and legitimate duplicate records must enter possible-match review rather than fail or merge silently. The same identity cannot be duplicated twice on the same Contact.

### 4.5 `consents`

Append-only evidence of `GRANTED`, `WITHDRAWN`, `DENIED`, or `UNKNOWN` for a Contact, channel, purpose, controller/Organization, and optional Business Unit. It records legal basis, notice version, evidence reference, source, actor, occurrence time, and optional predecessor.

Current preference is a projection of the newest valid decision in the applicable scope. Withdrawal propagation is an asynchronous, idempotent domain process; the immutable consent row is the source evidence.

## 5. Pipeline, stages, leads, tasks, and activities

### 5.1 `pipelines`, `pipeline_stages`, `pipeline_stage_transitions`

Pipelines are configured per Business Unit and entity type (`LEAD` or `OPPORTUNITY`). Stages are ordered, coded, effective, and categorized as open/terminal outcomes. Historical rows reference stable stage IDs so renaming a stage does not rewrite history.

`pipeline_stage_transitions` is the versioned server-owned edge list for one Pipeline. Each active from/to edge may require a reason and capability. Composite foreign keys prevent cross-tenant/cross-pipeline edges, a unique constraint prevents duplicate edges, and commands reject absent/disabled edges. Leaving any terminal stage additionally requires `lead.reopen` and an explicit reason, even if the configured edge does not request one. Configuration changes are audited and cannot rewrite historical transitions.

### 5.2 `leads`

A Lead is one enquiry/journey, not the customer identity. Required lineage includes Contact, Business Unit, pipeline/stage, capture/source times, provider/source, optional external lead ID, owner, assignment state, attribution fields, and optimistic version. `received_at` is assigned at the server service boundary; it is not accepted from a Lead-create caller. `source_provider` is a lowercase canonical key and is protected by both application normalization and a database format check. Lead-create input is stream-capped at 32,768 UTF-8 bytes; attribution accepts JSON-only values within depth 3, 32 keys per object, 64 total keys, 64-code-point keys, 1,024-code-point strings, 20 array items and 128 total nodes before persistence.

A Lead does **not** own a monetary value. Commercial expected amount, currency, probability, and expected-close semantics begin on Opportunity. Lead UI/API/schema work must not reintroduce `value`, `estimated_value`, or another monetary proxy.

Important constraints:

- one non-null external lead ID per Business Unit/provider;
- tenant-consistent Contact, Account, Pipeline, Stage, and owner references;
- received/ingested time cannot precede provider occurrence when all are known;
- an assigned Lead has all three of `owner_membership_id`, `assigned_by_membership_id`, and `assigned_at`, while an unassigned Lead has none;
- conversion is represented by the unique Opportunity link, not by changing the Contact.

Only PostgreSQL error code `23505` for constraint `leads_provider_external_unique` is mapped to the safe `DUPLICATE_EXTERNAL_LEAD` API conflict. Cause traversal is bounded, cycle-safe, and supports wrapped driver/ORM errors; unrelated or malformed database errors remain sanitized `500` responses.

The current create/transition services additionally require an owner to be an effective active Membership joined to an active `HUMAN` User at command time. Transition requires the current Lead owner to match an effective actor Membership under `OWN`, unless a role grants explicit `BUSINESS_UNIT` scope. The assigner is the deterministic actor Membership, reassignment or unassignment requires a reason, and a stage-only command that repeats the same owner preserves the original assignment provenance. The `duplicate_fingerprint` is a search/review aid, not a uniqueness boundary.

### 5.3 `lead_stage_history`

Append-only transition fact containing from/to stage, actor, source, reason, occurred time, and correlation ID. `UPDATE`, `DELETE`, and `TRUNCATE` are blocked. The Lead's current stage is a projection optimized for commands/queries; history remains the audit-grade sequence. Assignment changes do not masquerade as stage history: they emit separate PII-free assignment audit/outbox evidence, and a combined command emits distinct stage and assignment facts.

### 5.4 `opportunities`

Qualified commercial journey and the sole owner of expected commercial amount. A Lead converts to at most one Opportunity. Contact/account lineage and original Lead attribution remain intact. Expected amount/currency, probability, close date, won/lost timestamps, current stage, and optimistic version are explicit.

### 5.5 `opportunity_stage_history`

Append-only Opportunity transition history with the same causality model as Lead history.

### 5.6 `tasks`

Actionable next work tied to exactly one Contact, Lead, or Opportunity in the foundation. A Task has assigned user/team, priority, due time, status, completion metadata, reminder time, and version.

### 5.7 `activities`, `activity_links`

An Activity is a timestamped interaction or internal event (call, note, meeting, message summary, status action). Links associate one Activity with one or more Contact, Account, Lead, Opportunity, Order, or Task records while preserving tenant consistency. Large/raw message payloads belong in the Conversations/Files modules, not the activity body.

## 6. Salam Land inventory allocation

### 6.1 `land_projects`, `lots`

A Lot belongs to a land project and Business Unit. Its operational status is `ACTIVE`, `BLOCKED`, `WITHDRAWN`, or `SOLD`. `AVAILABLE` is derived: the Lot is active and has no unreleased allocation.

`lot_number` is unique within a project. Price and currency are explicit. Mutable lot details use optimistic concurrency.

### 6.2 `lot_allocations`

Database serialization point shared by Holds and Reservations. A partial unique index allows only one row with `released_at IS NULL` for a Lot, regardless of allocation type. The database also rejects a new active allocation unless the Lot is operationally active.

### 6.3 `lot_holds`

Short-lived provisional allocation linked one-to-one to a `HOLD` allocation. It records Contact/Opportunity, expiry, status, actor, release/convert metadata, and version. Expiry is performed by a scheduler command that locks and rechecks the row.

### 6.4 `reservations`

Commercial reservation linked one-to-one to a `RESERVATION` allocation, Contact, Opportunity, and optionally its originating Hold. Pending/confirmed reservations retain the allocation; cancelled/converted reservations release it through the same transaction that records the next business state.

### 6.5 Hold-to-reservation transaction

The command must lock the Hold, allocation, and Lot, then:

1. validate expiry, opportunity/contact, permission, documents/deposit/approval policy;
2. mark the Hold converted and release its allocation;
3. insert the Reservation allocation (protected by the active-allocation unique index);
4. insert the Reservation;
5. append audit and outbox rows; and
6. commit.

No other transaction can acquire the Lot between steps because the Lot row remains locked until commit.

## 7. Orders and finance

### 7.1 `orders`, `order_items`

Order is the approved commercial obligation. It requires a Contact and either an Opportunity or an approved direct-sale reason. An optional Lot Reservation links Salam Land sales. Business document number is unique within the Business Unit.

Items carry quantity, unit price, discount, tax, and line total. Order subtotal/tax/discount/total are fixed precision and database-checked. Server services own calculations and transitions.

### 7.2 `invoices`

Issued receivable for an Order. Invoice number is unique within the Business Unit. Issue/due date, subtotal/tax/discount/total, status, and void metadata are independent from Order creation.

### 7.3 `installments`

Planned due items under an Invoice. Schedule sequence is unique per Invoice. `Scheduled`, `Due`, `Partially Paid`, `Paid`, `Waived`, and `Cancelled` are projections maintained by finance commands from dates, valid adjustments, and allocations.

### 7.4 `payments`

Actual incoming payment transaction. It contains payer, amount/currency, method, external reference, idempotency key, received/settled timestamps, status, and version. Retrying the same payment command or provider reference must reuse the existing transaction.

### 7.5 `payment_allocations`

Append-only allocation of a positive amount from one Payment to one Installment. A deferred constraint trigger verifies:

- Payment, Installment, Invoice, and allocation share tenant and currency;
- only a settled Payment can be allocated; and
- total non-reversed allocation does not exceed the Payment amount.

Unallocated payment value remains explicit as unapplied credit.

### 7.6 `refunds`

Refund lifecycle is separate from Payment. Requested/approved/processing/settled values are additive; the original Payment is not reduced. `APPROVED`, `PROCESSING`, and `SETTLED` require both a non-null requester and a distinct non-null approver. A deferred constraint trigger prevents active/settled refund total from exceeding the settled Payment amount and rejects refunding an ineligible payment.

### 7.7 `finance_ledger_entries`

Append-only signed financial facts for charges, payment receipts, allocations, refunds, reversals, waivers, and adjustments. Each entry has a stable source reference and correlation ID. The ledger is the reconciliation evidence; document status fields are convenient projections.

## 8. Integration reliability and audit

### 8.1 `integration_connections`

Business-unit/provider connection metadata, status, external account reference, and opaque credential reference. Credential values are never stored here.

### 8.2 `webhook_inbox`

Durable provider-event boundary. It stores verification result, event/deduplication IDs, protected/sanitized payload, checksum, processing state, attempt count, retry time, and outcome. Partial unique indexes protect both provider event IDs and deterministic dedupe keys.

Workers claim due rows using `FOR UPDATE SKIP LOCKED`. Invalid signatures never create an accepted inbox row; rejected-request telemetry is kept separately without raw sensitive bodies.

### 8.3 `idempotency_keys`

Logical command boundary scoped by Organization, optional Business Unit, actor scope, command name, and client key. The request HMAC covers canonical command input and detects key reuse with different input. A completed Lead-create row stores only a minimal server-owned replay snapshot: Lead, Contact, Pipeline and Stage IDs; stage; version; and receipt/creation timestamps. A completed Lead-transition row stores only Lead/stage/owner IDs, version, update time, and whether the command changed state. Caller input and PII such as name, phone, source, product interest, and reason are not copied into either snapshot; replay begins only after a timing-safe request-HMAC match.

The completed decision also stores a 32-byte HMAC-SHA256 response MAC keyed by `AUTH_HASH_KEY`. The MAC covers the full canonical decision envelope: Organization, Business Unit, actor scope and actor User, command, idempotency key, request hash, status, result entity type/ID, response code, and replay snapshot. The service verifies it timing-safely before parsing or hydrating a replay and fails closed on missing, malformed, or changed evidence.

The acquisition envelope is immutable. Expiry is monotonic and may only be extended. A `COMPLETED` or `FAILED` terminal decision is immutable. Row deletion is blocked while unexpired and allowed only after expiry; `TRUNCATE` is always blocked. Database constraints keep `IN_PROGRESS`, `COMPLETED`, and `FAILED` combinations consistent.

Current acquisition retention is 24 hours. Because request and response MACs use `AUTH_HASH_KEY` without an on-row key version, an immediate key replacement can make an unexpired replay unverifiable. Production operations must approve a rotation runbook—for example versioned/dual verification keys or a drained retention window—with owner, monitoring, rollback, and purge evidence before rotation is exercised.

### 8.4 `outbox_events`

Transactional domain event. It includes event type/version, aggregate type/ID/version, actor/service, correlation/causation, occurred/available timestamps, protected payload, and dispatch state. Publication can retry with the same event ID.

### 8.5 `audit_events`

Append-only security/business audit fact: actor/service, action, target, request/correlation, reason, network/device context where approved, outcome, and minimized change metadata or protected snapshot references. Optional previous/event hashes permit later tamper-evidence chaining.

## 9. Constraint and index strategy

The foundation migration provides:

- composite tenant foreign keys for cross-table ownership;
- partial unique indexes for nullable external IDs/idempotency keys and active Lot allocation;
- queue indexes for inbox/outbox due work;
- contact identity hash and provider lead lookup indexes;
- configured Pipeline stage-edge uniqueness and active from-stage lookup;
- owner/stage/due-time indexes for CRM work queues;
- order/invoice/payment lookup and finance due/reconciliation indexes;
- statement-level append-only `UPDATE`/`DELETE`/`TRUNCATE` guards;
- deferred allocation/refund aggregate checks; and
- `updated_at`/version triggers for mutable rows.

Search indexes over names, phone/email suffixes, or full text are intentionally deferred until normalization, sensitivity, access, and query plans are approved. Broad GIN indexing of personal-data JSON is prohibited by default.

## 10. RLS readiness

The migration does not enable incomplete generic RLS policies. Before RLS is enabled, ADR approval must define:

- application, migration, worker, reporting, support, and break-glass database roles;
- transaction-local tenant context propagation;
- organization-wide versus business-unit membership semantics;
- explicit party relationship visibility;
- service-worker/integration scopes;
- background maintenance and retention bypass controls;
- connection-pool reset guarantees; and
- policy tests for read, insert, update, delete, joins, exports, and prepared statements.

All tenant tables already contain the required ownership columns and indexes, so policies can be added without remodeling entities. Until then, every repository query requires explicit organization/business-unit predicates and policy tests at the service layer.

## 11. Transaction recipes

### Verified webhook to Lead

1. Gateway verifies request and begins transaction.
2. Insert accepted `webhook_inbox`; duplicate constraint returns the existing outcome.
3. Commit and acknowledge.
4. Worker locks inbox row, resolves provider mapping and Contact identity.
5. In one transaction create/reuse Contact relationship, create Lead, append audit, insert outbox, mark inbox processed.
6. Assignment/notification workers consume events idempotently.

### Lead conversion

1. Lock Lead and compare version.
2. Validate stage/required fields/permissions.
3. Insert Opportunity using unique `lead_id`.
4. Transition Lead to converted and append stage history.
5. Insert audit and `LeadConverted` outbox event.

### Payment settlement/allocation

1. Claim idempotency key and lock Payment.
2. Validate provider result/evidence and transition to settled.
3. Insert allocations and ledger entries.
4. Deferred constraint checks total allocations/currency.
5. Update installment/invoice projections.
6. Insert audit and outbox rows; commit idempotency result.

### Refund settlement

1. Lock Payment and Refund; enforce maker-checker policy outside requester context.
2. Validate eligible amount and idempotency.
3. Transition Refund and append negative/refund ledger entry.
4. Deferred constraint checks total eligible refunds.
5. Recalculate projections, audit, and emit `RefundSettled`.

## 12. Migration and reconciliation notes

### 12.1 Foundation migration runner

The runner admits only the registered `0001_foundation.sql`. Discovery requires `NNNN_lowercase_words.sql`; non-zero-padded, duplicate-version, missing, or unregistered files fail before apply. The manifest checksum is exactly `169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de`, matching the source and fresh ledger.

Application connects with a 10-second connect timeout. Migration execution takes a named PostgreSQL advisory lock, sets `lock_timeout = '10s'` and `statement_timeout = '5min'`, applies a new migration and ledger record transactionally, treats an exact existing checksum as a no-op, and rejects ledger/source tampering. The focused runner test covers first apply, replay no-op, and tampered-checksum failure. Readiness is migration-aware: valid configuration and database connectivity are insufficient unless the exact expected ledger is present.

These controls harden migration execution; they do not prove rollback compatibility, hosted deployment, production PostgreSQL support policy, HA/failover, PITR, or restore.

### 12.2 Legacy migration and reconciliation

Legacy import must not write directly through ad-hoc SQL. A repeatable importer must preserve source checksum, source record ID, raw legacy status, source/provider times, transformation version, quarantine reason, and deterministic target IDs.

Required reconciliation includes:

- counts by entity, Business Unit, provider, source month, owner, and mapped status;
- duplicate/external-ID and identity-match review;
- Lead → Opportunity → Order lineage;
- Lot active-allocation uniqueness;
- Order/invoice/installment/payment/allocation/refund totals;
- attachment ownership/checksum/private state; and
- webhook cutover proving old and new systems cannot both ingest or send.

No historical snapshot is canonical merely because it is newest or largest.

## 13. Foundation scope and deferred modules

`0001_foundation.sql` creates the cross-cutting and highest-risk transactional core requested for the first production foundation. Later migrations will add:

- branches, products/catalog/quotes and business document sequences;
- printing job/work-order/artwork/delivery detail;
- gold rates, price approvals, stock items and inventory movements;
- conversations/messages/templates/notifications;
- attachments, malware scan, retention and legal holds;
- campaigns/ad groups/ads/attribution/spend snapshots;
- privacy requests and retention jobs;
- custom fields/configuration/automation; and
- reporting projections/materialized views.

Those modules must use the same tenant, version, money, inbox/outbox, audit, and append-only conventions.
