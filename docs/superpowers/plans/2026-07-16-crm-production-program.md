# Unified CRM Production Program Execution Map

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver PRD 1.8 as one production CRM authority, one shared modular API, one canonical PostgreSQL database, and two purpose-built product surfaces for all three business units.

**Architecture:** Keep the current modular monolith and transactional PostgreSQL boundary. Build independently reviewable vertical slices around server-authoritative commands, durable import/integration evidence, explicit tenant and business-unit scope, and two deployment-configured UI surfaces. Production promotion remains gated by source reconciliation, security, recovery, performance, accessibility, and named business approval.

**Tech Stack:** Node.js 22.22.0, pnpm 11.9.0, Next.js 16.2.10, React 19.2.7, TypeScript 6.0.3, PostgreSQL 16.14, Drizzle ORM 0.45.2, Zod 4.4.3, Vitest 4.1.10, Playwright 1.61.1, GitHub Actions, and a dedicated isolated Hostinger production stack.

## Global Constraints

- The binding product baseline is [CRM Production PRD 1.8](../../CRM_PRODUCTION_PRD_V2_2026-07-15.md) plus [ADR-003](../../architecture/ADR-003-UNIFIED-PRODUCTION-BOUNDARY.md).
- `crm.salamland.my` serves marketing, sales, management, and all three business units. `tasha.salamland.my` serves Salam Land sales administration. Both surfaces use the same API, policy engine, identity, and canonical records.
- Salam Land, Bumi Hayat Printing, and Barakah Emas switch production authority together in one approved cutover window. Internal development and UAT may proceed in slices.
- The existing multipurpose VPS is a transition host only. It must not become the final production failure boundary.
- No real customer data, raw provider token, credential, source extract, database copy, spreadsheet, or unsafe archive enters Git or CI artifacts.
- Every feature and defect fix follows red-green-refactor. Every task ends with the narrowest relevant test, then the owning plan's aggregate gate.
- Every completed task has an intentional Git commit. Every completed round is pushed to the remote checkpoint branch after fresh verification; Git checkpoints never contain live data, extracts, credentials, or backup payloads.
- Database changes are forward-only, checksum-registered, replay-safe, and applied through the migration runner. No direct production database edit is an implementation step.
- UI scope never replaces server authorization. Hidden navigation is not access control.
- Financial, lot-allocation, consent, identity merge, import approval, and cutover decisions remain server-authoritative and auditable.
- A completed engineering task does not change PRD Gate A, B, C, or D until its named evidence and approval exist.

---

## 1. Baseline and release truth

The executable baseline is branch `codex/production-foundation` at or after commit `732b80eebec22dfffa4f1555d7565229a52d53c7`. The baseline already provides:

- a checksum-locked `0001_foundation.sql` migration and migration-aware readiness;
- managed-OIDC start/callback and server-side session foundations;
- capability-gated page/API boundaries;
- tested Lead create/transition slices and selected database/domain invariants;
- a responsive demo shell and CI quality workflow.

It does not yet provide production infrastructure, RLS, a migration/import control plane, live read models for most modules, the Tasha-specific surface, durable queue workers, private object storage, telemetry, PITR/restore evidence, complete business workflows, or migration/UAT/cutover evidence.

## 2. Sub-project boundaries

