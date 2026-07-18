# CRM Migration Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the source-neutral, checksum-idempotent migration control plane required to import Salam CRM JSON, Tasha SQLite, Niagawan CSV, and Barakah Sheet snapshots without guessing mappings, losing lineage, or permitting dual writable authority.

**Architecture:** Add the forward-compatible `0002_migration_platform.sql` control-plane migration, the narrowly scoped `0003_reconciliation_bytewise_order.sql` locale-independence correction, the `0004_membership_user_identity_guard.sql` immutable-provenance guard, the `0005_reconciliation_typed_result_truth.sql` database truth constraint, the `0006_reconciliation_finite_amounts.sql` non-finite numeric guard, and a separate Drizzle migration schema. The control plane registers source/domain authority scopes and immutable transform versions, records artifact checksums, stages protected row evidence, quarantines ambiguous/invalid rows, applies approved rows through canonical transactional writers, records source-to-target lineage, reconciles typed metrics, and permits one-way signed authority transitions. Source adapters remain separate sub-projects and consume these contracts.

**Tech Stack:** PostgreSQL 16.14, Drizzle ORM 0.45.2, TypeScript 6.0.3, Zod 4.4.3, Node.js streams/crypto, Vitest 4.1.10, and the existing checksum-locked migration runner.

## Global Constraints

- Use only synthetic fixtures in this plan. Real JSON, SQLite, CSV, Sheet exports, customer identifiers, amounts, tokens, and source object paths stay outside Git.
- Every applied migration is checksum-frozen. Do not rename, drop, reinterpret, or edit an earlier column, constraint, function contract, or migration byte. Any correction is a separately reviewed forward migration.
- A source artifact is immutable and addressed by SHA-256 plus protected object reference. General JSON columns may contain redacted metadata only, never raw PII payloads.
- Every registered source in PRD 1.8 is business-unit scoped. `business_unit_id` is non-null on every business-unit-owned control-plane row, so composite tenant foreign keys cannot be bypassed through PostgreSQL `MATCH SIMPLE` null behavior. The sole organisation-wide exception is the authority-transition group header, whose complete child set binds every affected business unit and domain.
- The exact same source checksum plus transform version plus execution mode is a replay and returns the original batch. A live batch is a distinct, lineage-bound promotion of a completed dry run for the same source/transform; reprocessing with a different transform requires explicit repair lineage and reason.
- A quarantined, rejected, unsigned, unreconciled, or partially hidden row cannot mutate canonical business tables.
- Canonical mutation, source-to-target lineage, audit, and outbox evidence commit in one PostgreSQL transaction.
- No source adapter owns a database connection or writes canonical tables directly.
- Authority is explicit in one durable domain-authority head per `(organisation, business unit, domain)`, separate from source archival. It can advance from legacy/external authority to shadow read and then terminal canonical writable. Archiving the source scope never releases canonical authority, and no command can regress or represent dual write.
- This plan makes the schema RLS-ready but does not claim production RLS. Database roles/policies require the separate identity/RLS plan and `D-19` approval.

---

## Task 1: Lock the additive migration contract

**Files:**

- Create: `db/migrations/0002_migration_platform.sql`
- Modify: `src/server/db/migration-manifest.ts`
- Modify: `src/server/db/migration-manifest.test.ts`
- Modify: `src/server/db/migrate.ts`
- Create: `tests/integration/migration-platform-schema.test.ts`
- Modify: `tests/integration/migration-runner.test.ts`

- [ ] Write a failing manifest test that expects `EXPECTED_MIGRATIONS` to contain `0001_foundation.sql` followed by `0002_migration_platform.sql`.

```ts
expect(EXPECTED_MIGRATIONS.map(({ filename }) => filename)).toEqual([
  "0001_foundation.sql",
  "0002_migration_platform.sql",
]);
```

- [ ] Run `pnpm exec vitest run src/server/db/migration-manifest.test.ts`.

Expected: FAIL because `0002_migration_platform.sql` is absent from the reviewed manifest.

- [ ] Write `migration-platform-schema.test.ts` first. It must query `information_schema`, `pg_constraint`, `pg_indexes`, and `pg_trigger` and expect all twelve tables, tenant columns, named unique/check constraints, queue indexes, append-only guards, and version triggers.

The exact table contract is:

| Table | Required identity and workflow columns |
|---|---|
| `migration_sources` | `id`, `organization_id`, `business_unit_id`, `source_key`, `source_kind`, `source_mode`, `owner_membership_id`, `status`, `version`, timestamps |
| `migration_source_scopes` | `id`, `organization_id`, `business_unit_id`, `migration_source_id`, `domain_key`, `canonical_target`, `transition_mode`, `source_status`, `version`, timestamps |
| `migration_domain_authorities` | `id`, `organization_id`, `business_unit_id`, `domain_key`, `canonical_target`, `authority_state`, nullable `authority_source_scope_id`, `version`, timestamps |
| `source_authority_transition_groups` | caller-stable `id`, `organization_id`, `idempotency_key`, `group_size`, `group_sha256`, `plan_artifact_ref`, `plan_sha256`, server-derived `effective_at`, `approved_by_membership_id`, `approval_reason`, `created_at` |
| `source_authority_transitions` | `id`, `organization_id`, `business_unit_id`, `transition_group_id`, `domain_authority_id`, nullable `from_source_scope_id`, nullable `to_source_scope_id`, `from_state`, `to_state`, nullable `write_frozen_at`, nullable `final_batch_id`, nullable `final_cutoff_at`, `created_at` |
| `transform_versions` | `id`, `organization_id`, `business_unit_id`, `migration_source_id`, `version_no`, `source_schema_version`, `mapping_artifact_ref`, `mapping_sha256`, `release_manifest_ref`, `release_manifest_sha256`, `transform_release_sha256`, `rationale`, nullable `repair_of_transform_id`, `approved_by_membership_id`, `approved_at`, `created_at` |
| `import_batches` | `id`, `organization_id`, `business_unit_id`, `migration_source_id`, `transform_version_id`, nullable `validated_dry_run_batch_id`, nullable `repair_of_batch_id`, `protected_artifact_ref`, `source_sha256`, `size_bytes`, `captured_at`, `cutoff_at`, `schema_version`, `status`, `dry_run`, non-null default-zero `total_row_count`, `staged_row_count`, `valid_row_count`, `rejected_row_count`, `quarantined_row_count`, `hidden_row_count`, `approved_row_count`, `imported_row_count`, `no_op_row_count`, nullable `validated_by_membership_id`, nullable `validated_at`, nullable `approved_by_membership_id`, nullable `approved_at`, nullable `approval_mode`, nullable `approval_reason`, nullable `applied_by_membership_id`, nullable `apply_run_id`, nullable `apply_lease_expires_at`, nullable `apply_started_at`, nullable `applied_at`, nullable `operator_reason`, nullable `failure_code`, `version`, timestamps |
| `import_rows` | `id`, `organization_id`, `business_unit_id`, `batch_id`, `source_row_key`, nullable `row_number`, `source_object_type`, nullable `source_record_id`, `source_locator`, `row_sha256`, `raw_evidence_ref`, nullable `normalized_evidence_ref`, nullable `normalized_sha256`, `outcome`, nullable `error_code`, redacted `error_metadata`, nullable `resolved_link_id`, `version`, timestamps |
| `legacy_object_links` | `id`, `organization_id`, `business_unit_id`, `migration_source_id`, `import_row_id`, `source_object_type`, `source_row_key`, `link_version`, nullable `supersedes_link_id`, `destination_entity_type`, `destination_entity_id`, nullable `correction_reason`, `created_by_membership_id`, `created_at` |
| `quarantine_items` | `id`, `organization_id`, `business_unit_id`, `import_row_id`, `reason_code`, redacted `reason_metadata`, `status`, nullable `resolution`, nullable `resolved_by_membership_id`, nullable `resolved_at`, nullable `resolution_reason`, `version`, timestamps |
| `reconciliation_runs` | `id`, `organization_id`, `business_unit_id`, `batch_id`, `run_no`, `status`, `plan_artifact_ref`, `plan_sha256`, canonical `required_checks jsonb`, `required_checks_sha256`, `required_check_count`, `passed_check_count`, `failed_check_count`, nullable `signed_by_membership_id`, nullable `signed_at`, `version`, timestamps |
| `reconciliation_results` | `id`, `organization_id`, `business_unit_id`, `run_id`, `check_kind`, `check_key`, `scope_key`, nullable source/target count, nullable source/target `numeric(38,12)` amount, nullable `measure_unit`, nullable `decimal_scale`, nullable source/target 32-byte checksum, `passed`, redacted `evidence_metadata`, `created_at` |

