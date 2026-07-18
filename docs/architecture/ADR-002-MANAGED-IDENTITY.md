# ADR-002 — Managed OpenID Connect Identity

**Status:** Product direction approved 16 July 2026; provider selection and Security, Engineering, Management, Operations and Privacy approval remain required by PRD decision `D-14`; every production gate is not passed

**Date:** 15 July 2026

## Context

The legacy CRM owns shared passwords and can reseed authentication state after errors. A production replacement needs named identities, MFA, recovery, offboarding, session revocation, assurance levels, access review and audit without making the CRM a credential-security product.

## Decision

Use an approved managed identity provider through OpenID Connect Authorization Code Flow with PKCE. The CRM will not store user passwords.

- Provider subjects are stored as issuer-scoped `users.auth_subject` values.
- Users must be pre-provisioned and active; successful provider authentication never creates tenant access automatically.
- A current active Membership remains mandatory after authentication.
- Privileged users and sensitive actions require provider MFA/step-up at the approved assurance level.
- The browser receives only a high-entropy opaque CRM session cookie. PostgreSQL stores its hash, tenant, selected business unit, assurance, expiry, revocation and device/network hashes.
- OIDC state, nonce and PKCE verifier are encrypted in a short-lived HttpOnly transaction cookie and validated on callback.
- Only a provider identity that has been resolved far enough for a CRM access decision creates durable `auth_login_attempts` evidence. Missing, expired, tampered and otherwise anonymous callback protocol failures do not append to that immutable table; they belong in bounded, redacted edge/provider operational telemetry.
- Production application, issuer and redirect URLs must use HTTPS; the redirect origin must match the application origin and the callback path must be exact, with credentials/query/fragment rejected from configuration URLs.
- Production startup fails when OIDC settings are absent or demo mode is enabled.
- Local demo bypass is allowed only outside production and contains synthetic data.

## Current implementation evidence

The working tree contains OIDC start/callback, state/nonce/PKCE validation, canonical safe return-path handling, pre-provisioned active human User/Membership checks, an opaque PostgreSQL session hash, current-session logout, durable resolved CRM access-decision evidence, anonymous-callback write containment, production HTTPS/origin/callback coherence checks and local database/API tests. Bounded edge/provider telemetry and rate limiting are still release work, not completed application controls. This is engineering evidence only: no final green promoted release, approved managed provider/MFA policy, production secret, recovery/offboarding process, break-glass route or real-provider callback has been approved or exercised. Every gate remains **Not passed**.

## Consequences

- Password reset, lockout, MFA enrollment and primary credential telemetry are delegated to the identity provider.
- The CRM still owns authorization, membership lifecycle, session revocation, step-up enforcement and audit.
- Identity-provider availability and configuration become release dependencies and must be monitored and rehearsed.
- A provider migration requires stable subject mapping or an approved account-linking migration.
- Break-glass access must be provider-managed, separately monitored and tested; no shared application password is permitted.

## Release conditions

This ADR remains proposed until all conditions below have dated evidence and named Security, Management, Engineering, Operations and Privacy approval where applicable:

- provider, tenant, region/data residency, production client, exact callback/logout origins and secret/key ownership are approved;
- first-administrator bootstrap, ordinary pre-provisioning, Membership activation/suspension, provider disable, CRM offboarding, work reassignment and subject-migration/account-linking flows are rehearsed without JIT tenant access;
- issuer, audience/authorized party, redirect URI, state, nonce, PKCE, authentication age and clock-skew policies pass positive, tamper, replay and mix-up tests;
- provider MFA policy and `acr`/`amr` assurance mapping enforce step-up for every protected action, including failure and downgrade cases;
- CRM session rotation, idle and absolute expiry, current/all-device revocation, role/Membership change propagation and post-restore invalidation meet `IAM-004`;
- JWKS/signing-key rotation, discovery/provider outage, rate limiting, callback failure, secret rotation and multi-node operation fail closed and produce PII-safe telemetry/alerts;
- provider recovery, break glass, log retention, access review, vendor/subprocessor and incident obligations are approved and tested; and
- demo mode and missing/invalid OIDC production configuration fail deployment readiness before user traffic is accepted.
