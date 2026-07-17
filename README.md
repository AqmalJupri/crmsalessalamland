# CRM Salam Fortress V2

Development foundation for a production CRM spanning Salam Land, Bumi Hayat Printing, and Barakah Emas. Product direction was approved on 16 July 2026, but this working tree is **not a production release**: named business-rule, legal/privacy, security, engineering, operations, management and migration approvals remain pending, and every Plan, foundation, functional-slice, UAT and cutover gate is **Not passed**.

## Current implementation truth

| Area | Current state |
|---|---|
| Identity | Managed OIDC Authorization Code + PKCE start/callback, non-cacheable auth redirects, pre-provisioned active human User and Membership checks, PostgreSQL-backed opaque sessions, current-session logout, request-scoped viewer resolution, and server-enforced read capabilities for every CRM module are authored and locally tested. Anonymous callback protocol noise creates no append-only login-attempt row; resolved CRM access decisions remain durable. Unauthenticated module links retain their safe return path; authenticated denial uses an explicit `403`. The provider, edge rate limit/telemetry, MFA/assurance policy, recovery, break glass, logout-all/device management, and production configuration are not approved or live-tested. |
| Leads | Server command slices own receipt time and canonical provider keys, validate effective human owners, preserve deterministic assignment provenance, fail closed when a Contact–Business Unit relationship changes during create, safely map only the wrapped PostgreSQL provider-ID uniqueness constraint, and row-lock versioned transitions. Create bodies are stream-counted at 32 KiB and attribution has explicit depth/key/string/array/node budgets. Transition access requires an explicit `OWN` or elevated `BUSINESS_UNIT` record scope, and a signed idempotency decision replays a committed transition without duplicate history, audit, or outbox effects. Lead has no monetary-value field; Opportunity owns expected amount. There is no production Lead GET/query path. |
| Pipeline and dashboard | Interactive presentation slices backed only by the explicit non-production demo runtime. Provider/stage labels use canonical labels with a safe unknown-value fallback, and Pipeline totals are derived from current demo card state, but movement is client-local and is not an Opportunity API write. An authenticated non-demo viewer receives a concise empty state, never seeded names, work, or amounts. |
| Other modules | Tasks, Orders, Inventory, Finance, Marketing, Reports, Team, and Settings are demo presentation slices gated away from non-demo viewers, not production services. |
| Platform | The exact migration manifest/checksum, strict zero-padded discovery, migration lock/statement timeouts, first/no-op/tamper runner test, migration-aware readiness, production HTTPS/OIDC URL coherence, request-nonce CSP including dynamic 404s and purpose/unexpected-prefetch HTML, fail-closed CSP on exact RSC prefetches, and a bounded `400`/`no-store` guard for malformed router-prefetch contracts are authored and locally exercised. Local composition remains PostgreSQL-only. Redis is neither configured nor consumed; workers, queue dispatch, object storage, production telemetry, backup/PITR automation, restore rehearsal, independent edge rate limits/origin timeouts, and infrastructure are absent. |
| Release | The latest settled local checks pass lint, TypeScript, build, production runtime smoke, **220 unit/component tests across 34 files**, **57 PostgreSQL/API integration tests across 5 files** on disposable PostgreSQL 16.14 database `crm_salam_codex_final_test_20260715`, and demo E2E with **7 passes plus 1 intentional desktop skip**. The explicit high-confidence unit scope is 91.22% statements, 83.80% branches, 91.40% functions and 92.32% lines. A separate 231-test run measures every production source file at 63.74%, 59.14%, 70.18% and 64.07%, respectively. This is engineering evidence only: hosted CI has not run, no immutable promoted artifact exists, and every acceptance gate remains **Not passed**. |

## Local start

### Demo UI mode

Use this mode only for local review with synthetic data.

1. Copy `.env.example` to `.env.local` and keep `CRM_DEMO_MODE=true`.
2. Run `docker compose -f compose.dev.yml up -d` if PostgreSQL inspection is needed.
3. Run `pnpm install`.
4. Run `pnpm dev`.

Demo mode bypasses real authentication and database writes. A successful UI action in this mode is not persistence, permission, or integration evidence. Production rejects demo mode, and synthetic read models are gated away from non-demo viewers.