Required database rules:

- `migration_sources` unique on `(organization_id, business_unit_id, source_key)`. Its owner uses `(organization_id, owner_membership_id) → memberships`; the service verifies that membership is organisation-wide or belongs to the same BU.
- `migration_source_scopes` unique on `(organization_id, business_unit_id, migration_source_id, domain_key)`; `domain_key` uses lowercase dotted identifiers such as `printing.finance`; `canonical_target` names the owned module; `transition_mode` is `ONE_TIME_CUTOVER` or `RECURRING_EXTERNAL_SNAPSHOT`; `source_status` is `REGISTERED`, `ACTIVE_AUTHORITY`, or `ARCHIVED_READ_ONLY`.
- `migration_domain_authorities` is the single unique row for `(organization_id, business_unit_id, domain_key)`. `LEGACY_WRITABLE`, `EXTERNAL_SYSTEM_AUTHORITY`, and `SHADOW_READ` require a same-tenant/BU `authority_source_scope_id`; `CANONICAL_WRITABLE` requires it to be null and is terminal. `SHADOW_READ` means the referenced source remains the sole writer and canonical data is verification-only. Archiving a source changes only `migration_source_scopes.source_status`; it never deletes or downgrades this durable head.
- A named deferred constraint trigger enforces that a referenced authority scope has the same organisation, BU, domain, canonical target, and `ACTIVE_AUTHORITY` status; no active head may reference a `REGISTERED`/archived scope. Source archival is allowed only in the same transaction that makes the durable head canonical or when the scope is not referenced by any head.
- `source_authority_transition_groups` is the append-only group header, unique on `(organization_id, id)` and separately on `(organization_id, idempotency_key)`. This makes both group ID and idempotency key durable at group scope, so concurrent or later disjoint member sets cannot reuse either value. A named deferred constraint trigger requires exactly `group_size` distinct child members at commit. Replay with the same key and identical canonical group digest returns the complete stored group without mutation; a different digest conflicts.
- `source_authority_transitions` is append-only and unique on `(organization_id, transition_group_id, domain_authority_id)`. Every child has an always-enforced composite organisation foreign key to its group header and a composite organisation/BU foreign key to its authority head. The service recomputes the header digest from the exact sorted child intent before insert; the deferred completeness trigger prevents partial groups. Canonical transition requires a final batch, derived cutoff, write-freeze time, organisation-wide approver, server-derived effective time, and a reviewed group plan.
- `transform_versions` unique on `(organization_id, business_unit_id, migration_source_id, version_no)` and guarded append-only after approval. The protected mapping artifact/digest, signed release-manifest reference/digest that binds that exact mapping/schema/release, rationale, approval, and repair lineage must reproduce the transformation.
- `import_batches` unique on `(organization_id, business_unit_id, migration_source_id, source_sha256, transform_version_id, dry_run)` and has a composite FK `(organization_id, business_unit_id, migration_source_id, transform_version_id) → transform_versions` backed by a matching unique key. Checks enforce 32-byte SHA-256, `size_bytes >= 0`, non-negative named counters, lifecycle-specific counter consistency, and a reason when `repair_of_batch_id` is set. A live row requires `validated_dry_run_batch_id` to reference a `DRY_RUN_COMPLETE` row with the exact same organisation, BU, source, checksum, and transform; a dry-run row forbids that column.
- Batch approval checks require validator/validation time before approval; `FULL`/`PARTIAL`, positive `approved_row_count`, approver membership, approval time, and reason are all-or-none; dry runs forbid every approval/apply field.
- Apply claim fields are all null before `APPLYING`. `APPLYING` requires actor, run ID, start time, and a non-null lease timestamp; the persisted lease may be expired after a crash, while service logic requires a newly server-derived future lease before any chunk mutates data. `APPLIED` additionally requires `applied_at` and final counter equality. Run ID/actor/start time are immutable after the first claim, while only the lease, counters, and version may advance during owned chunks.
- `import_rows` unique on `(organization_id, batch_id, source_row_key)` plus a partial unique index for non-null `(organization_id, batch_id, row_number)`; outcome/error checks require an error for `REJECTED`/`QUARANTINED`/`HIDDEN` and forbid one for `VALID`/`IMPORTED`/`NO_OP_REPLAY`.
- `legacy_object_links` is append-only and unique on `(organization_id, business_unit_id, migration_source_id, source_object_type, source_row_key, link_version)`. First links have version 1; a correction references the current link through unique `supersedes_link_id`, increments exactly once, and records a reason/actor. The current link is the chain head with no successor, preventing concurrent repair forks without mutating history.
- `quarantine_items` has one open item per `(organization_id, import_row_id, reason_code)` and resolution-state consistency.
- `reconciliation_runs` unique on `(organization_id, batch_id, run_no)`. Its protected plan artifact is independently hashed before the transaction; the exact sorted, duplicate-free required tuple set `(check_kind, check_key, scope_key, measure_unit, decimal_scale)` and its digest are immutable. A run cannot be signed unless the result tuple set equals that exact requirement set and every required check passes.
- `reconciliation_results` uses `UNIQUE NULLS NOT DISTINCT` on the complete `(organization_id, run_id, check_kind, check_key, scope_key, measure_unit, decimal_scale)` identity and is append-only after its run is signed. The requirements verifier rejects duplicate complete identities before persistence.
- Reconciliation kind checks require the corresponding typed values: counts for `COUNT`; amounts, `measure_unit`, and `decimal_scale` for `AMOUNT`/`FINANCE_BALANCE`; 32-byte digests for `CHECKSUM`; and redacted structured evidence for the remaining kinds. Source and target fields must be either both present or both absent.
- Every control-plane row has non-null `organization_id`; every BU-owned row also has non-null `business_unit_id`. Parent references use always-enforced organisation and matching composite BU foreign keys. BU-row actor references use `(organization_id, membership_id) → memberships`; a named constraint trigger plus the service policy requires `membership.business_unit_id IS NULL OR membership.business_unit_id = row.business_unit_id`. The organisation-wide transition-group approver must have `membership.business_unit_id IS NULL` and the cross-unit capability, so a BU-local membership cannot approve the simultaneous cutover.
- Queue indexes cover non-terminal batch status, non-terminal row outcome, open quarantine, and unsigned/failed reconciliation.

Use database checks for the exact state vocabularies:

```sql
CONSTRAINT migration_sources_kind_valid CHECK (
  source_kind IN ('SALAM_CRM_JSON', 'TASHA_SQLITE', 'NIAGAWAN_CSV', 'BARAKAH_SHEET')
),
CONSTRAINT migration_sources_mode_valid CHECK (
  source_mode IN ('ONE_TIME_MIGRATION', 'RECURRING_READ_ONLY_SNAPSHOT')
),
CONSTRAINT migration_source_scopes_status_valid CHECK (
  source_status IN ('REGISTERED', 'ACTIVE_AUTHORITY', 'ARCHIVED_READ_ONLY')
),
CONSTRAINT migration_domain_authorities_state_valid CHECK (
  authority_state IN (
    'LEGACY_WRITABLE',
    'EXTERNAL_SYSTEM_AUTHORITY',
    'SHADOW_READ',
    'CANONICAL_WRITABLE'
  )
)
```

