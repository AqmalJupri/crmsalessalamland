# CRM Current Update Status — Salam Land

Updated: 2026-07-15 09:51:00 +08
Owner: Afiq / Julia / Codex
Status: **HOLD — local hardening verified with one remaining HMAC positive-test gap; no deploy, no commit**

## Purpose

This file is the single tracking note for the current Salam Land CRM update work. It summarizes what has been checked, what has changed locally, what is still pending, and what must not be deployed until approved.

## Current Overall Verdict

**HOLD.**

Local fail-closed behavior and package safety are mostly green, but release-candidate proof is not complete until the missing positive TikTok HMAC-signature smoke test is added and verified.

No production deploy has been approved.

## Safety Rules For This Workstream

- Do not deploy without explicit approval from Afiq.
- Do not commit until Afiq approves the exact phase.
- Do not touch production PM2/runtime/auth/uploads/backups unless a production phase is explicitly approved.
- Do not print or expose full tokens, API keys, callback tokens, passwords, auth hashes, or raw production payloads.
- Treat production secrets as boolean-only reporting: present / absent / non-default.
- Do not run mutation scripts as audit commands, especially `scripts/configure-tiktok-salam-ready.js`.
- Do not use the live production `ecosystem.config.cjs` until reviewed; previous audit found it targeted the wrong process/path/port.

## Production Context

Production CRM domain/process context known so far:

- Live domain: `crm.salamland.my`
- VPS IP: `72.62.255.244`
- PM2 process: `crm-salamland-my`
- Production app path: `/var/www/crm.salamland.my`
- Effective env source: active PM2 env plus `/root/.pm2/dump.pm2`
- No real production `.env` file was found during audit.

## TikTok Webhook Security Findings

### High-risk finding

Production PM2 has hardening flags set, but the currently deployed live `server.js` does not read/enforce those flags.

Production PM2 state found:

- `NODE_ENV=production`: yes
- `CRM_REQUIRE_WEBHOOK_SIGNATURES=true`: yes
- `TIKTOK_ALLOW_UNSIGNED_WEBHOOKS` not true: yes

Live webhook security currently depends mainly on:

- `integrations.tiktok.callbackToken`

That callback token is present and non-default now, but older live code could fail open if the runtime callback token becomes missing or unsafe.

### Local RC behavior

Local code contains hardening around TikTok webhook behavior:

- Production-like mode enforces required signatures.
- Unsigned TikTok override is restricted to explicit non-production/local mode.
- Missing runtime callback token fails closed.
- Generic/default callback token such as `crm-salam-fortress-tiktok` fails closed.
- Valid non-default static token succeeds.
- Static token comparison and HMAC path use constant-time comparison helper.
- Invalid-event logging reports presence booleans only, not full secrets.

### Remaining test gap

There is no dedicated positive TikTok HMAC-signature smoke test yet.

Existing coverage verifies fail-closed behavior, static-token success, local override rules, non-mutation, and package safety. It does not yet prove that a valid HMAC-signed TikTok webhook request is accepted and ingested.

## TikTok Ads Reporting / Spend Sync Findings

The TikTok Ads reporting client is initialized per request in `server.js`.

Credential precedence:

- Access token: runtime connection first, then `TIKTOK_ACCESS_TOKEN`
- Advertiser ID: runtime connection first, then `TIKTOK_ADVERTISER_ID`
- API base: `TIKTOK_BUSINESS_API_BASE`
- Pagination: `TIKTOK_REPORT_PAGE_SIZE`, `TIKTOK_REPORT_MAX_PAGES`

Production status from audit:

- `TIKTOK_ACCESS_TOKEN` present in PM2: no
- `TIKTOK_ADVERTISER_ID` present in PM2: no
- Runtime connections containing TikTok API access token: 0
- Runtime connections containing advertiser ID: 0

Meaning:

- TikTok lead webhook may still work depending on callback token.
- TikTok Ads spend/report sync is currently unconfigured and will fail only when invoked.
- Missing TikTok Ads credentials are checked at call time, not startup.

## Local Changes Already Made

### P0 doc/config cleanup

Verdict: **HOLD — P0 doc/config cleanup verified; no deploy, no commit.**

Files changed:

- `.env.production.example`
- `docs/ads-integration-config.private.example.json`

Changes made:

- Documented TikTok API env variables:
  - `TIKTOK_ACCESS_TOKEN`
  - `TIKTOK_ADVERTISER_ID`
  - `TIKTOK_BUSINESS_API_BASE`
  - `TIKTOK_REPORT_PAGE_SIZE`
  - `TIKTOK_REPORT_MAX_PAGES`
- Documented that TikTok webhook callback authentication currently comes from runtime path:
  - `integrations.tiktok.callbackToken`
- Added secret-handling reminder.
- Replaced 11 sensitive/token-like example fields with unmistakable placeholders.

P0 verification results:

- `node --check server.js` — exit 0
- `node --check scripts/smoke-lead-ingestion-guards.mjs` — exit 0
- `node scripts/smoke-lead-ingestion-guards.mjs` — exit 0
- `git diff --check` — exit 0
- Sanitized example JSON validation — exit 0

Scoped P0 diff summary:

```text
.env.production.example                          | 12 ++++++++++--
docs/ads-integration-config.private.example.json | 22 +++++++++++-----------
2 files changed, 21 insertions(+), 13 deletions(-)
```

## Verification Already Completed

### P1 verification-only phase

Verdict: **HOLD — fail-closed and package safety are green, but complete HMAC regression proof has one test gap.**

