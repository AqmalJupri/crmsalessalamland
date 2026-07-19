# Production Artifact Foundation Implementation Plan

> **Required skills:** `using-superpowers`, `brainstorming`, `test-driven-development`, `subagent-driven-development`, `systematic-debugging`, `requesting-code-review`, and `verification-before-completion`.

**Status:** Local implementation and independent reviews complete on `codex/production-artifact-foundation`; hosted exact-image execution is pending. Local contracts and regressions are evidence only, and every production deployment gate remains open. This plan does not authorize production deployment.

**Goal:** Produce separate CRM and Tasha OCI release images from one reviewed commit, bind each image to its source and migration ledger, generate an SBOM, fail closed on secrets/vulnerabilities, and prove the exact exported image runs under a restricted container profile.

**Why this slice:** It is the highest-value work that does not depend on D-19 RLS approval, D-20 queue selection, a real IdP, dedicated infrastructure, or missing Niagawan/Barakah source contracts. It closes part of UD-1 only.

**Non-goals:** Registry promotion, signing-key custody, production VPS changes, production database/RLS, real-provider secrets, queue/DLQ, object storage, telemetry, PITR, real-source migration, UAT, or go-live approval.

## Invariants

- Build CRM and Tasha separately from the same full source SHA; never switch surface at runtime.
- Pin the patched Node `22.23.1` build base and the Distroless Node 22 Debian 13 non-root runtime by immutable index and Linux/amd64 platform digests; record the exact runtime ancestry, config and layer identities in tests and release metadata.
- Never pass a real secret through `ARG`, ordinary build environment, layer content, image label, SBOM, cache or artifact.
- The final stage uses Distroless numeric non-root UID/GID `65532:65532`, a root-owned allowlist copy, no package cache, no raw application/domain source, test source, docs or Git data, and no shell-dependent startup contract.
- Runtime uses the exact downloaded/exported image without rebuilding it.
- Existing tar-build/runtime jobs remain until image parity is green; removal requires a separate reviewed change.
- Any vulnerability exception requires a committed identifier, owner, rationale and expiry. Secret findings have no allowlist.
- Image/SBOM/manifest evidence is synthetic engineering evidence and cannot pass Gate B.

## Task 1: Lock the release-image contract with RED tests

**Files:**

- Create `tests/ci/release-image-contract.test.ts`
- Create `tests/ci/release-manifest.test.ts`
- Modify `tests/ci/quality-workflow.test.ts`

- [x] Add failing source tests requiring `Dockerfile`, `.dockerignore`, one immutable base digest, two explicit surfaces, numeric non-root user, final-stage allowlist, direct Node startup, OCI source/revision/version/surface labels, and no secret-shaped `ARG`/`ENV`.
- [x] Add failing ignore tests for `.git`, `.env*`, source exports, SQLite/CSV/Sheet snapshots, caches, coverage, Playwright evidence, docs, tests and local dumps while retaining required runtime files.
- [x] Add failing workflow tests requiring commit-pinned build tooling, exact-SHA checkout, separate CRM/Tasha outputs, SBOM/scan/manifest artifacts, downstream exact-image smoke and terminal-gate dependencies.
- [x] Add negative fixtures for root user, floating base tag, copied `.env`, secret build argument, wrong surface label, mutable image reference, missing SBOM and manifest/image digest mismatch.
- [x] Run the focused tests and capture RED before implementation.

## Task 2: Build a minimal dual-surface image

**Files:**

- Create `Dockerfile`
- Create `.dockerignore`
- Modify `src/server/env.ts` and its tests only if the build currently requires a runtime secret

- [x] Resolve and lock the official Linux/amd64 Node `22.23.1` build image plus Distroless Node 22 Debian 13 runtime index/platform/config/layer identities. Do not guess or use `latest`; the shipped runtime must prove exact ancestry rather than trusting labels.
- [x] Use a multi-stage pnpm build. Install with the frozen lockfile, build one immutable `PRODUCT_SURFACE`, and create a production dependency tree without copying a package-manager cache into the final stage.
- [x] Confirm both surface builds require no `OIDC_CLIENT_SECRET`; runtime validation remains fail-closed and no placeholder secret is embedded in output.
- [x] Enable and copy only the reviewed Next standalone output, `.next/static` and `public` runtime inputs. Do not copy raw `next.config.ts` or other TypeScript source into the final image.
- [x] Run as the Distroless built-in numeric UID/GID `65532:65532`; start directly with `/nodejs/bin/node server.js` and no inherited entrypoint.
- [x] Keep health probing outside image metadata so no curl, shell, credential or mutable health script is added; the restricted smoke uses the existing Node probe.
- [ ] Prove both images build from the same SHA and have different immutable surface labels/metadata.

## Task 3: Inspect the exported image

**Files:**

- Create `scripts/ci/assert-release-image.mjs`
- Create `scripts/ci/release-image-contract.mjs`
- Extend the Task 1 tests

- [x] Parse image inspection and filesystem evidence with bounded input; fail on root, missing/wrong labels, floating base, unexpected paths, writable/privilege-bearing application entries or wrong surface.
- [x] Scan the unpacked final filesystem for `.env`, Git metadata, source/test/docs/export paths, private keys, credential patterns and the exact CI canary secret. Log paths and safe codes only, never matched secret values.
- [x] Unit-test hostile inspection JSON, symlinks, traversal paths, duplicate tar entries, oversized evidence, malformed digests and bounded PAX/GNU extended paths used by pnpm links.