- [ ] Run the schema test against the isolated database before creating `0002`:

```bash
TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform \
pnpm exec vitest run --config vitest.integration.config.ts \
tests/integration/migration-platform-schema.test.ts
```

Expected: FAIL because `migration_sources` does not exist.

- [ ] Implement the complete SQL contract, including `crm_touch_version` triggers and `crm_block_mutation` guards where specified.
- [ ] Compute `shasum -a 256 db/migrations/0002_migration_platform.sql`, register the exact digest in `EXPECTED_MIGRATIONS`, and never edit the applied file after review.
- [ ] Introduce a module-private `unique symbol` brand and a `ReviewedMigration` type that can be produced only by `loadReviewedMigrationSet()` after it reads the locked manifest entry, streams the named repository file, and verifies filename, byte length, and SHA-256. `applyReviewedMigration(transaction, migration: ReviewedMigration)` must accept no string/SQL overload. The production runner calls it for every pending reviewed value and inserts the ledger row in the same transaction.
- [ ] Extend the runner integration test by mocking the locked manifest module before dynamically importing the runner and pointing it at a temporary two-file migration directory whose second manifest-verified file creates a table and then raises an exception. Do not add a production test factory or arbitrary-SQL export. Assert both the second table and its ledger row are absent. Also run two migration runners concurrently and assert one exact two-row ledger after both complete. Applying `0001` + `0002` twice must remain an exact no-op.
- [ ] Run the manifest, schema, and runner tests. Expected: PASS.
- [ ] Commit: `feat(db): add migration control-plane schema`

## Task 2: Add the typed Drizzle boundary

**Files:**

- Create: `src/server/db/migration-schema.ts`
- Modify: `src/server/db/client.ts`
- Create: `tests/integration/migration-schema-parity.test.ts`

- [ ] Write a failing parity test that compares Drizzle-exposed table/column names with the twelve `0002` tables in PostgreSQL.
- [ ] Run the parity test. Expected: FAIL because `migration-schema.ts` does not exist.
- [ ] Define and export the exact shared types:

```ts
export type SourceKind =
  | "SALAM_CRM_JSON"
  | "TASHA_SQLITE"
  | "NIAGAWAN_CSV"
  | "BARAKAH_SHEET";

export type SourceMode =
  | "ONE_TIME_MIGRATION"
  | "RECURRING_READ_ONLY_SNAPSHOT";

export type AuthorityState =
  | "LEGACY_WRITABLE"
  | "EXTERNAL_SYSTEM_AUTHORITY"
  | "SHADOW_READ"
  | "CANONICAL_WRITABLE";

export type SourceScopeStatus =
  | "REGISTERED"
  | "ACTIVE_AUTHORITY"
  | "ARCHIVED_READ_ONLY";

export type ImportBatchStatus =
  | "REGISTERED"
  | "STAGED"
  | "VALIDATED"
  | "DRY_RUN_COMPLETE"
  | "APPROVED"
  | "APPLYING"
  | "APPLIED"
  | "RECONCILED"
  | "REJECTED"
  | "FAILED";

export type ImportRowOutcome =
  | "STAGED"
  | "VALID"
  | "IMPORTED"
  | "NO_OP_REPLAY"
  | "REJECTED"
  | "QUARANTINED"
  | "HIDDEN";
```

- [ ] Model all columns, default values, nullable behavior, and composite keys for all twelve tables. Keep this schema separate from `src/server/db/schema.ts` so migration-only tables do not expand the application domain import surface.
- [ ] Pass a merged schema into Drizzle in `client.ts`:

```ts
import * as coreSchema from "./schema";
import * as migrationSchema from "./migration-schema";

const schema = { ...coreSchema, ...migrationSchema };
```

- [ ] Run parity, typecheck, and the existing DB client tests. Expected: PASS.
- [ ] Commit: `feat(db): expose typed migration schema`

## Task 3: Implement pure lifecycle and authority policy

**Files:**

- Create: `src/domain/migration/types.ts`
- Create: `src/domain/migration/batch-lifecycle.ts`
- Create: `src/domain/migration/batch-lifecycle.test.ts`

- [ ] Write table-driven failing tests for every permitted batch transition, every forbidden skip/regression, dry-run-to-live promotion, partial approval, and authority transition.

```ts
export interface BatchValidationSummary {
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  quarantinedRows: number;
  hiddenRows: number;
}

export function assertImportBatchTransition(
  from: ImportBatchStatus,
  to: ImportBatchStatus,
): void;

export function assertPartialApprovalAllowed(
  summary: BatchValidationSummary,
): void;

export function assertAuthorityTransition(
  input: {
    sourceMode: SourceMode;
    from: AuthorityState;
    to: AuthorityState;
    cutoverApproved: boolean;
  },
): void;
```

Required behavior:

- A live batch follows `REGISTERED → STAGED → VALIDATED → APPROVED → APPLYING → APPLIED → RECONCILED`.
- A dry-run batch follows `REGISTERED → STAGED → VALIDATED → DRY_RUN_COMPLETE` and can never reach `APPROVED` or mutate canonical tables.
- `DRY_RUN_COMPLETE`, `REJECTED`, and `FAILED` are terminal.
- Live execution never changes a dry-run row. It creates a separate `dry_run=false` batch whose `validated_dry_run_batch_id` points to the completed dry run with an identical source, checksum, transform, organisation, and BU.
- A retry resumes only from the persisted state and never moves backwards.
- Approval fails when `hiddenRows > 0`, totals are inconsistent, or quarantined rows lack an explicit reviewed disposition.
- A one-time domain head may move `LEGACY_WRITABLE → SHADOW_READ → CANONICAL_WRITABLE`. A recurring read-only snapshot may remain `EXTERNAL_SYSTEM_AUTHORITY`, then move `EXTERNAL_SYSTEM_AUTHORITY → SHADOW_READ → CANONICAL_WRITABLE` only when the external system is being retired.
- `CANONICAL_WRITABLE` is terminal. The linked source scope is archived separately after cutover; source archival cannot change the durable domain head. Moving to canonical requires `cutoverApproved=true`. Any regression to source authority or representation of dual write throws `MigrationPolicyError`.

- [ ] Run `pnpm exec vitest run src/domain/migration/batch-lifecycle.test.ts` before implementation. Expected: FAIL with missing exports.
- [ ] Implement the smallest pure policy that passes all cases, then refactor to immutable transition maps.
- [ ] Run the focused test, `pnpm typecheck`, and `pnpm lint`. Expected: PASS.
- [ ] Commit: `feat(migration): enforce batch and authority lifecycle`

## Task 4: Register sources, transforms, and protected artifacts

**Files:**

- Create: `src/server/migration/contracts.ts`
- Create: `src/server/migration/artifact-checksum.ts`
- Create: `src/server/migration/register-source.ts`
- Create: `src/server/migration/register-transform.ts`
- Create: `tests/integration/migration-source-registration.test.ts`

- [ ] Write failing tests for streamed checksum/size, duplicate source keys, cross-tenant references, immutable approved transforms, a signed release paired with the wrong mapping, checksum mismatch, placeholder/unsafe object references, a second source trying to claim an existing domain, canonical head surviving source archival, same-cutoff batch binding, three-BU atomic group success/one-member rollback, missing group-plan member, future/not-yet-open and expired execution windows, concurrent disjoint groups reusing one group ID or idempotency key, authority-switch lost-response replay/conflicting idempotency-key reuse, concurrent new-domain registration and final-delta registration/apply versus cutover, and authority transition audit/outbox atomicity.
- [ ] Run `TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migration-source-registration.test.ts`. Expected: FAIL because the registration services and contracts do not exist.
- [ ] Define these contracts exactly:

```ts
export interface RegisteredSourceArtifact {
  objectRef: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
  capturedAt: Date;
  cutoffAt: Date;
  schemaVersion: string;
}

export interface SourceArtifactStore {
  open(ref: string): AsyncIterable<Uint8Array>;
}

export interface ReviewedTransformRelease {
  manifestRef: string;
  manifestSha256: Uint8Array;
  mappingArtifactRef: string;
  mappingSha256: Uint8Array;
  sourceSchemaVersion: string;
  releaseSha256: Uint8Array;
  gitCommitSha: string;
  signatureKeyId: string;
}

export interface ReviewedTransformReleaseRegistry {
  getReviewedRelease(manifestRef: string): Promise<ReviewedTransformRelease>;
}

export interface MigrationActor {
  userId: string;
  organizationId: string;
  activeMembershipId: string;
  businessUnitId: string;
  capabilities: readonly string[];
}

export interface RegisterMigrationSourceInput {
  businessUnitId: string;
  sourceKey: string;
  sourceKind: SourceKind;
  sourceMode: SourceMode;
  ownerMembershipId: string;
  domains: readonly {
    domainKey: string;
    canonicalTarget: string;
    transitionMode: "ONE_TIME_CUTOVER" | "RECURRING_EXTERNAL_SNAPSHOT";
    initialAuthorityState: "LEGACY_WRITABLE" | "EXTERNAL_SYSTEM_AUTHORITY";
  }[];
}

export interface RegisterTransformVersionInput {
  businessUnitId: string;
  migrationSourceId: string;
  versionNo: number;
  sourceSchemaVersion: string;
  mappingArtifactRef: string;
  expectedMappingSha256: Uint8Array;
  releaseManifestRef: string;
  expectedReleaseManifestSha256: Uint8Array;
  expectedReleaseSha256: Uint8Array;
  rationale: string;
  repairOfTransformId: string | null;
}

export interface AuthorityTransitionGroupMemberInput {
  domainAuthorityId: string;
  toState: AuthorityState;
  writeFrozenAt: Date | null;
  finalBatchId: string | null;
  expectedVersion: number;
}

export interface AuthorityTransitionGroupInput {
  cutoverGroupId: string;
  planArtifactRef: string;
  expectedPlanSha256: Uint8Array;
  members: readonly AuthorityTransitionGroupMemberInput[];
  approvalReason: string;
  idempotencyKey: string;
}

export interface VerifiedAuthorityTransitionPlan {
  artifactRef: string;
  planSha256: Uint8Array;
  organizationId: string;
  notBefore: Date;
  expiresAt: Date;
  requiredMembers: readonly {
    businessUnitId: string;
    domainAuthorityId: string;
    domainKey: string;
    toState: AuthorityState;
    writeFrozenAt: Date | null;
    finalBatchId: string | null;
  }[];
}

export interface AuthorityTransitionPlanVerifier {
  verify(
    artifactRef: string,
    expectedPlanSha256: Uint8Array,
  ): Promise<VerifiedAuthorityTransitionPlan>;
}

export async function computeSha256(
  source: AsyncIterable<Uint8Array>,
): Promise<{ sha256: Uint8Array; sizeBytes: bigint }>;

export async function registerMigrationSource(
  actor: MigrationActor,
  input: RegisterMigrationSourceInput,
): Promise<string>;

export async function registerTransformVersion(
  actor: MigrationActor,
  input: RegisterTransformVersionInput,
  artifactStore: SourceArtifactStore,
  releaseRegistry: ReviewedTransformReleaseRegistry,
): Promise<string>;

export async function transitionSourceAuthorityGroup(
  actor: MigrationActor,
  input: AuthorityTransitionGroupInput,
  planVerifier: AuthorityTransitionPlanVerifier,
): Promise<{
  cutoverGroupId: string;
  transitionIds: readonly string[];
  effectiveAt: Date;
  replayed: boolean;
}>;
```

- [ ] Validate `objectRef` as an opaque provider-specific protected reference; reject `http:`, `https:`, `file:`, path traversal, query strings, and embedded credentials.
- [ ] Recompute both source and mapping-artifact checksums by streaming from `SourceArtifactStore` before their database transaction. Do not trust caller-supplied hash or size. Resolve the reviewed release, verify its signed manifest and commit, and require the manifest's reference/digest, mapping reference/digest, source schema version, and release digest to equal the streamed/declared values. Persist both manifest fields. A valid release signature can never be paired with another mapping.
- [ ] Accept `MigrationActor` only from trusted server authentication/service-identity resolution; never accept actor or membership IDs from a request body. Enforce the operation's capability and same-tenant membership before every mutation.
- [ ] Source registration takes `FOR SHARE` on the organisation row, then creates or links a `migration_source_scope`; only the first approved source may initialize a missing domain head. A later scope starts `REGISTERED` and cannot displace an existing head. The group transition takes `FOR UPDATE` on the same organisation row before inventory validation, then locks every durable head in sorted order with `FOR UPDATE`. This freezes the authority-head inventory while it proves the signed plan enumerates the complete required cross-BU set. Persist one `source_authority_transition_groups` header plus all member transitions, head/source-status updates, audit, and outbox events in that transaction. Insert/replay is serialized by the two group-level unique keys, and the deferred child-count trigger rejects incomplete groups. Any member failure rolls back the header and whole member set. Lost-response replay returns the stored group only when its canonical digest is identical; disjoint concurrent or later reuse of the group ID/idempotency key returns `409`.
- [ ] Require `migration.source.manage` for source/transform registration and `migration.authority_switch` for group transitions. Before the transaction, verify the protected signed plan and exact duplicate-free member-key set. The caller supplies no effective time: after all locks and rechecks succeed, derive one `effective_at` from `transaction_timestamp()` and require it to fall inside the signed inclusive `[notBefore, expiresAt]` window. This prevents a future-dated plan from changing authority early and an expired plan from executing late.
- [ ] A move to canonical is allowed only through the group command; the production plan must enumerate every required Salam Land, Bumi Hayat, and Barakah Emas domain head for the coordinated window. Lock each final batch, prove signed `RECONCILED`, derive `final_cutoff_at` from that batch (never the caller), require exact source/BU/domain membership, `writeFrozenAt <= batch.cutoffAt <= effectiveAt`, and reject any later/unresolved batch or delta through the effective time. All batch registration, staging, validation, approval, and apply claim/chunk/finalize transactions take `FOR SHARE` locks on the source's sorted domain heads and recheck source/head state; the cutover's `FOR UPDATE` locks therefore serialize the final exclusion check with every competing source mutation. A waiter that resumes after cutover must recheck and fail closed. `CANONICAL_WRITABLE` remains terminal even after source archival.
- [ ] Run the focused integration test. Expected after implementation: PASS.
- [ ] Commit: `feat(migration): register sources transforms and artifacts`

## Task 5: Make batch registration checksum-idempotent

**Files:**

- Create: `src/server/migration/register-batch.ts`
- Create: `tests/integration/import-batch-service.test.ts`

- [ ] Write failing concurrent tests for first dry-run registration, exact same-mode replay, live promotion from the completed matching dry run, missing/mismatched dry-run lineage, checksum mismatch, transform mismatch without repair lineage, valid repair lineage, wrong tenant, artifact cutoff before capture, and a registration racing the source's canonical cutover.

```ts
export interface RegisterImportBatchInput {
  businessUnitId: string;
  migrationSourceId: string;
  transformVersionId: string;
  protectedArtifactRef: string;
  expectedSourceSha256: Uint8Array;
  expectedSizeBytes: bigint;
  capturedAt: Date;
  cutoffAt: Date;
  schemaVersion: string;
  dryRun: boolean;
  validatedDryRunBatchId: string | null;
  repairOfBatchId: string | null;
  operatorReason: string | null;
}

export async function registerImportBatch(
  actor: MigrationActor,
  input: RegisterImportBatchInput,
  artifactStore: SourceArtifactStore,
): Promise<{ batchId: string; replayed: boolean }>;
```