### Database and managed-OIDC mode

1. Set `CRM_DEMO_MODE=false`; configure `DATABASE_URL`, an environment-appropriate `DATABASE_POOL_MAX`, `APP_URL`, `AUTH_HASH_KEY`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI` from approved development secrets.
2. Run `docker compose -f compose.dev.yml up -d` and `pnpm db:migrate`.
3. Provision an active `users.auth_subject`, active Organization/Business Unit, Membership, Role, and capabilities before login; successful provider authentication never grants tenant access automatically.
4. Run `pnpm dev` and authenticate through the configured development identity provider.

Do not use example credentials or an unapproved identity tenant outside local development.

## Verification

- `pnpm verify` runs lint, TypeScript, the high-confidence unit coverage gate, the all-production-source coverage floor, and a production build.
- `pnpm test:coverage` measures the explicitly declared fast unit/component scope at 85% statements/lines/functions and 80% branches; `pnpm test:coverage:production` adds the auth-route boundary suite, includes every production `src` TypeScript/TSX file, and enforces the independent 62% statements/lines, 69% functions and 58% branches floor.
- `pnpm test:runtime` probes an already-running production build and checks security headers, nonce-bearing CSP on the login page and a dynamic 404, valid RSC fallback CSP, bounded malformed-prefetch rejection, authorization boundaries, and migration-aware readiness. CI starts and stops that process explicitly.
- `TEST_DATABASE_URL=postgresql://... pnpm test:db` requires a disposable PostgreSQL database whose name matches the integration-suite safety rule. The suite migrates and destroys test data; never point it at a shared or production database.
- `pnpm test:e2e` runs the current demo-mode browser smoke/accessibility flows.
- `TEST_DATABASE_URL=postgresql://... pnpm verify:full` combines lint, TypeScript, coverage, build, PostgreSQL and demo E2E checks; the production runtime probe remains a separate start/probe/stop step. It has the same disposable-database requirement.

These commands are necessary engineering checks, not release approval. They do not replace a real IdP/provider and OIDC/MFA/step-up tests, hosted CI and promotion, production infrastructure, workers/queues, object storage, telemetry, PITR/restore rehearsal, migration reconciliation, capacity/soak evidence, business UAT, or named security/privacy/operations approvals.

### Reproducibility anchors

- Runtime contract: Node.js `22.22.0`, pnpm `11.9.0`, Next.js `16.2.10`, React `19.2.7`, and TypeScript `6.0.3`.
- GitHub Actions are commit-pinned: checkout `34e114876b0b11c390a56381ad16ebd13914f8d5`, pnpm setup `b906affcce14559ad1aafd4ab0e942779e9f58b1`, and Node setup `49933ea5288caeca8642d1e84afbd3f7d6820020`.
- PostgreSQL is digest-pinned in local composition and CI to `postgres:16.14-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`.
- The reviewed migration ledger is `0001_foundation.sql` (`169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de`), `0002_migration_platform.sql` (`2e8425ae8f551fc5b8c96466f36e917df118a12a18c66e69ec68800e73ec0e73`), `0003_reconciliation_bytewise_order.sql` (`46fb6ab301eb4362dc4c74c186a432e59bcf00736e78ab3d5d8ea8e7359885c4`), `0004_membership_user_identity_guard.sql` (`58713ceda7660aa4a5385c734744c9bb9e12ccb00272032acf9a34cdfca70c5c`), and `0005_reconciliation_typed_result_truth.sql` (`8fbf0ff4b506cc682b16b6d3fe4b59d69ee47040b95ed20542ff6983c496c381`). The manifest also locks their exact byte lengths and rejects missing, extra, reordered, or modified migration files.

The workflow and pins are authored controls, not remotely executed promotion evidence. This repository is a **hardened production foundation**, not a production release.

See `docs/plans/2026-07-16-unified-crm-production-design.md`, `docs/CRM_PRODUCTION_PRD_V2_2026-07-15.md`, `docs/CRM_EXECUTION_PLAN_V2_2026-07-15.md`, and `docs/architecture/ADR-003-UNIFIED-PRODUCTION-BOUNDARY.md` for the approved direction, evidence requirements, and unresolved release decisions.