## Task 4: Generate both SBOM formats and enforce scan policy

**Files:**

- Create `security/container-vulnerability-allowlist.json`
- Extend release-image scripts/tests

- [x] Choose official SBOM and vulnerability scanners, pin downloaded Linux/amd64 tool bytes by committed SHA-256/size before extraction or execution, and record version evidence. No curl-to-shell installer is allowed.
- [x] Produce canonical CycloneDX JSON and SPDX JSON for each final image, digest both outputs, and add an explicit sidecar binding the exact Syft invocation and image manifest/config/archive identities.
- [x] Fail on a detected secret and on unapproved High/Critical vulnerabilities. An exception must match exact vulnerability/package/version, have owner/rationale/expiry, and fail after expiry.
- [x] Record scanner engine/version, policy version/digest, vulnerability-database source/version/timestamp/digest and scan-report digest without leaking environment values or database credentials.
- [x] Restrict accepted SBOM/scan schemas to release identity and scanner evidence; reject unbound or unknown evidence before manifest generation.

## Task 5: Bind the release manifest and prove restricted exact-image runtime ownership

**Files:**

- Create `scripts/ci/write-release-manifest.mjs`
- Create `scripts/ci/run-release-image-smoke.mjs`
- Create `tests/ci/release-image-smoke-owner.test.ts`
- Reuse `tests/production/runtime-smoke.mjs`

- [x] Only after the image, both SBOMs, binding and scan report exist, generate a deterministic JSON release manifest binding schema version, source SHA, surface, app version, base digest, image manifest/config digest, exported artifact SHA-256, seven-row migration-ledger identity, SBOM/binding digests, scan-report digest, scanner engine/version, policy version/digest and vulnerability-database provenance.
- [x] Reject unknown fields, non-canonical ordering, duplicate surfaces, mismatched SHA/surface/ledger/SBOM/scan evidence and any manifest produced before every bound artifact exists.
- [x] Write RED process-owner tests for success, image-start failure, readiness failure, smoke failure, timeout, `SIGINT` and `SIGTERM`; every path must remove the container, dedicated network and child process.
- [x] Implement exact downloaded-image load and pre-start verification of its digest, labels, SBOM binding, scan report and release manifest without rebuilding.
- [x] Run with `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, bounded PID/memory/CPU limits and only the documented tmpfs paths required by Next runtime.
- [x] Create a dedicated Docker `--internal` network containing only the app and isolated synthetic PostgreSQL. Publish the app on a loopback-only random high port; deny host-gateway, cloud metadata, host/LAN and public egress, never use host networking, and never mount the repository.
- [x] Regression-test blocked DNS/public-IP/metadata/host-gateway/LAN egress while preserving only the documented app-to-database path.
- [ ] Run the existing production runtime/security/readiness smoke for both surfaces, then send `SIGTERM`, restart the same image and prove readiness again.
- [x] Prove missing config, wrong `PRODUCT_SURFACE`, demo mode, stale ledger and mismatched release manifest all fail closed in the smoke-owner contract.

## Task 6: Add hosted image build/scan/smoke gates

**Files:**

- Modify `.github/workflows/quality.yml`
- Modify `tests/ci/quality-workflow.test.ts`
- Modify `README.md`
- Modify `.superpowers/sdd/progress.md`

- [x] Add exact-SHA CRM/Tasha image build jobs after checks. Preserve the existing build/runtime jobs until container parity passes.
- [x] Make downstream SBOM/scan jobs download the exact image, then generate their evidence; make manifest/runtime jobs download that exact image plus both SBOMs and the scan report. Forbid a second build and enforce image → SBOM/scan → manifest → smoke dependency order.
- [x] Restore the exact reviewed migration dump, verify ledger identity, then run both restricted image smokes.
- [x] Upload image, both SBOMs, binding, scan report and release manifest as short-retention artifacts with `if-no-files-found: error` and immutable names containing surface + source SHA.
- [x] Make terminal `verify` depend on checks, existing build/runtime, image build, SBOM/scan and image runtime smoke.
- [x] On trusted main pushes only, request the minimal permission for GitHub provenance attestation; pull requests and branch pushes remain read-only and cannot publish/promote.
- [ ] Run workflow contract tests, lint, typecheck, unit coverage, production coverage, DB suite and both local image smokes.
- [ ] Push a reviewed branch and require a fully green hosted Quality run on exact Node `22.23.1`/Ubuntu before claiming the slice complete.

## Task 7: Independent review and evidence ledger

- [x] Request separate workflow/code-quality, security/container and runtime/release reviews.
- [x] Resolve every Critical/Important finding with a failing regression first; final re-reviews report none remaining.
- [ ] Scan the full diff and new Git objects for credentials, source data, unsafe archives and unbounded artifacts.
- [ ] Record exact image/SBOM/manifest digests, test counts, hosted run URL and residual risks in the SDD ledger.
- [x] Keep Gate B and production readiness **Not passed**. Record external blockers: production registry/signing ownership, dedicated stack, RLS/roles, IdP/MFA, queue, object storage, telemetry, off-site PITR/restore, real adapters, UAT and named approvals.

## Completion evidence

This slice is complete only when both exact images build, inspect, scan and pass restricted runtime smoke from downloaded artifacts in hosted CI, all reviews are approved, and each release manifest binds the final source SHA, image, seven-row migration ledger, CycloneDX and SPDX digests, scan-report digest, scanner/policy identity and vulnerability-database provenance. It does not authorize a registry promotion or deployment to `awang` or any production host.