Required semantics:

- first checksum/transform registration inserts one `REGISTERED` batch and one audit event;
- concurrent exact registration in the same `dryRun` mode returns the same `batchId` and `replayed: true` without a second audit/outbox effect;
- live registration creates a separate batch only when `validatedDryRunBatchId` is terminal `DRY_RUN_COMPLETE` and its source, transform, source checksum, organisation, and BU exactly match; replaying the live registration returns that live batch, never the dry-run batch;
- the same artifact with a new transform is rejected unless `repairOfBatchId` references the prior batch and `operatorReason` is non-empty;
- a repair batch never overwrites, deletes, or changes prior row/link/reconciliation evidence;
- a dry-run batch is permanently marked `dry_run=true`, ends at `DRY_RUN_COMPLETE`, and is rejected by every canonical writer;
- `cutoffAt <= capturedAt` and `sizeBytes`/SHA-256 must match the independently streamed artifact.
- before insert or conflict reread, lock every domain-authority head for the source in sorted order with `FOR SHARE`, then recheck organisation/BU, active source scope, head ownership, and non-canonical state. The cutover uses conflicting `FOR UPDATE` locks; after waiting, registration must recheck and reject an archived/canonical source instead of inserting a post-cutover batch.

- [ ] Run the focused integration test before implementation. Expected: FAIL because `registerImportBatch` is missing.
- [ ] Implement with the database unique key and a conflict reread; do not rely on an in-memory mutex.
- [ ] Make the test itself launch at least 20 concurrent registration attempts with `Promise.all`, then run the focused suite once. Expected: PASS; every attempt returns one batch ID and the database contains one batch/audit/outbox effect.
- [ ] Commit: `feat(migration): register replay-safe import batches`

## Task 6: Stage rows and quarantine unsafe records

**Files:**

- Create: `src/server/migration/stage-batch.ts`
- Create: `src/server/migration/quarantine.ts`
- Create: `tests/integration/import-row-service.test.ts`

- [ ] Write failing tests for streaming batches, duplicate source keys, duplicate row numbers, invalid SHA length, caller digest mismatch, raw evidence not bound to the registered batch/locator, raw payload leakage, deterministic replay, cross-tenant access, one-open-quarantine rule, resolution reason, and terminal batch protection.
- [ ] Run `TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform pnpm exec vitest run --config vitest.integration.config.ts tests/integration/import-row-service.test.ts`. Expected: FAIL because row staging/quarantine services do not exist.

```ts
export interface StagedSourceRow {
  sourceRowKey: string;
  rowNumber: bigint | null;
  sourceObjectType: string;
  sourceRecordId: string | null;
  sourceLocator: string;
  expectedRowSha256: Uint8Array;
  rawEvidenceRef: string;
}

export interface VerifiedRawEvidence {
  ref: string;
  sourceLocator: string;
  rowSha256: Uint8Array;
  batchSourceSha256: Uint8Array;
}

export interface RawEvidenceVerifier {
  verify(input: {
    batchArtifactRef: string;
    batchSourceSha256: Uint8Array;
    rawEvidenceRef: string;
    sourceLocator: string;
    expectedRowSha256: Uint8Array;
  }): Promise<VerifiedRawEvidence>;
}

export interface RowSummary {
  totalRows: number;
  stagedRows: number;
  validRows: number;
  rejectedRows: number;
  quarantinedRows: number;
  hiddenRows: number;
  importedRows: number;
  noOpRows: number;
}

export interface ResolveQuarantineInput {
  quarantineItemId: string;
  disposition: "APPROVE_ROW" | "REJECT_ROW";
  resolutionReason: string;
  correctedNormalizedEvidenceRef: string | null;
  expectedNormalizedSha256: Uint8Array | null;
  expectedItemVersion: number;
  expectedRowVersion: number;
}

export interface VerifiedNormalizedEvidence {
  ref: string;
  sha256: Uint8Array;
}

export interface NormalizedEvidenceVerifier {
  verify(
    ref: string,
    expectedSha256: Uint8Array | null,
  ): Promise<VerifiedNormalizedEvidence>;
}

export async function stageImportRows(
  actor: MigrationActor,
  batchId: string,
  rows: AsyncIterable<StagedSourceRow>,
  evidenceVerifier: RawEvidenceVerifier,
): Promise<RowSummary>;

export async function resolveQuarantineItem(
  actor: MigrationActor,
  input: ResolveQuarantineInput,
  evidenceVerifier: NormalizedEvidenceVerifier,
): Promise<void>;
```

- [ ] For each bounded chunk, lock/read the registered batch metadata, then outside the transaction make `RawEvidenceVerifier` stream and rehash the protected raw row evidence and prove its adapter-specific locator belongs to the exact registered batch artifact/checksum. Reopen a short transaction, recheck the batch reference/checksum/version, and persist only the verifier's digest/reference/locator. Caller hashes are comparison inputs, never authority.
- [ ] Every staging and quarantine-resolution transaction takes `FOR SHARE` locks on the source's sorted domain heads and rechecks that the source is still active and non-canonical before changing a row. Add a deterministic barrier test where cutover and a staging chunk race: one completes first, and the waiter rechecks state; no post-cutover row or partial authority group is committed.
- [ ] Retain deterministic row keys across repeated short transactions. A process crash may leave staged rows, but replay must converge without duplicates.
- [ ] Store only protected raw/normalized references plus redacted codes and metadata. Add a test that rejects values matching phone, email, credential, or full-record JSON patterns in redacted metadata.
- [ ] Quarantine resolution records reviewer, time, disposition, and reason; it never edits the original raw row checksum or evidence reference. `REJECT_ROW` forbids corrected evidence. `APPROVE_ROW` requires either an already verified normalized reference/digest on the row or a corrected protected reference that `NormalizedEvidenceVerifier` streams, rehashes, and validates against the adapter schema before the transaction.
- [ ] Run the focused integration test. Expected after implementation: PASS.
- [ ] Commit: `feat(migration): stage and quarantine protected rows`

## Task 7: Validate rows and approve an explicit batch subset

**Files:**

- Create: `src/server/migration/record-row-validation.ts`
- Create: `src/server/migration/validate-batch.ts`
- Create: `src/server/migration/complete-dry-run.ts`
- Create: `src/server/migration/approve-batch.ts`
- Create: `tests/integration/import-validation-approval.test.ts`

- [ ] Write failing tests for an unvalidated row, mismatched row checksum, missing normalized digest, open quarantine, hidden row, corrected quarantine evidence, full approval with rejected rows, partial approval without reason, zero-row approval, the same person validating/approving through different memberships, wrong capability/tenant, stale batch version, and valid full/partial approvals.
- [ ] Run `TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform pnpm exec vitest run --config vitest.integration.config.ts tests/integration/import-validation-approval.test.ts`. Expected: FAIL because validation/approval services do not exist.

```ts
export interface RowValidationDecision {
  outcome: "VALID" | "REJECTED" | "QUARANTINED" | "HIDDEN";
  normalizedEvidenceRef: string | null;
  normalizedSha256: Uint8Array | null;
  errorCode: string | null;
  redactedMetadata: Readonly<Record<string, unknown>>;
}

export interface RecordRowValidationInput {
  importRowId: string;
  expectedRowVersion: number;
  decision: RowValidationDecision;
}

export interface ValidateImportBatchInput {
  batchId: string;
  expectedBatchVersion: number;
}

export interface ApproveImportBatchInput {
  batchId: string;
  expectedBatchVersion: number;
  approvalMode: "FULL" | "PARTIAL";
  approvalReason: string | null;
}

export interface CompleteDryRunInput {
  batchId: string;
  expectedValidatedBatchVersion: number;
}

export async function recordImportRowValidation(
  actor: MigrationActor,
  input: RecordRowValidationInput,
  evidenceVerifier: NormalizedEvidenceVerifier,
): Promise<void>;

export async function validateImportBatch(
  actor: MigrationActor,
  input: ValidateImportBatchInput,
): Promise<BatchValidationSummary>;

export async function approveImportBatch(
  actor: MigrationActor,
  input: ApproveImportBatchInput,
): Promise<{ approvedRowCount: number; approvalMode: "FULL" | "PARTIAL" }>;

export async function completeDryRun(
  actor: MigrationActor,
  input: CompleteDryRunInput,
): Promise<BatchValidationSummary>;
```

