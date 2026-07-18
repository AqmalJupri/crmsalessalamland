# Production Artifact Foundation Implementation Plan

> **Required skills:** `using-superpowers`, `brainstorming`, `test-driven-development`, `subagent-driven-development`, `systematic-debugging`, `requesting-code-review`, and `verification-before-completion`.

**Status:** Planned next engineering slice after PRD 1.8 Round 1 visual/hosted-CI closure. This plan does not authorize production deployment.

**Goal:** Produce separate CRM and Tasha OCI release images from one reviewed commit, bind each image to its source and migration ledger, generate an SBOM, fail closed on secrets/vulnerabilities, and prove the exact exported image runs under a restricted container profile.

**Why this slice:** It is the highest-value work that does not depend on D-19 RLS approval, D-20 queue selection, a real IdP, dedicated infrastructure, or missing Niagawan/Barakah source contracts. It closes part of UD-1 only.

**Non-goals:** Registry promotion, signing-key custody, production VPS changes, production database/RLS, real-provider secrets, queue/DLQ, object storage, telemetry, PITR, real-source migration, UAT, or go-live approval.

## Invariants

- Build CRM and Tasha separately from the same full source SHA; never switch surface at runtime.
- Pin the Node `22.22.0` Linux base by immutable digest and record the resolved platform digest in tests and release metadata.
- Never pass a real secret through `ARG`, ordinary build environment, layer content, image label, SBOM, cache or artifact.
- The final stage uses a numeric non-root UID/GID, an allowlist copy, no package cache, no raw application/domain source, tests, docs or Git data, and no shell-dependent startup contract.
- Runtime uses the exact downloaded/exported image without rebuilding it.
- Existing tar-build/runtime jobs remain until image parity is green; removal requires a separate reviewed change.
- Any vulnerability exception requires a committed identifier, owner, rationale and expiry. Secret findings have no allowlist.
- Image/SBOM/manifest evidence is synthetic engineering evidence and cannot pass Gate B.

## Task 1: Lock the release-image contract with RED tests

**Files:**

- Create `tests/ci/release-image-contract.test.ts`
- Create `tests/ci/release-manifest.test.ts`
- Modify `tests/ci/quality-workflow.test.ts`

- [ ] Add failing source tests requiring `Dockerfile`, `.dockerignore`, one immutable base digest, two explicit surfaces, numeric non-root user, final-stage allowlist, direct Node startup, OCI source/revision/version/surface labels, and no secret-shaped `ARG`/`ENV`.
- [ ] Add failing ignore tests for `.git`, `.env*`, source exports, SQLite/CSV/Sheet snapshots, caches, coverage, Playwright evidence, docs, tests and local dumps while retaining required runtime files.
- [ ] Add failing workflow tests requiring commit-pinned build tooling, exact-SHA checkout, separate CRM/Tasha outputs, SBOM/scan/manifest artifacts, downstream exact-image smoke and terminal-gate dependencies.
- [ ] Add negative fixtures for root user, floating base tag, copied `.env`, secret build argument, wrong surface label, mutable image reference, missing SBOM and manifest/image digest mismatch.
- [ ] Run the focused tests and capture RED before implementation.

## Task 2: Build a minimal dual-surface image

**Files:**

- Create `Dockerfile`
- Create `.dockerignore`
- Modify `src/server/env.ts` and its tests only if the build currently requires a runtime secret

- [ ] Resolve the official Linux/amd64 Node `22.22.0` image digest from the registry, record the evidence, and pin `FROM` by digest. Do not guess or use `latest`.
- [ ] Use a multi-stage pnpm build. Install with the frozen lockfile, build one immutable `PRODUCT_SURFACE`, and create a production dependency tree without copying a package-manager cache into the final stage.
- [ ] If Next build requires `OIDC_CLIENT_SECRET`, first add a RED test, then separate build-time public configuration from runtime secret validation. Production startup must still fail without the real runtime secret; no placeholder secret may be embedded in output.
- [ ] Enable and copy only the reviewed Next standalone output, `.next/static`, `public`, package metadata and the minimum generated runtime metadata. Do not copy raw `next.config.ts` or other TypeScript source into the final image.
- [ ] Run as numeric UID/GID `10001:10001`; start directly with `node server.js`.
- [ ] Add a Node-based health check only if it can run without adding curl, a shell, credentials or state.
- [ ] Prove both images build from the same SHA and have different immutable surface labels/metadata.

## Task 3: Inspect the exported image

**Files:**

- Create `scripts/ci/assert-release-image.mjs`
- Create `scripts/ci/release-image-contract.mjs`
- Extend the Task 1 tests

- [ ] Parse image inspection and filesystem evidence with bounded input; fail on root, missing/wrong labels, floating base, unexpected paths, writable application files or wrong surface.
- [ ] Scan the unpacked final filesystem for `.env`, Git metadata, source/test/docs/export paths, private keys, credential patterns and the exact CI canary secret. Log paths and safe codes only, never matched secret values.
- [ ] Unit-test hostile inspection JSON, symlinks, traversal paths, duplicate tar entries, oversized evidence and malformed digests.

## Task 4: Generate both SBOM formats and enforce scan policy

**Files:**

