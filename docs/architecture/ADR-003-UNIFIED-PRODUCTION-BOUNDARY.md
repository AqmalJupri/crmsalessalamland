# ADR-003 — Unified Production Authority, Two UI Surfaces, and Simultaneous Cutover

- **Status:** Product direction approved 16 July 2026; named approval record pending; technical, business-rule, legal/privacy, Security, Engineering, Operations, Management, migration, UAT, and release approvals remain pending/not passed
- **Date:** 2026-07-16
- **Decision owner:** Product Owner (approval captured in this task; full name must be recorded before build lock)
- **Related:** `docs/CRM_PRODUCTION_PRD_V2_2026-07-15.md`, `docs/plans/2026-07-16-unified-crm-production-design.md`, ADR-001, ADR-002, PRD decisions D-03/D-13/D-19/D-20/D-21/D-22/D-23

## Context

Salam Land currently splits acquisition/sales and administration across CRM JSON and Tasha SQLite. Bumi Hayat Printing uses Niagawan without an approved API but can provide CSV. Barakah Emas uses a Google Sheet whose exact source coordinates/schema still require registration. The existing multipurpose Hostinger VPS is not acceptable as the final shared production boundary.

Running separate operational databases per UI or leaving legacy sources writable after cutover would preserve identity, lifecycle, lot, finance and reporting drift. Phasing internal delivery is useful, but phasing initial production authority by business unit would create mixed write authorities and new reconciliation risk.

## Product decision

1. One canonical production PostgreSQL is the sole operational system of record for Salam Land, Bumi Hayat Printing and Barakah Emas.
2. One modular API/domain layer owns identity, authorization, validation, commands, concurrency, audit, integration and reporting semantics.
3. `crm.salamland.my` serves marketers, sales, management, shared CRM work and all three business-unit verticals.
4. `tasha.salamland.my` serves the focused Salam Land sales-administration workflow.
5. Both UIs consume the same API/canonical records. Neither performs direct database writes or owns copied domain rules/shadow data.
6. Salam CRM JSON, Tasha SQLite, Niagawan CSV and the approved Barakah Sheet snapshot are controlled migration/transition inputs with immutable source evidence, staging, versioned mapping, quarantine, reconciliation and read-only archival treatment.
7. Production uses a dedicated isolated Hostinger stack. Legacy and staging may temporarily share the transition VPS only as isolated environments and never share production databases, storage, OIDC clients, provider routes, secrets, service users, writable volumes, queues, observability or backup credentials.
8. Internal build, training and UAT may phase. Both UIs and all three business units switch production authority within one approved cutover window, with no business unit declared production-live early and no mixed writable legacy authority.
9. The compact blue/navy/gold UI, concise Malay copy, complete production states, WCAG 2.2 AA and private-app metadata/PWA controls in PRD Section 12 are GA requirements.

## Approval boundary

This ADR records product direction only. It does not:

- select or approve final provider region/account ownership, sizing, PostgreSQL topology/HA, connection budget, queue technology, or cost;
- approve the D-19 database role/RLS implementation, D-14 IdP configuration, source extract checksums/cutoffs, business rules, legal controller/retention position, or provider credentials;
- mark any Plan, Gate A, Gate B, functional-slice gate, Gate C, or Gate D as passed; or
- authorise production deployment or live-data mutation.

Those decisions require named evidence and approvers under the PRD. The Product Owner's full name must replace the temporary task record before build lock.

## Consequences

- Cross-UI records must reconcile exactly because there is only one domain authority.
- Every migration adapter must be deterministic, idempotent and source-specific.
- Existing cohort language applies to training/UAT, not separate initial production authority by business unit.
- Application rollback uses a compatible canonical release or forward recovery; legacy JSON/SQLite/Sheet sources do not resume writable authority.
- Dedicated production is mandatory, while exact infrastructure and operational acceptance remain open.

## Supersession rule

Where the older execution plan implies phased initial production activation by business unit, this ADR and PRD revision 1.8 supersede that implication. A new implementation plan must retain the authoritative gate names and map the approved simultaneous cutover without redefining Gate A–D.