- [ ] Require capability `migration.validate` for row decisions/final validation, `migration.review_quarantine` for quarantine resolution, and `migration.approve` for approval. Join memberships to compare underlying `user_id`; the approving person must differ from the validating person even if that user holds multiple organisation-wide/BU memberships. Retain both membership IDs as provenance.
- [ ] For a proposed `VALID` decision, use `NormalizedEvidenceVerifier` to stream/hash the protected normalized artifact and validate the adapter schema before opening the database transaction. Then lock one `STAGED` row, recheck its original SHA-256/evidence reference, and persist only the verified protected normalized reference/digest. `REJECTED`/`QUARANTINED`/`HIDDEN` require a stable code and redacted metadata.
- [ ] `resolveQuarantineItem` atomically closes the item and changes its row to `VALID` or `REJECTED` according to an explicit disposition, reviewer, reason, and expected versions. `APPROVE_ROW` must reuse an already verified normalized digest or verify corrected evidence through the same `NormalizedEvidenceVerifier` path before the transaction; it cannot promote a null/unverified digest. Original raw evidence and checksum remain immutable.
- [ ] `validateImportBatch` locks the batch, proves no `STAGED` row remains, computes every counter from rows rather than trusting the caller, records validator/time, and always moves `STAGED → VALIDATED`. For a dry run, `completeDryRun` separately rechecks the persisted validation summary, zero hidden/open-quarantine rows, expected version, and `dry_run=true`, then moves `VALIDATED → DRY_RUN_COMPLETE` without approval or canonical mutation.
- [ ] `approveImportBatch` rejects dry runs. `FULL` requires every row valid. `PARTIAL` requires zero open quarantine, at least one valid row, explicit rejected-row visibility, and a non-empty reason. Persist approval mode, approved count, approver/time/reason, audit, and outbox atomically.
- [ ] Row validation, batch validation, dry-run completion, and approval transactions take `FOR SHARE` locks on the source's sorted domain heads and recheck active/non-canonical authority. Add a barrier-based approval-versus-cutover test so a waiting approval cannot commit from a stale pre-cutover read.
- [ ] Run the focused integration test. Expected after implementation: PASS.
- [ ] Commit: `feat(migration): validate and approve import batches`

## Task 8: Apply approved rows with canonical lineage

**Files:**

- Create: `src/server/migration/apply-batch.ts`
- Create: `tests/integration/import-apply-service.test.ts`

- [ ] Write failing tests with a synthetic writer for unapproved batch, same-person approver/applier through different memberships, quarantined row, imported row, exact replay, initial claim version, crash/resume between rows, same-run same-identity renewal after lease expiry, stale original version after the first chunk, same-run concurrency, live competing run, expired cross-identity takeover rejection, cutover racing an apply chunk, writer failure rollback, audit/outbox failure rollback, duplicate lineage, stale row version, and wrong tenant.
- [ ] Run `TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform pnpm exec vitest run --config vitest.integration.config.ts tests/integration/import-apply-service.test.ts`. Expected: FAIL because the apply coordinator does not exist.

```ts
export interface ApprovedImportRow {
  id: string;
  organizationId: string;
  businessUnitId: string;
  batchId: string;
  migrationSourceId: string;
  sourceObjectType: string;
  sourceRowKey: string;
  sourceRecordId: string | null;
  normalizedEvidenceRef: string;
  normalizedSha256: Uint8Array;
  rowVersion: number;
  currentLinkId: string | null;
}

export interface ApprovedEvidenceLoader<TValue> {
  load(row: ApprovedImportRow): Promise<{
    value: Readonly<TValue>;
    normalizedSha256: Uint8Array;
  }>;
}

interface ApplyDependencies<TTransaction, TValue> {
  evidenceLoader: ApprovedEvidenceLoader<TValue>;
  writer: CanonicalImportWriter<TTransaction, TValue>;
}

export type ApplyImportBatchInput<TTransaction, TValue> =
  | (ApplyDependencies<TTransaction, TValue> & {
      mode: "START";
      batchId: string;
      expectedApprovedBatchVersion: number;
      applyRunId: string;
      leaseSeconds: number;
      chunkSize: number;
    })
  | (ApplyDependencies<TTransaction, TValue> & {
      mode: "RESUME";
      batchId: string;
      applyRunId: string;
      leaseSeconds: number;
      chunkSize: number;
    });

export interface ApplyBatchSummary {
  batchId: string;
  importedRows: number;
  noOpRows: number;
  rejectedRows: number;
  appliedAt: Date;
  replayed: boolean;
}

export interface CanonicalImportWriter<TTransaction, TValue> {
  apply(
    transaction: TTransaction,
    row: ApprovedImportRow,
    value: Readonly<TValue>,
  ): Promise<{
    outcome: "IMPORTED" | "NO_OP_REPLAY";
    destinationEntityType: string;
    destinationEntityId: string;
  }>;
}

export async function applyImportBatch<TTransaction, TValue>(
  actor: MigrationActor,
  input: ApplyImportBatchInput<TTransaction, TValue>,
): Promise<ApplyBatchSummary>;
```

- [ ] Before opening a database transaction, load the content-addressed normalized evidence through `ApprovedEvidenceLoader`, recompute its digest, validate its adapter schema, and deep-freeze the typed value. Never call object storage or another network service inside the business transaction.
- [ ] `START` performs one compare-and-set claim from `APPROVED → APPLYING`, checking `expectedApprovedBatchVersion`, bounded chunk/lease values, capability, and a new `applyRunId`; it joins membership users so the applying person/service differs from the approving person, then records the trusted actor membership, start time, and server-derived lease expiry. `RESUME` accepts only an `APPLYING` batch with the same run ID and same underlying user/service identity. When that owned lease has expired, `RESUME` locks the batch and atomically renews it from the database clock before work; this is an audited same-owner continuation, not a takeover. A competing run conflicts while the lease is live. An expired-lease takeover by another identity requires a separately audited `migration.apply_takeover` command and is deferred, so this plan fails closed instead of silently changing actors.
- [ ] Process rows in deterministic bounded chunks. For each row, load/verify outside the transaction, then use one short row-level canonical transaction. That transaction takes `FOR SHARE` locks on the source's sorted domain heads, rechecks active/non-canonical authority, requires `APPLYING`, the stable run ID/actor, and a newly live lease, then locks current batch/row versions, skips already committed rows, advances counters/version, and renews the lease without comparing the stale original approved version. Finalization uses the same authority locks. A cutover takes conflicting `FOR UPDATE` locks and rejects any unresolved `APPLYING` batch; whichever transaction waits must recheck and fail closed. A crash may leave an expired lease in `APPLYING`; same-run `RESUME` renews it and converges without duplicate writes. Row claims prevent two workers from applying the same row while allowing safe bounded parallelism within the owning run.
- [ ] Give the writer only the coordinator transaction, locked row metadata, and verified immutable value. It must not receive `DATABASE_URL`, `postgres.Sql`, an artifact store, or a second Drizzle client. When no approved-unapplied row remains, a final transaction verifies counters/lineage, records `applied_at`, and moves `APPLYING → APPLIED`; replay of an `APPLIED` batch returns its stored summary without mutation.
- [ ] In the same transaction: call the writer, insert or resolve `legacy_object_links`, set `resolved_link_id`, change the new row outcome, append an audit event, insert an outbox event, and advance counters/version.
- [ ] Exact checksum/transform batch replay returns the original stored batch summary with no row, link, audit, or outbox mutation. It never changes an original `IMPORTED` row to `NO_OP_REPLAY`.
- [ ] `NO_OP_REPLAY` is allowed only on a distinct approved repair row whose current link and canonical record already equal the verified normalized value. It points `resolved_link_id` to the current link and inserts no new link. A real correction appends a new link version that uniquely supersedes the prior chain head and records correction reason/actor.
- [ ] Run the focused integration test. Expected after implementation: PASS.
- [ ] Commit: `feat(migration): apply canonical rows with lineage`