- Create `security/container-vulnerability-allowlist.json`
- Extend release-image scripts/tests

- [ ] Choose official SBOM and vulnerability scanners, pin their actions/images/binaries by immutable commit or digest, and record version evidence. No curl-to-shell installer is allowed.
- [ ] Produce canonical CycloneDX JSON and SPDX JSON for each final image, digest both outputs, and retain the scanner report needed by the manifest.
- [ ] Fail on a detected secret and on unapproved High/Critical vulnerabilities. An exception must match exact vulnerability/package/version, have owner/rationale/expiry, and fail after expiry.
- [ ] Record scanner engine/version, policy version/digest, vulnerability-database source/version/timestamp/digest and scan-report digest without leaking environment values or database credentials.
- [ ] Ensure all SBOM and scan reports contain no source data or customer identifiers.

## Task 5: Bind the release manifest and prove restricted exact-image runtime ownership

**Files:**

- Create `scripts/ci/write-release-manifest.mjs`
- Create `scripts/ci/run-release-image-smoke.mjs`
- Create `tests/ci/release-image-smoke-owner.test.ts`
- Reuse `tests/production/runtime-smoke.mjs`

- [ ] Only after the image, both SBOMs and scan report exist, generate a deterministic JSON release manifest binding schema version, source SHA, surface, app version, base digest, image manifest/config digest, exported artifact SHA-256, seven-row migration-ledger identity, both SBOM formats/digests, scan-report digest, scanner engine/version, policy version/digest and vulnerability-database provenance.
- [ ] Reject unknown fields, non-canonical ordering, duplicate surfaces, mismatched SHA/surface/ledger/SBOM/scan evidence and any manifest produced before every bound artifact exists.
- [ ] Write RED process-owner tests for success, image-start failure, readiness failure, smoke failure, timeout, `SIGINT` and `SIGTERM`; every path must remove the container, dedicated network and child process.
- [ ] Load/import the downloaded image artifact without rebuilding. Verify its digest, labels, both SBOMs, scan report and release manifest before start.
- [ ] Run with `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, bounded PID/memory/CPU limits and only the documented tmpfs paths required by Next runtime.
- [ ] Create a dedicated Docker `--internal` network containing only the app and isolated synthetic PostgreSQL. Publish the app on a loopback-only random high port; deny host-gateway, cloud metadata, host/LAN and public egress, never use host networking, and never mount the repository.
- [ ] Regression-test blocked DNS/public-IP/metadata/host-gateway/LAN egress while preserving only the documented app-to-database path.
- [ ] Run the existing production runtime/security/readiness smoke for both surfaces, then send `SIGTERM`, restart the same image and prove readiness again.
- [ ] Prove missing config, wrong `PRODUCT_SURFACE`, demo mode, stale ledger and mismatched release manifest all fail closed.

## Task 6: Add hosted image build/scan/smoke gates

**Files:**

- Modify `.github/workflows/quality.yml`
- Modify `tests/ci/quality-workflow.test.ts`
- Modify `README.md`
- Modify `.superpowers/sdd/progress.md`

- [ ] Add exact-SHA CRM/Tasha image build jobs after checks. Preserve the existing build/runtime jobs until container parity passes.
- [ ] Make downstream SBOM/scan jobs download the exact image, then generate their evidence; make manifest/runtime jobs download that exact image plus both SBOMs and the scan report. Forbid a second build and enforce image → SBOM/scan → manifest → smoke dependency order.
- [ ] Restore the exact reviewed migration dump, verify ledger identity, then run both restricted image smokes.
- [ ] Upload image, both SBOMs, scan report and release manifest as short-retention artifacts with `if-no-files-found: error` and immutable names containing surface + source SHA.
- [ ] Make terminal `verify` depend on checks, existing build/runtime, image build, SBOM/scan and image runtime smoke.
- [ ] On trusted pushes only, request the minimal permission needed for GitHub provenance attestation if repository policy supports it. Pull requests remain read-only and cannot publish/promote.
- [ ] Run workflow contract tests, lint, typecheck, unit coverage, production coverage, DB suite and both local image smokes.
- [ ] Push a reviewed branch and require a fully green hosted Quality run on Node 22.22.0/Ubuntu before claiming the slice complete.

## Task 7: Independent review and evidence ledger

- [ ] Request separate spec, security/container and code-quality reviews.
- [ ] Resolve every Critical/Important finding with a failing regression first.
- [ ] Scan the full diff and new Git objects for credentials, source data, unsafe archives and unbounded artifacts.
- [ ] Record exact image/SBOM/manifest digests, test counts, hosted run URL and residual risks in the SDD ledger.
- [ ] Keep Gate B and production readiness **Not passed**. Record external blockers: production registry/signing ownership, dedicated stack, RLS/roles, IdP/MFA, queue, object storage, telemetry, off-site PITR/restore, real adapters, UAT and named approvals.

## Completion evidence

This slice is complete only when both exact images build, inspect, scan and pass restricted runtime smoke from downloaded artifacts in hosted CI, all reviews are approved, and each release manifest binds the final source SHA, image, seven-row migration ledger, CycloneDX and SPDX digests, scan-report digest, scanner/policy identity and vulnerability-database provenance. It does not authorize a registry promotion or deployment to `awang` or any production host.