Command results:

- `node --check server.js` — exit 0
- `node --check app.js` — exit 0
- `node --check scripts/smoke-lead-ingestion-guards.mjs` — exit 0
- `node --check scripts/smoke-stabilize-sales-production.mjs` — exit 0
- `node --check scripts/production-package-audit.mjs` — exit 0
- `node scripts/smoke-lead-ingestion-guards.mjs` — exit 0
- `node scripts/smoke-stabilize-sales-production.mjs` — exit 0
- `node scripts/production-package-audit.mjs --dry-run` — exit 0
- `git diff --check` — exit 0

Package audit dry-run result:

- Included files: 8
- Excluded files: 1120
- Package assertions: passed

## Known Local Coverage Map

Implementation references from Codex audit:

- `CRM_REQUIRE_WEBHOOK_SIGNATURES` parsing: `server.js:31`
- Unsigned mode disabled when signatures required: `server.js:39`
- Local unsigned override restriction: `server.js:37`
- Default callback token constant: `server.js:41`
- Constant-time helper: `server.js:2199`
- HMAC verification: `server.js:2213`
- Static-token verification: `server.js:2237`
- Runtime callback token read: `server.js:4281`
- Missing/unsafe secret returns 503: `server.js:4283`
- Configured secrets enter verification: `server.js:4286`
- Invalid event metadata logs booleans only: `server.js:4291`

Smoke/package references from Codex audit:

- Required-signatures scenarios: `scripts/smoke-lead-ingestion-guards.mjs:386`
- Production blocked unsigned override: `scripts/smoke-lead-ingestion-guards.mjs:385`
- Explicit local unsigned behavior: `scripts/smoke-lead-ingestion-guards.mjs:387`
- Local ingestion assertion: `scripts/smoke-lead-ingestion-guards.mjs:419`
- State non-mutation assertion: `scripts/smoke-lead-ingestion-guards.mjs:417`
- Default token fail-closed cases: `scripts/smoke-lead-ingestion-guards.mjs:388` and `:389`
- Valid static-token request: `scripts/smoke-lead-ingestion-guards.mjs:627`
- Valid static-token captured successfully: `scripts/smoke-lead-ingestion-guards.mjs:629`
- Package unsigned gate contract: `scripts/production-package-audit.mjs:105`
- Package callback-token contract: `scripts/production-package-audit.mjs:107`
- Package PM2 target contract: `scripts/production-package-audit.mjs:138`
- Package strict allowlist: `scripts/production-package-audit.mjs:171`

## Next Required Phase

### P1b — Add missing positive TikTok HMAC smoke test

This is the next safest and smallest phase.

Goal:

- Add a dedicated smoke test proving a valid HMAC-signed TikTok webhook request is accepted and ingested.

Rules:

- No deploy.
- No commit.
- No production access.
- No PM2/runtime/auth/uploads/backups changes.
- No real secrets.
- Use fake test callback secret only.
- Preserve existing fail-closed/static-token/local-override tests.
- If `server.js` must be changed, stop and explain why before editing.

Verification for P1b:

```bash
node --check server.js
node --check scripts/smoke-lead-ingestion-guards.mjs
node scripts/smoke-lead-ingestion-guards.mjs
git diff --check
```

Expected P1b output:

- files changed
- exact test line numbers
- command results with exit status
- whether positive HMAC path is now covered
- HOLD/release-gate verdict

## Codex Prompt For P1b

```text
P1b HOLD MODE — add the missing TikTok positive HMAC smoke test only.

Scope:
Add a dedicated positive TikTok HMAC-signature regression test to scripts/smoke-lead-ingestion-guards.mjs.

Requirements:
1. Do not deploy.
2. Do not commit.
3. Do not touch PM2, runtime, auth, production, uploads, backups, or real env files.
4. Do not print or use real secrets.
5. Use a fake test callback secret only.
6. Cover the positive HMAC path, not just static-token path.
7. The test must prove a valid HMAC-signed TikTok webhook request is accepted and ingested.
8. Preserve existing fail-closed/static-token/local-override tests.
9. If server.js must be changed, stop and explain why before editing.

Investigate current HMAC signing format in server.js around:
- constant-time helper
- TikTok HMAC verification
- signed payload construction
- accepted signature headers
- timestamp handling

Then implement the smoke test using that exact format.

Run:
- node --check server.js
- node --check scripts/smoke-lead-ingestion-guards.mjs
- node scripts/smoke-lead-ingestion-guards.mjs
- git diff --check

Return:
- files changed
- exact test added with line numbers
- command results with exit status
- whether positive HMAC path is now covered
- HOLD/release-gate verdict
```

## After P1b Passes

Do not deploy yet. Continue with:

1. Full local RC checklist.
2. Fresh post-patch snapshot.
3. Production env/secret verification with boolean-only output.
4. Production current-state backup.
5. Explicit deploy approval from Afiq.
6. Small controlled deploy only if approved.
7. Post-deploy smoke checks.

Potential status after P1b passes:

**HOLD — local RC ready, pending final snapshot + production env/secret verification + explicit deploy approval.**

## Later Phases / Not For Now

Do not mix these into P1b:

- Timestamp freshness/skew validation for TikTok HMAC replay protection.
- Startup validation for TikTok Ads credentials.
- Strict URL/scheme allowlist for `TIKTOK_BUSINESS_API_BASE`.
- Admin UI/runtime credential management.
- Production deployment.
- Token rotation.
- PM2 env changes.

These should be handled as separate small phases after local RC and deploy gate are clear.