## Task 9: Reconcile and sign imported evidence

**Files:**

- Create: `src/server/migration/reconcile-batch.ts`
- Create: `tests/integration/reconciliation-service.test.ts`

- [ ] Write failing tests for missing checks, a same-count-but-wrong check tuple, altered plan digest, failed checks, mismatched numeric scale, unsigned run, duplicate check scope, immutable signed result, the same person signing via a different membership, wrong signer tenant, and valid sign-off.
- [ ] Run `TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform pnpm exec vitest run --config vitest.integration.config.ts tests/integration/reconciliation-service.test.ts`. Expected: FAIL because the reconciliation services and signing function do not exist.

```ts
export type ReconciliationKind =
  | "COUNT"
  | "AMOUNT"
  | "CHECKSUM"
  | "UNIQUENESS"
  | "REFERENCE"
  | "TIMELINE"
  | "LOT_ALLOCATION"
  | "FINANCE_BALANCE"
  | "FILE"
  | "SAMPLE";

export interface ReconciliationRequirement {
  checkKind: ReconciliationKind;
  checkKey: string;
  scopeKey: string;
  measureUnit: string | null;
  decimalScale: number | null;
}

export interface VerifiedReconciliationPlan {
  artifactRef: string;
  planSha256: Uint8Array;
  requiredChecksSha256: Uint8Array;
  requiredChecks: readonly ReconciliationRequirement[];
}

export interface ReconciliationPlanVerifier {
  verify(
    artifactRef: string,
    expectedPlanSha256: Uint8Array,
  ): Promise<VerifiedReconciliationPlan>;
}

export interface ReconciliationResultInput extends ReconciliationRequirement {
  sourceCount: bigint | null;
  targetCount: bigint | null;
  sourceAmount: string | null;
  targetAmount: string | null;
  sourceChecksum: Uint8Array | null;
  targetChecksum: Uint8Array | null;
  passed: boolean;
  redactedEvidence: Readonly<Record<string, unknown>>;
}

export interface RecordReconciliationRunInput {
  batchId: string;
  runNo: number;
  planArtifactRef: string;
  expectedPlanSha256: Uint8Array;
  expectedBatchVersion: number;
  results: readonly ReconciliationResultInput[];
}

export interface SignReconciliationRunInput {
  runId: string;
  expectedRunVersion: number;
  approvalReason: string;
}

export async function recordReconciliationRun(
  actor: MigrationActor,
  input: RecordReconciliationRunInput,
  planVerifier: ReconciliationPlanVerifier,
): Promise<{ runId: string; passed: boolean }>;

export async function signReconciliationRun(
  actor: MigrationActor,
  input: SignReconciliationRunInput,
): Promise<void>;
```

- [ ] Compare money as fixed-precision decimal strings at the domain scale. Never convert a financial amount to JavaScript `number`.
- [ ] Before the transaction, make `ReconciliationPlanVerifier` stream and hash the protected, reviewed adapter plan, schema-validate it, normalize and bytewise-sort its duplicate-free requirement tuples, and compute the canonical requirement-set digest. Persist that exact set and both digests; never trust a caller-supplied count or tuple list. A run cannot pass by substituting another check with the same count.
- [ ] Implement a named database sign-off trigger/function that locks the run, expands the immutable JSONB requirement set, and proves exact set equality with the typed child result tuples before rejecting any missing/extra/failed/duplicate check. Verify expected version and tenant-scoped signer, then sign the run. A normal `CHECK` constraint or count comparison is not sufficient.
- [ ] Once signed, the run, plan fields, requirements, and all results are immutable. Set batch status to `RECONCILED` only in the same transaction that signs a fully passed run and writes audit/outbox evidence. Require `migration.sign`; join memberships and compare underlying `user_id` so the signer person differs from both `applied_by_membership_id` and `approved_by_membership_id`, even when one user has multiple memberships.
- [ ] Run the focused integration test. Expected after implementation: PASS.
- [ ] Commit: `feat(migration): reconcile and sign import batches`

## Task 9A: Make reconciliation ordering locale-independent

**Files:**

- Create: `db/migrations/0003_reconciliation_bytewise_order.sql`
- Modify: `src/server/db/migration-manifest.ts`
- Modify: `src/server/db/migration-manifest.test.ts`
- Modify: `tests/integration/migration-platform-schema.test.ts`
- Modify: `tests/production/runtime-smoke.mjs`

- [ ] Preserve `0002_migration_platform.sql` byte-for-byte at SHA-256 `2e8425ae8f551fc5b8c96466f36e917df118a12a18c66e69ec68800e73ec0e73`; never repair a deployed migration in place.
- [ ] Add a RED regression using two valid `COUNT` requirements whose keys are `a.a` and `a_`. UTF-8 byte order is `a.a`, `a_`, while `en_US.UTF-8` sorts them in the opposite order.
- [ ] Add only a `CREATE OR REPLACE FUNCTION crm_validate_reconciliation_requirements()` forward migration. Retain every existing validation/digest/duplicate rule and add explicit `COLLATE "C"` to all four text sort keys; retain numeric ordering for `decimal_scale`.
- [ ] Register and freeze `0003_reconciliation_bytewise_order.sql` at SHA-256 `46fb6ab301eb4362dc4c74c186a432e59bcf00736e78ab3d5d8ea8e7359885c4`, byte length `5,176`, and require the same ledger row in production runtime smoke.
- [ ] Prove the deployed function accepts UTF-8 byte order and rejects locale order, then run migration twice and prove all three ledger rows and timestamps are unchanged on replay.
- [ ] Independently review the function replacement against `0002` so no validation, immutability, sign-off, table, or trigger contract is weakened.
- [ ] Commit: `fix(migration): make reconciliation ordering bytewise`

## Task 9B: Make actor provenance and typed reconciliation truth immutable

**Files:**

- Create: `db/migrations/0004_membership_user_identity_guard.sql`
- Create: `db/migrations/0005_reconciliation_typed_result_truth.sql`
- Create: `db/migrations/0006_reconciliation_finite_amounts.sql`
- Modify: `src/server/db/migration-manifest.ts`
- Modify: `src/server/db/migration-manifest.test.ts`
- Modify: `tests/integration/migration-platform-schema.test.ts`
- Modify: `tests/integration/migration-source-registration.test.ts`
- Modify: `tests/production/runtime-smoke.mjs`

- [ ] Add a RED direct-SQL regression proving `memberships.user_id` cannot be reassigned. Membership IDs are permanent person-bound identities; transfers create a new membership instead of rewriting approval, apply, session, audit, or sign-off provenance.
- [ ] Add `0004_membership_user_identity_guard.sql` as a narrow `BEFORE UPDATE OF user_id` trigger using SQLSTATE `23514`; retain status, validity-window, and role administration workflows.
- [ ] Add RED direct-SQL regressions proving typed reconciliation truth is derived in both directions: unequal COUNT/amount/checksum values cannot claim `passed=true`, and equal values cannot claim `passed=false`.
- [ ] Add `0005_reconciliation_typed_result_truth.sql` as a validated additive CHECK constraint over `COUNT`, `AMOUNT`, `FINANCE_BALANCE`, and `CHECKSUM`. Existing and future rows must pass before the migration ledger advances.
- [ ] Add RED AMOUNT and FINANCE_BALANCE regressions for PostgreSQL `NaN`, `Infinity`, and `-Infinity`, then add `0006_reconciliation_finite_amounts.sql` as a validated additive CHECK. PostgreSQL numeric special values must never satisfy financial reconciliation equality.
- [ ] Register and checksum-lock both migrations, update runtime ledger evidence, and prove upgrade from the exact `0001`-`0003` prefix applies only `0004` and `0005` without changing earlier ledger timestamps.
- [ ] Update the verifier-race test that previously reassigned `memberships.user_id`: the database must now reject that mutation itself, while capability/status/validity races remain service recheck coverage.
- [ ] Independently review both forward migrations and rerun every migration/import/reconciliation integration suite.
- [ ] Commit: `fix(migration): lock provenance and reconciliation truth`