| Order | Sub-project | Authority created | Entry gate | Exit evidence |
|---:|---|---|---|---|
| 1A | UI and product-surface foundation | Exact theme/copy/state/metadata/PWA contract for both hosts | PRD 1.8 approved | UI unit, metadata/header, accessibility, responsive, and safe-offline tests pass |
| 1B | Migration control plane | Registered sources, immutable snapshots, staging, quarantine, lineage, reconciliation, and authority state | PRD 1.8 approved | Fresh/replay/tamper, quarantine, lineage, reconciliation, and authority-guard tests pass |
| 1C | Platform packaging and environment contract | Reproducible artifact, separate runtime identities, deploy/rollback/backup hooks | Dedicated production topology and operational owner recorded | Staging deploy/rollback, secret-safe config, observability, backup, and isolated restore evidence pass |
| 2A | Identity, tenant policy, and RLS | Named identity, secure sessions, explicit business-unit scope, database enforcement | Migration control plane, IdP decision, and signed `D-19` role/context/pool-reset/bypass design | Cross-BU negative matrix, session lifecycle, step-up, RLS tests, and Security/Architecture conformance approval pass |
| 2B | Contact, consent, and identity review | Canonical party records and governed possible-match/merge | Identity policy and signed identity rules | Duplicate/repeat/household/cross-BU/consent fixtures pass |
| 3 | Lead, opportunity, assignment, and tasks | Complete core seller lifecycle | Party foundation and signed stage/SLA rules | Atomic assignment, lifecycle, conflict, conversion, SLA, mobile journeys pass |
| 4A | Orders and finance | Canonical order, installment, payment, allocation, refund, reversal, ledger | Core CRM and signed Finance rules | Exact reconciliation, concurrency, idempotency, maker-checker, restatement tests pass |
| 4B | Salam Land administration | Lots, holds, reservations, agreements, collections, documents through Tasha | Orders/finance and signed lot rules | Allocation-race, expiry/payment, reversal, document and Tasha UAT pass |
| 4C | Bumi Hayat Printing | Versioned quote/specification, production job, QC/rework, delivery | Shared orders/files and signed printing rules | Quote-change, approval, QC/rework, delivery and Niagawan reconciliation pass |
| 4D | Barakah Emas | Rate snapshot, gold transaction, inventory movement, buyback/exchange | Shared orders/finance and signed gold rules | Rate freshness, exact calculation, override, inventory and Sheet reconciliation pass |
| 5A | Integrations and conversations | Durable provider inbox/outbox, queues, DLQ, consent-aware WhatsApp | Async platform, provider ownership, signed messaging policy | Signature/replay/timeout/outage/DLQ/opt-out tests pass |
| 5B | Files and exports | Private upload, scan, authorised download, expiring safe export | Object-store boundary and privacy rules | Malicious-file, scope, expiry, formula-injection, and access-audit tests pass |
| 6 | Reporting, KPI, and observability | Signed metric definitions, reconciled views, alerts/runbooks | Stable domain events and KPI approvals | Dashboard/report/export parity and freshness/restatement tests pass |
| 7 | Rehearsal, DR, and simultaneous cutover | Canonical production authority | Gates A-C passed | Timed restore, full reconciliation, every UI × BU smoke path, rollback-forward, and Gate D approval pass |

Sub-projects do not share implementation files concurrently unless one plan explicitly owns the shared file. Shared-file changes are sequenced through reviewable commits before the dependent plan begins.

## 3. Round 1 — safe work that can start now

Round 1 contains two independent code streams:

1. [UI and Product-Surface Foundation Implementation Plan](./2026-07-16-ui-product-surface-foundation.md)
2. [Migration Control Plane Implementation Plan](./2026-07-16-migration-control-plane.md)

They can run in parallel because the UI plan owns product-surface/configuration/component files while the migration plan owns `0002`, import domain/services, and import tests. Shared-file boundaries are `src/server/env.ts`, `src/server/db/schema.ts`, `src/server/db/migration-manifest.ts`, `package.json`, `.env.example`, `.github/workflows/quality.yml`, `scripts/ci/run-next-runtime-smoke.mjs`, `tests/ci/runtime-process.test.ts`, `tests/ci/quality-workflow.test.ts`, `tests/production/runtime-smoke.mjs`, `vitest.config.ts`, and `vitest.production-coverage.config.ts`; only one worker may edit one of these at a time.

Shared-file merge order is mandatory:

1. UI Task 3 lands the deployment environment contract and first workflow update.
2. Migration Task 1 lands the reviewed migration manifest while non-shared UI/migration tasks continue independently.
3. UI Tasks 8-9 land the surface-aware runtime smoke, portable macOS/Linux process-group owner, Playwright/package scripts, and two-surface workflow lifecycle.
4. Migration Task 10 rebases, then appends only its read-only package scripts.
5. Migration Task 11 rebases last and owns the combined coverage/workflow/CI regression gate. It must preserve both surface builds/E2E runs and the full-process teardown. Both detailed aggregate suites rerun after this integration commit.

### Round 1 acceptance

- [ ] Every task in both detailed plans is checked off with a passing narrow test.
- [ ] `pnpm lint` passes with zero warnings.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test:coverage` passes the existing high-confidence thresholds.
- [ ] `pnpm test:coverage:production` passes the all-production-source floors.
- [ ] `pnpm build` passes with `CRM_DEMO_MODE=false` and coherent production-like configuration for each product surface.
- [ ] `pnpm test:db` passes against a disposable PostgreSQL 16.14 database after applying migrations twice.
- [ ] `pnpm test:e2e:crm`, `pnpm test:e2e:tasha`, and aggregate `pnpm test:e2e` pass in isolated surface processes at 320, 375, 390, 768, 1024, 1280, and 1440 widths.
- [ ] No real source data or credential is present in the diff, Git object set introduced by the round, logs, screenshots, or artifacts.
- [ ] An independent code review reports no unresolved Critical or Important finding.
- [ ] The round is committed and pushed only after verification evidence is fresh.

## 4. Round 2 — security and canonical party foundation

Round 2 begins only after Round 1 is merged and comprises separate plans for identity/RLS and party/consent.

Identity/RLS implementation is blocked until `D-19` is signed with the exact application/worker/migration/reporting/support/monitoring/backup/break-glass roles, transaction-local organisation/BU context, connection-pool set/reset behavior, ownership/bypass rules, and test matrix. Passing tests cannot substitute for this design approval, and the round cannot close without named Security and Architecture conformance sign-off.

- [ ] Add deployment-specific OIDC clients for CRM and Tasha while preserving one user identity and server session authority.
- [ ] Persist and enforce per-unit capability/record-scope maps. `Semua` includes only units granting the requested module capability and remains read-only at command validation; do not introduce a blanket cross-unit read grant.
- [ ] Add PostgreSQL runtime roles and transaction-local tenant/business-unit context.
- [ ] Enable and force RLS on tenant-owned tables, then prove cross-organisation and cross-BU denial with every application role.
- [ ] Add device/session list, rotation, idle/absolute expiry, logout-all, revocation, offboarding, MFA assurance, and step-up policies.
- [ ] Complete Contact, Account, household/joint-buyer, identifiers, relationships, consent, possible-match queue, reversible merge, and unmerge evidence.
- [ ] Exit only after the complete positive/negative role matrix passes at API and database layers.

## 5. Round 3 — core CRM vertical slice

- [ ] Replace demo/static production reads with cursor-paginated Contact, Lead, Opportunity, Task, and activity read models.
- [ ] Complete Lead create/detail/transition/qualify/disqualify/nurture/reopen and exactly-once conversion.
- [ ] Implement opportunity lifecycle, version conflict handling, assignment simulation, atomic round robin, owner lock, leave/capacity, and exception queue.
- [ ] Implement working-time SLA, follow-up tasks, reminders, escalation, and manager queue.
- [ ] Apply complete loading, empty, filtered-empty, stale, queued, partial, success, failed, conflict, offline, forbidden, and unknown states to both surfaces where applicable.
- [ ] Exit after seller and manager journeys pass with real PostgreSQL data, mobile/keyboard/screen-reader coverage, concurrent workers, and retry fixtures.

## 6. Round 4 — transactional business modules

Round 4 has four independently owned plans after shared order/finance contracts stabilize.

- [ ] Orders/Finance: versioned orders, installments, payments, allocations, credits, refunds, reversals, ledger, daily reconciliation, close/restatement, and maker-checker.
- [ ] Salam Land/Tasha: projects, lots, holds, reservations, agreements, collections, documents, concurrent allocation, expiry, reversal, and focused admin navigation.
- [ ] Bumi Hayat: Niagawan CSV adapter, versioned quote/specification, proof approval, job card, QC/rework, change order, and delivery evidence.
- [ ] Barakah Emas: approved Sheet adapter, rate/FX source, immutable rate snapshot, exact-purity/weight/spread/upah calculation, stale-rate control, buyback/exchange, and inventory movement.
- [ ] Exit only when every business owner signs the mapped source fixtures and domain exception rules; one passing business unit does not close the round.

## 7. Round 5 — integrations, files, reporting, and operations

- [ ] Deploy durable webhook acceptance, inbox/outbox dispatcher, queue workers, retries, DLQ, replay authorization, and provider lifecycle health.
- [ ] Implement Meta, TikTok, LeadsBridge, and WhatsApp provider contracts with signed requests, replay-safe dedupe, correct BU routing, consent, templates, and delivery status.
- [ ] For Meta, store only encrypted secret references plus business unit, environment, external account/page/form IDs, owner, scopes, last verified time, expiry/rotation due, webhook freshness, and last failure. Never reveal or copy the raw token; without a live check the UI says `Tidak diketahui`.
- [ ] Implement private object quarantine, content-signature validation, malware scan, authorised download, checksums, lifecycle, and access logs.
- [ ] Implement asynchronous controlled exports with formula-injection defense, expiry, watermark, and audit.
- [ ] Implement signed KPI definitions, server aggregates, dashboard/report/export parity, freshness, attribution, and restatement.
- [ ] Wire SLO metrics, traces, redacted logs, alerts, owner escalation, and executable runbooks.

## 8. Round 6 — full migration, hardening, and go-live

- [ ] Register final Salam CRM JSON, Tasha SQLite, Niagawan CSV, and Barakah Sheet snapshots with owner, cutoff, schema version, checksum, custody, and approved mapping.
- [ ] Run full-volume dry run, quarantine review, deterministic apply, reconciliation, dual-read comparison, and both-UI consistency checks.
- [ ] Pass full-envelope load, soak, failure, security, privacy, accessibility, browser, object-scan, queue-loss, database recovery, and backup/PITR restore evidence.
- [ ] Rehearse the exact cutover: fresh backup, write quiescence, final delta, provider route change, every UI × BU smoke path, rollback-forward trigger, and communication.
- [ ] Freeze all legacy writes and switch both product surfaces plus all three business units to canonical authority in one approved window.
- [ ] Staff hypercare until reconciliation, queue age, error rate, backup, provider, and business KPIs remain within approved thresholds.

## 9. External inputs that do not block starting Round 1

Engineering can start with synthetic contracts, but these inputs are required before their named sub-project or acceptance gate can close:

- a dedicated Hostinger production stack or an approved order/topology that satisfies ADR-003 isolation, with named Operations and Security owners;
- the managed OIDC provider/tenant, two production client registrations, privileged MFA/step-up policy, and account lifecycle owner;
- one approved Niagawan CSV export/template, encoding, cadence, cutoff, and Bumi Hayat data owner;
- the exact Barakah Google Sheet link, tab/range, formula-versus-value rule, cutoff, and Barakah data owner;
- signed Lead stage/SLA/assignment, Contact identity/merge/consent, Finance/refund, Salam lot, Printing, Gold rate/override, WhatsApp, retention, KPI, and capacity rules;
- named Product, business-unit, Finance, Privacy, Security, Operations, QA, and change-approval signatories.

Round 1 must use synthetic fixtures and contract-driven behavior; it must not guess any missing business mapping.