## Task 10: Add safe non-production inspection commands and synthetic contracts

**Files:**

- Create: `src/server/migration/cli.ts`
- Create: `src/server/migration/cli.test.ts`
- Create: `tests/fixtures/import/synthetic-source-manifest.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] Write failing CLI tests for `status` and `inspect-manifest`; invalid command, any mutating command, missing/unknown `DEPLOYMENT_ENVIRONMENT`, `DEPLOYMENT_ENVIRONMENT=production`, `NODE_ENV=production`, unsafe path, printed secret/PII, and non-zero failure code.
- [ ] Run `pnpm exec vitest run src/server/migration/cli.test.ts`. Expected: FAIL because the read-only CLI does not exist.
- [ ] Add read-only scripts that never accept local customer files or caller-supplied actor IDs:

```json
{
  "scripts": {
    "migration:inspect": "tsx src/server/migration/cli.ts inspect-manifest",
    "migration:status": "tsx src/server/migration/cli.ts status"
  }
}
```

- [ ] Fail closed unless `DEPLOYMENT_ENVIRONMENT` is explicitly one of `local`, `ci`, or `staging`, and reject whenever `NODE_ENV=production` regardless of that value. Missing, unknown, or `production` is denied before parsing a path or opening the database. Production mutation must later use authenticated command routes that derive `MigrationActor` from a named human/service identity, enforce scoped capabilities, use the approved narrow database role, and audit actor provenance; a command-line confirmation flag is never authorization.
- [ ] Make output JSON contain only batch/source IDs, state, counts, safe reason codes, timestamps, and correlation ID. It must never print database URLs, object-store credentials, raw evidence references, source rows, phone, email, national ID, payment narrative, or actor credentials.
- [ ] Add ignore rules for `*.sqlite`, `*.sqlite3`, `*.db`, source/export directories, CSV extracts, Sheet snapshots, and protected evidence caches. Keep the single named synthetic manifest explicitly allowlisted.
- [ ] Add a repository test that scans the synthetic fixture for realistic phone/email/credential patterns and confirms the data is unmistakably synthetic.
- [ ] Run the CLI tests and secret/fixture scan. Expected: PASS.
- [ ] Commit: `feat(migration): add safe operator workflow`

## Task 11: Verify the complete control plane

**Files:**

- Modify: `vitest.production-coverage.config.ts`
- Modify: `.github/workflows/quality.yml`
- Modify: `tests/ci/quality-workflow.test.ts`
- Modify only other files when evidence reveals a defect in a file owned by Tasks 1-10.

- [ ] Parse and assert the database name first, then reset and create only the isolated local database `crm_salam_codex_migration_platform`. Set both `DATABASE_URL` and `TEST_DATABASE_URL` to `postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform`; refuse any host other than loopback or database name that differs, and fail deployment preflight unless PostgreSQL reports `server_encoding = 'UTF8'`.
- [ ] Run `pnpm db:migrate` twice and query `schema_migrations`; expect exactly the seven reviewed filename/checksum rows with unchanged timestamps after the second run.
- [ ] Run focused unit and integration suites:

```bash
pnpm exec vitest run src/domain/migration/batch-lifecycle.test.ts src/server/migration/cli.test.ts

TEST_DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform \
pnpm exec vitest run --config vitest.integration.config.ts \
tests/integration/migration-platform-schema.test.ts \
tests/integration/migration-schema-parity.test.ts \
tests/integration/migration-runner.test.ts \
tests/integration/migration-source-registration.test.ts \
tests/integration/import-batch-service.test.ts \
tests/integration/import-row-service.test.ts \
tests/integration/import-validation-approval.test.ts \
tests/integration/import-apply-service.test.ts \
tests/integration/reconciliation-service.test.ts
```

- [ ] Extend `vitest.production-coverage.config.ts` to include the migration/import integration tests from the focused command, add the `server-only` test alias, and run database files serially. Move the workflow's apply-migrations step before production coverage. Keep the existing all-production-source floors and exclusions unchanged; do not exclude new migration services to make coverage green. Run `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm test:coverage:production`, and `pnpm test:db`. Expected: every gate passes with the migration services executed under coverage against the isolated database.
- [ ] Build, start, and smoke the production-like CRM artifact with the complete environment below. The build alone is not readiness evidence.

```bash
set -euo pipefail

export NODE_ENV=production
export DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_migration_platform
export TEST_DATABASE_URL="$DATABASE_URL"
export APP_URL=https://crm-ci.example.test
export AUTH_HASH_KEY=ci-auth-hash-key-0123456789abcdef
export OIDC_ISSUER=https://identity.example.test
export OIDC_CLIENT_ID=crm-ci
export OIDC_CLIENT_SECRET=ci-oidc-client-secret-0123456789abcdef
export OIDC_REDIRECT_URI=https://crm-ci.example.test/api/v1/auth/oidc/callback
export PRODUCT_SURFACE=crm
export DEPLOYMENT_ENVIRONMENT=ci
export CRM_DEMO_MODE=false

pnpm clean:next
pnpm build
node scripts/ci/run-next-runtime-smoke.mjs \
  --port 3401 \
  --log /tmp/crm-migration-runtime.log
```

Expected: runtime smoke passes and readiness returns `200` only while the database ledger exactly matches `0001` through `0007`.
- [ ] Extend `tests/ci/quality-workflow.test.ts` to require the UI-owned portable `run-next-runtime-smoke.mjs`, matching start/probe ports, explicit liveness/readiness success branches, and migration/runtime step ordering. Run `tests/ci/runtime-process.test.ts` on macOS locally and Linux CI; it must prove the Node detached process group and grandchild are terminated on success, startup failure, smoke failure, timeout, `SIGINT`, and `SIGTERM`. Expected: PASS and no failed smoke command can be masked by cleanup.
- [ ] Scan the full diff and newly introduced Git objects for source data, PII, credentials, database URLs with secrets, and unsafe archives.
- [ ] Request independent code review. Resolve every Critical or Important finding with a failing regression test before changing code.
- [ ] Commit any review-driven corrections separately, then push the verified branch.

Expected final result: the generic control-plane core is verified with synthetic data. It is not production-operable until the protected artifact/release registries, authenticated production command routes, narrow database roles/RLS, all four reviewed adapters, and their signed business mappings and reconciliation plans pass their separate entry gates.

## Deferred adapter plans and entry conditions

The following are separate implementation plans, not extra tasks in this file:

- Salam CRM JSON + Tasha SQLite reconciliation: requires signed final checksums/cutoffs, field/state mappings, a pinned read-only SQLite extraction method, and named review ownership for all identity candidates.
- Niagawan CSV: requires an approved sample/template/version, encoding, export cadence, amount/date rules, cutoff, and Bumi Hayat data owner.
- Barakah Sheet: requires the exact document, tab/range, schema watermark, formula-versus-value rule, cutoff, and Barakah data owner.
- RLS/database roles: requires the approved role matrix, transaction-local context and pool-reset design for application, worker, migration, reporting, support, monitoring, backup, and break-glass identities.

Until these entry conditions are met, adapters must fail closed with `MAPPING_NOT_APPROVED` or `SOURCE_NOT_REGISTERED`; they must never infer status, identity, financial, lot, printing, or gold rules.
