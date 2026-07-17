import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabaseConnection } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRuntimeConfigForTests } from "@/server/env";
import type { MigrationActor } from "@/server/migration/contracts";
import { approveImportBatch } from "@/server/migration/approve-batch";
import { completeDryRun } from "@/server/migration/complete-dry-run";
import {
  openQuarantineItem,
  resolveQuarantineItem,
  type NormalizedEvidenceVerifier,
} from "@/server/migration/quarantine";
import {
  recordImportRowValidation,
  type RowValidationDecision,
} from "@/server/migration/record-row-validation";
import { validateImportBatch } from "@/server/migration/validate-batch";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for import validation tests.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Import validation tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, { max: 20, prepare: false, onnotice: () => undefined });

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function protectedRef(label: string): string {
  return `protected://validation-tests/${label}/${randomUUID()}`;
}

const VALIDATE_CAPABILITY = "migration.validate";
const REVIEW_CAPABILITY = "migration.review_quarantine";
const APPROVE_CAPABILITY = "migration.approve";

interface Fixture {
  organizationId: string;
  businessUnitId: string;
  validatorUserId: string;
  validatorMembershipId: string;
  validatorActor: MigrationActor;
  validatorAlternateMembershipId: string;
  validatorAsApproverActor: MigrationActor;
  approverUserId: string;
  approverMembershipId: string;
  approverActor: MigrationActor;
  sourceId: string;
  scopeId: string;
  headId: string;
  batchId: string;
  rowIds: string[];
}

type SeedOutcome = "STAGED" | "VALID" | "REJECTED" | "QUARANTINED" | "HIDDEN";

async function seedFixture(
  outcomes: readonly SeedOutcome[] = ["STAGED"],
  dryRun = true,
): Promise<Fixture> {
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const validatorUserId = randomUUID();
  const validatorMembershipId = randomUUID();
  const validatorAlternateMembershipId = randomUUID();
  const approverUserId = randomUUID();
  const approverMembershipId = randomUUID();
  const validatorRoleId = randomUUID();
  const approverRoleId = randomUUID();
  const sourceId = randomUUID();
  const scopeId = randomUUID();
  const headId = randomUUID();
  const transformId = randomUUID();
  const batchId = randomUUID();
  const rowIds = outcomes.map(() => randomUUID());
  const domainKey = `sales.validation_${randomUUID().replaceAll("-", "_")}`;
  await sql`
    insert into organizations (id, code, name)
    values (${organizationId}, ${`org-${organizationId}`}, 'Validation Test Organisation')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values (${businessUnitId}, ${organizationId}, ${`bu-${businessUnitId}`}, 'Validation Test Unit')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, user_type, status)
    values
      (${validatorUserId}, ${`validation:${validatorUserId}`}, 'Validator', 'HUMAN', 'ACTIVE'),
      (${approverUserId}, ${`approval:${approverUserId}`}, 'Approver', 'HUMAN', 'ACTIVE')
  `;
  await sql`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from
    ) values
      (${validatorMembershipId}, ${organizationId}, ${businessUnitId}, ${validatorUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${validatorAlternateMembershipId}, ${organizationId}, null, ${validatorUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${approverMembershipId}, ${organizationId}, ${businessUnitId}, ${approverUserId},
       'ACTIVE', clock_timestamp() - interval '1 day')
  `;
  await sql`
    insert into roles (id, organization_id, key, name, status)
    values
      (${validatorRoleId}, ${organizationId}, ${`validator-${validatorRoleId}`},
       'Migration Validator', 'ACTIVE'),
      (${approverRoleId}, ${organizationId}, ${`approver-${approverRoleId}`},
       'Migration Approver', 'ACTIVE')
  `;
  await sql`
    insert into role_capabilities (organization_id, role_id, capability_key)
    values
      (${organizationId}, ${validatorRoleId}, ${VALIDATE_CAPABILITY}),
      (${organizationId}, ${validatorRoleId}, ${REVIEW_CAPABILITY}),
      (${organizationId}, ${approverRoleId}, ${APPROVE_CAPABILITY})
  `;
  await sql`
    insert into membership_roles (organization_id, membership_id, role_id, valid_from)
    values
      (${organizationId}, ${validatorMembershipId}, ${validatorRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${validatorAlternateMembershipId}, ${approverRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${approverMembershipId}, ${approverRoleId},
       clock_timestamp() - interval '1 day')
  `;
  await sql`
    insert into migration_sources (
      id, organization_id, business_unit_id, source_key, source_kind, source_mode,
      owner_membership_id, status
    ) values (
      ${sourceId}, ${organizationId}, ${businessUnitId}, ${`source-${sourceId}`},
      'SALAM_CRM_JSON', 'ONE_TIME_MIGRATION', ${validatorMembershipId}, 'ACTIVE'
    )
  `;
  await sql`
    insert into migration_source_scopes (
      id, organization_id, business_unit_id, migration_source_id, domain_key,
      canonical_target, transition_mode, source_status
    ) values (
      ${scopeId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${domainKey},
      'crm.canonical', 'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
    )
  `;
  await sql`
    insert into migration_domain_authorities (
      id, organization_id, business_unit_id, domain_key, canonical_target,
      authority_state, authority_source_scope_id
    ) values (
      ${headId}, ${organizationId}, ${businessUnitId}, ${domainKey}, 'crm.canonical',
      'SHADOW_READ', ${scopeId}
    )
  `;
  await sql`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, approved_by_membership_id, approved_at
    ) values (
      ${transformId}, ${organizationId}, ${businessUnitId}, ${sourceId}, 1, 'sales.v1',
      ${protectedRef("mapping")}, ${sha256(`mapping:${transformId}`)},
      ${protectedRef("manifest")}, ${sha256(`manifest:${transformId}`)},
      ${sha256(`release:${transformId}`)}, 'Reviewed validation transform',
      ${validatorMembershipId}, clock_timestamp()
    )
  `;
  const sourceSha = sha256(`batch:${batchId}`);
  let validatedDryRunBatchId: string | null = null;
  if (!dryRun) {
    validatedDryRunBatchId = randomUUID();
    await sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
        schema_version, status, dry_run, validated_by_membership_id, validated_at
      ) values (
        ${validatedDryRunBatchId}, ${organizationId}, ${businessUnitId}, ${sourceId},
        ${transformId}, ${protectedRef("dry-proof")}, ${sourceSha}, 1,
        clock_timestamp() - interval '3 minutes', clock_timestamp() - interval '4 minutes',
        'sales.v1', 'DRY_RUN_COMPLETE', true, ${validatorMembershipId},
        clock_timestamp() - interval '2 minutes'
      )
    `;
  }

  const counts = {
    staged: outcomes.filter((outcome) => outcome === "STAGED").length,
    valid: outcomes.filter((outcome) => outcome === "VALID").length,
    rejected: outcomes.filter((outcome) => outcome === "REJECTED").length,
    quarantined: outcomes.filter((outcome) => outcome === "QUARANTINED").length,
    hidden: outcomes.filter((outcome) => outcome === "HIDDEN").length,
  };
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, total_row_count, staged_row_count,
      valid_row_count, rejected_row_count, quarantined_row_count, hidden_row_count
    ) values (
      ${batchId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${validatedDryRunBatchId}, ${protectedRef("batch")}, ${sourceSha}, 1,
      clock_timestamp() - interval '1 minute', clock_timestamp() - interval '2 minutes',
      'sales.v1', 'STAGED', ${dryRun}, ${outcomes.length}, ${counts.staged},
      ${counts.valid}, ${counts.rejected}, ${counts.quarantined}, ${counts.hidden}
    )
  `;
  for (const [index, outcome] of outcomes.entries()) {
    const rowId = rowIds[index]!;
    const normalizedRef = outcome === "VALID" ? protectedRef("normalized-seed") : null;
    const normalizedSha = outcome === "VALID" ? sha256(`normalized:${rowId}`) : null;
    const errorCode =
      outcome === "REJECTED" || outcome === "QUARANTINED" || outcome === "HIDDEN"
        ? `${outcome}_SOURCE_RULE`
        : null;
    await sql`
      insert into import_rows (
        id, organization_id, business_unit_id, batch_id, source_row_key, row_number,
        source_object_type, source_locator, row_sha256, raw_evidence_ref,
        normalized_evidence_ref, normalized_sha256, outcome, error_code, error_metadata
      ) values (
        ${rowId}, ${organizationId}, ${businessUnitId}, ${batchId}, ${`row-${rowId}`},
        ${index + 1}, 'synthetic.record', ${`records/${index + 1}`},
        ${sha256(`raw:${rowId}`)}, ${protectedRef("raw")}, ${normalizedRef},
        ${normalizedSha}, ${outcome}, ${errorCode},
        ${sql.json(errorCode === null ? {} : { ruleCode: errorCode })}
      )
    `;
    if (outcome === "QUARANTINED") {
      await sql`
        insert into quarantine_items (
          organization_id, business_unit_id, import_row_id, reason_code, reason_metadata
        ) values (
          ${organizationId}, ${businessUnitId}, ${rowId}, ${errorCode},
          ${sql.json({ ruleCode: errorCode })}
        )
      `;
    }
  }
  return {
    organizationId,
    businessUnitId,
    validatorUserId,
    validatorMembershipId,
    validatorActor: {
      userId: validatorUserId,
      organizationId,
      activeMembershipId: validatorMembershipId,
      businessUnitId,
      capabilities: [VALIDATE_CAPABILITY, REVIEW_CAPABILITY],
    },
    validatorAlternateMembershipId,
    validatorAsApproverActor: {
      userId: validatorUserId,
      organizationId,
      activeMembershipId: validatorAlternateMembershipId,
      businessUnitId,
      capabilities: [APPROVE_CAPABILITY],
    },
    approverUserId,
    approverMembershipId,
    approverActor: {
      userId: approverUserId,
      organizationId,
      activeMembershipId: approverMembershipId,
      businessUnitId,
      capabilities: [APPROVE_CAPABILITY],
    },
    sourceId,
    scopeId,
    headId,
    batchId,
    rowIds,
  };
}

beforeAll(async () => {
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    PRODUCT_SURFACE: "crm",
    DEPLOYMENT_ENVIRONMENT: "local",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "20",
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: "validation-tests-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "validation-integration",
    OIDC_CLIENT_SECRET: "validation-integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql`
    insert into capabilities (key, description, risk_level)
    values
      (${VALIDATE_CAPABILITY}, 'Validate migration rows', 'SENSITIVE'),
      (${REVIEW_CAPABILITY}, 'Review migration quarantine', 'SENSITIVE'),
      (${APPROVE_CAPABILITY}, 'Approve validated imports', 'PRIVILEGED')
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
  resetRuntimeConfigForTests();
});

function normalizedVerifier(ref: string, bytes: Uint8Array): NormalizedEvidenceVerifier {
  return {
    async verify(candidateRef, expectedSha256) {
      const digest = sha256(bytes);
      if (
        candidateRef !== ref ||
        (expectedSha256 !== null && !Buffer.from(expectedSha256).equals(digest))
      ) {
        throw new Error("SYNTHETIC_NORMALIZED_EVIDENCE_MISMATCH");
      }
      return { ref, sha256: digest };
    },
  };
}

async function batchVersion(batchId: string): Promise<number> {
  const [row] = await sql<{ version: string }[]>`
    select version from import_batches where id = ${batchId}
  `;
  if (!row) throw new Error("Synthetic batch is missing.");
  return Number(row.version);
}

async function validateFixture(fixture: Fixture) {
  const version = await batchVersion(fixture.batchId);
  const summary = await validateImportBatch(fixture.validatorActor, {
    batchId: fixture.batchId,
    expectedBatchVersion: version,
  });
  return { summary, version: await batchVersion(fixture.batchId) };
}

async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<{ blocked: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity activity
        where activity.datname = ${expectedDatabaseName}
          and activity.pid <> pg_backend_pid()
          and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      ) as blocked
    `;
    if (row?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected approval to block behind PID ${blockerPid}.`);
}

describe("protected import-row validation", () => {
  it("persists a valid decision only after normalized evidence is verified", async () => {
    const fixture = await seedFixture();
    const normalizedRef = protectedRef("normalized");
    const normalizedSha = sha256("normalized-row");
    const decision: RowValidationDecision = {
      outcome: "VALID",
      normalizedEvidenceRef: normalizedRef,
      normalizedSha256: normalizedSha,
      errorCode: null,
      redactedMetadata: {},
    };

    await recordImportRowValidation(
      fixture.validatorActor,
      { importRowId: fixture.rowIds[0]!, expectedRowVersion: 1, decision },
      {
        async verify(ref, expectedSha256) {
          expect(ref).toBe(normalizedRef);
          expect(Buffer.from(expectedSha256 ?? [])).toEqual(normalizedSha);
          return { ref, sha256: normalizedSha };
        },
      },
    );

    const [stored] = await sql<{ outcome: string }[]>`
      select outcome from import_rows where id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({ outcome: "VALID" });
  });

  it("rejects a mismatched normalized checksum without mutating row or counters", async () => {
    const fixture = await seedFixture();
    const normalizedRef = protectedRef("normalized-mismatch");
    const expectedSha = sha256("reviewed-normalized");
    await expect(
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: fixture.rowIds[0]!,
          expectedRowVersion: 1,
          decision: {
            outcome: "VALID",
            normalizedEvidenceRef: normalizedRef,
            normalizedSha256: expectedSha,
            errorCode: null,
            redactedMetadata: {},
          },
        },
        {
          async verify() {
            return { ref: normalizedRef, sha256: sha256("different-normalized") };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NORMALIZED_EVIDENCE_BINDING_INVALID", status: 422 });
    const [stored] = await sql<{ outcome: string; staged: string; valid: string }[]>`
      select row_record.outcome, batch.staged_row_count as staged,
             batch.valid_row_count as valid
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({ outcome: "STAGED", staged: "1", valid: "0" });
  });

  it("rechecks immutable raw evidence after normalized verification before locking the write", async () => {
    const fixture = await seedFixture();
    const rowId = fixture.rowIds[0]!;
    const normalizedRef = protectedRef("raw-race-normalized");
    const normalizedBytes = Buffer.from("raw-race-normalized");
    let disabled = false;
    try {
      await expect(
        recordImportRowValidation(
          fixture.validatorActor,
          {
            importRowId: rowId,
            expectedRowVersion: 1,
            decision: {
              outcome: "VALID",
              normalizedEvidenceRef: normalizedRef,
              normalizedSha256: sha256(normalizedBytes),
              errorCode: null,
              redactedMetadata: {},
            },
          },
          {
            async verify(ref) {
              await sql.unsafe(`
                alter table import_rows disable trigger import_rows_evidence_guard;
                alter table import_rows disable trigger import_rows_touch_version;
              `);
              disabled = true;
              await sql`
                update import_rows set row_sha256 = ${sha256("tampered-raw-evidence")}
                where id = ${rowId}
              `;
              await sql.unsafe(`
                alter table import_rows enable trigger import_rows_touch_version;
                alter table import_rows enable trigger import_rows_evidence_guard;
              `);
              disabled = false;
              return { ref, sha256: sha256(normalizedBytes) };
            },
          },
        ),
      ).rejects.toMatchObject({ code: "IMPORT_ROW_RAW_EVIDENCE_CHANGED", status: 409 });
    } finally {
      if (disabled) {
        await sql.unsafe(`
          alter table import_rows enable trigger import_rows_touch_version;
          alter table import_rows enable trigger import_rows_evidence_guard;
        `);
      }
    }
    const [stored] = await sql<{
      outcome: string;
      normalized_ref: string | null;
      staged: string;
      valid: string;
    }[]>`
      select row_record.outcome, row_record.normalized_evidence_ref as normalized_ref,
             batch.staged_row_count as staged, batch.valid_row_count as valid
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${rowId}
    `;
    expect(stored).toEqual({
      outcome: "STAGED",
      normalized_ref: null,
      staged: "1",
      valid: "0",
    });
  });

  it("rejects a valid decision without a protected normalized digest before verification", async () => {
    const fixture = await seedFixture();
    let verifierCalls = 0;
    await expect(
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: fixture.rowIds[0]!,
          expectedRowVersion: 1,
          decision: {
            outcome: "VALID",
            normalizedEvidenceRef: protectedRef("missing-digest"),
            normalizedSha256: null,
            errorCode: null,
            redactedMetadata: {},
          },
        },
        {
          async verify() {
            verifierCalls += 1;
            throw new Error("must not verify malformed input");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ROW_VALIDATION_DECISION_INVALID", status: 422 });
    expect(verifierCalls).toBe(0);
  });

  it("records stable rejected and hidden decisions with redacted metadata", async () => {
    for (const outcome of ["REJECTED", "HIDDEN"] as const) {
      const fixture = await seedFixture();
      await recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: fixture.rowIds[0]!,
          expectedRowVersion: 1,
          decision: {
            outcome,
            normalizedEvidenceRef: null,
            normalizedSha256: null,
            errorCode: `${outcome}_SCHEMA_RULE`,
            redactedMetadata: { fieldCode: "legacy_status", ruleCode: outcome },
          },
        },
        { async verify() { throw new Error("must not verify rejected evidence"); } },
      );
      const [stored] = await sql<{ outcome: string; error_code: string }[]>`
        select outcome, error_code from import_rows where id = ${fixture.rowIds[0]!}
      `;
      expect(stored).toEqual({ outcome, error_code: `${outcome}_SCHEMA_RULE` });
    }
  });

  it("routes quarantine through the existing primitive and accepts corrected reviewed evidence", async () => {
    const fixture = await seedFixture();
    const rowId = fixture.rowIds[0]!;
    await recordImportRowValidation(
      fixture.validatorActor,
      {
        importRowId: rowId,
        expectedRowVersion: 1,
        decision: {
          outcome: "QUARANTINED",
          normalizedEvidenceRef: null,
          normalizedSha256: null,
          errorCode: "AMBIGUOUS_SOURCE_STATE",
          redactedMetadata: { fieldCode: "legacy_status", ruleCode: "UNMAPPED_ENUM" },
        },
      },
      { async verify() { throw new Error("must not verify quarantine opening"); } },
    );
    const [item] = await sql<{ id: string; item_version: string; row_version: string }[]>`
      select item.id, item.version as item_version, row_record.version as row_version
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.import_row_id = ${rowId} and item.status = 'OPEN'
    `;
    if (!item) throw new Error("Expected an open quarantine item.");
    const correctedRef = protectedRef("corrected-normalized");
    const correctedBytes = Buffer.from("corrected-normalized-record");
    await resolveQuarantineItem(
      fixture.validatorActor,
      {
        quarantineItemId: item.id,
        disposition: "APPROVE_ROW",
        resolutionReason: "Reviewed corrected normalized evidence",
        correctedNormalizedEvidenceRef: correctedRef,
        expectedNormalizedSha256: sha256(correctedBytes),
        expectedItemVersion: Number(item.item_version),
        expectedRowVersion: Number(item.row_version),
      },
      normalizedVerifier(correctedRef, correctedBytes),
    );
    const validated = await validateFixture(fixture);
    expect(validated.summary).toEqual({
      totalRows: 1,
      validRows: 1,
      rejectedRows: 0,
      quarantinedRows: 0,
      hiddenRows: 0,
    });
  });

  it("rejects stale row versions, wrong capabilities, and cross-tenant row locators", async () => {
    const fixture = await seedFixture();
    const validDecision: RowValidationDecision = {
      outcome: "REJECTED",
      normalizedEvidenceRef: null,
      normalizedSha256: null,
      errorCode: "STALE_SOURCE_RULE",
      redactedMetadata: { ruleCode: "STALE_SOURCE_RULE" },
    };
    await expect(
      recordImportRowValidation(
        fixture.validatorActor,
        { importRowId: fixture.rowIds[0]!, expectedRowVersion: 2, decision: validDecision },
        { async verify() { throw new Error("unused"); } },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_VERSION_CONFLICT", status: 409 });
    await expect(
      recordImportRowValidation(
        { ...fixture.validatorActor, capabilities: [] },
        { importRowId: fixture.rowIds[0]!, expectedRowVersion: 1, decision: validDecision },
        { async verify() { throw new Error("unused"); } },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    await expect(
      recordImportRowValidation(
        { ...fixture.validatorActor, organizationId: randomUUID() },
        { importRowId: fixture.rowIds[0]!, expectedRowVersion: 1, decision: validDecision },
        { async verify() { throw new Error("unused"); } },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_NOT_FOUND", status: 404 });
  });
});

describe("row-derived batch validation and dry-run completion", () => {
  it("rejects an unvalidated staged row and a valid row missing normalized evidence", async () => {
    const staged = await seedFixture(["VALID", "STAGED"]);
    await expect(
      validateImportBatch(staged.validatorActor, {
        batchId: staged.batchId,
        expectedBatchVersion: await batchVersion(staged.batchId),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_HAS_STAGED_ROWS", status: 409 });

    const missingEvidence = await seedFixture(["VALID"]);
    await sql`
      update import_rows set normalized_evidence_ref = null, normalized_sha256 = null
      where id = ${missingEvidence.rowIds[0]!}
    `;
    await expect(
      validateImportBatch(missingEvidence.validatorActor, {
        batchId: missingEvidence.batchId,
        expectedBatchVersion: await batchVersion(missingEvidence.batchId),
      }),
    ).rejects.toMatchObject({
      code: "IMPORT_ROW_NORMALIZED_EVIDENCE_REQUIRED",
      status: 409,
    });
  });

  it("derives every validation counter from rows and persists validator provenance", async () => {
    const fixture = await seedFixture(["VALID", "REJECTED"]);
    await sql`
      update import_batches set valid_row_count = 0, rejected_row_count = 2
      where id = ${fixture.batchId}
    `;
    const { summary } = await validateFixture(fixture);
    expect(summary).toEqual({
      totalRows: 2,
      validRows: 1,
      rejectedRows: 1,
      quarantinedRows: 0,
      hiddenRows: 0,
    });
    const [stored] = await sql<{
      status: string;
      validator: string;
      valid: string;
      rejected: string;
      audits: number;
      outbox: number;
    }[]>`
      select batch.status, batch.validated_by_membership_id as validator,
             batch.valid_row_count as valid, batch.rejected_row_count as rejected,
             (select count(*)::int from audit_events where target_id = batch.id
                and action = 'MIGRATION_IMPORT_BATCH_VALIDATED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
                and event_type = 'crm.migration.import_batch_validated') as outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "VALIDATED",
      validator: fixture.validatorMembershipId,
      valid: "1",
      rejected: "1",
      audits: 1,
      outbox: 1,
    });
  });

  it("rejects a stale batch version and conceals another tenant", async () => {
    const fixture = await seedFixture(["VALID"]);
    const version = await batchVersion(fixture.batchId);
    await expect(
      validateImportBatch(fixture.validatorActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: version + 1,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_VERSION_CONFLICT", status: 409 });
    await expect(
      validateImportBatch(
        { ...fixture.validatorActor, organizationId: randomUUID() },
        { batchId: fixture.batchId, expectedBatchVersion: version },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_NOT_FOUND", status: 404 });
  });

  it("revalidates the live database grant instead of trusting caller capability claims", async () => {
    const fixture = await seedFixture(["VALID"]);
    await sql`
      delete from role_capabilities grants
      using membership_roles assigned
      where assigned.organization_id = grants.organization_id
        and assigned.role_id = grants.role_id
        and assigned.membership_id = ${fixture.validatorMembershipId}
        and grants.capability_key = ${VALIDATE_CAPABILITY}
    `;
    await expect(
      validateImportBatch(fixture.validatorActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: await batchVersion(fixture.batchId),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
  });

  it("completes only a validated dry run with no hidden or open-quarantine rows", async () => {
    const fixture = await seedFixture(["VALID", "REJECTED"]);
    const { summary, version } = await validateFixture(fixture);
    await expect(
      completeDryRun(fixture.validatorActor, {
        batchId: fixture.batchId,
        expectedValidatedBatchVersion: version,
      }),
    ).resolves.toEqual(summary);
    const [stored] = await sql<{
      status: string;
      approval_mode: string | null;
      approved_by: string | null;
      authority_state: string;
    }[]>`
      select batch.status, batch.approval_mode,
             batch.approved_by_membership_id as approved_by, authority.authority_state
      from import_batches batch
      join migration_domain_authorities authority
        on authority.organization_id = batch.organization_id
       and authority.business_unit_id = batch.business_unit_id
      where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "DRY_RUN_COMPLETE",
      approval_mode: null,
      approved_by: null,
      authority_state: "SHADOW_READ",
    });

    for (const outcome of ["QUARANTINED", "HIDDEN"] as const) {
      const blocked = await seedFixture([outcome]);
      const validated = await validateFixture(blocked);
      await expect(
        completeDryRun(blocked.validatorActor, {
          batchId: blocked.batchId,
          expectedValidatedBatchVersion: validated.version,
        }),
      ).rejects.toMatchObject({ code: "DRY_RUN_NOT_REVIEWED", status: 409 });
    }
  });

  it("rejects a persisted dry-run summary changed after validation", async () => {
    const fixture = await seedFixture(["VALID", "REJECTED"]);
    await validateFixture(fixture);
    await sql`
      update import_batches set valid_row_count = 0, rejected_row_count = 2
      where id = ${fixture.batchId}
    `;
    await expect(
      completeDryRun(fixture.validatorActor, {
        batchId: fixture.batchId,
        expectedValidatedBatchVersion: await batchVersion(fixture.batchId),
      }),
    ).rejects.toMatchObject({ code: "DRY_RUN_SUMMARY_CONFLICT", status: 409 });
  });

  it("never completes a validated live batch through the dry-run endpoint", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    await expect(
      completeDryRun(fixture.validatorActor, {
        batchId: fixture.batchId,
        expectedValidatedBatchVersion: validated.version,
      }),
    ).rejects.toMatchObject({ code: "DRY_RUN_STATE_INVALID", status: 409 });
  });
});

describe("maker-checker batch approval", () => {
  it("approves a non-empty all-valid live batch and commits provenance/effects atomically", async () => {
    const fixture = await seedFixture(["VALID", "VALID"], false);
    const validated = await validateFixture(fixture);
    await expect(
      approveImportBatch(fixture.approverActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: validated.version,
        approvalMode: "FULL",
        approvalReason: "Reviewed complete normalized import",
      }),
    ).resolves.toEqual({ approvedRowCount: 2, approvalMode: "FULL" });
    const [stored] = await sql<{
      status: string;
      validator: string;
      approver: string;
      approved: string;
      audits: number;
      outbox: number;
    }[]>`
      select batch.status, batch.validated_by_membership_id as validator,
             batch.approved_by_membership_id as approver,
             batch.approved_row_count as approved,
             (select count(*)::int from audit_events where target_id = batch.id
               and action = 'MIGRATION_IMPORT_BATCH_APPROVED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
               and event_type = 'crm.migration.import_batch_approved') as outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "APPROVED",
      validator: fixture.validatorMembershipId,
      approver: fixture.approverMembershipId,
      approved: "2",
      audits: 1,
      outbox: 1,
    });
  });

  it("approves an explicit valid subset only in PARTIAL mode with rejected-row visibility", async () => {
    const fixture = await seedFixture(["VALID", "REJECTED", "VALID"], false);
    const validated = await validateFixture(fixture);
    await expect(
      approveImportBatch(fixture.approverActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: validated.version,
        approvalMode: "PARTIAL",
        approvalReason: "Rejected source rows remain visible for follow-up",
      }),
    ).resolves.toEqual({ approvedRowCount: 2, approvalMode: "PARTIAL" });
    const [stored] = await sql<{ approved: string; rejected: string; reason: string }[]>`
      select approved_row_count as approved, rejected_row_count as rejected,
             approval_reason as reason from import_batches where id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      approved: "2",
      rejected: "1",
      reason: "Rejected source rows remain visible for follow-up",
    });
  });

  it("rejects full approval with rejected rows and partial approval without a reason", async () => {
    const full = await seedFixture(["VALID", "REJECTED"], false);
    const fullValidated = await validateFixture(full);
    await expect(
      approveImportBatch(full.approverActor, {
        batchId: full.batchId,
        expectedBatchVersion: fullValidated.version,
        approvalMode: "FULL",
        approvalReason: "Incorrect full request",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_FULL_APPROVAL_INVALID", status: 409 });

    const partial = await seedFixture(["VALID", "REJECTED"], false);
    const partialValidated = await validateFixture(partial);
    await expect(
      approveImportBatch(partial.approverActor, {
        batchId: partial.batchId,
        expectedBatchVersion: partialValidated.version,
        approvalMode: "PARTIAL",
        approvalReason: "   ",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPROVAL_REASON_REQUIRED", status: 422 });
  });

  it("requires a persisted reason for full approval as part of the approval tuple", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    await expect(
      approveImportBatch(fixture.approverActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: validated.version,
        approvalMode: "FULL",
        approvalReason: null,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPROVAL_REASON_REQUIRED", status: 422 });
  });

  it("rejects zero rows, dry runs, hidden rows, and open quarantine", async () => {
    const scenarios: Array<{
      fixture: Fixture;
      expectedCode: string;
      mode: "FULL" | "PARTIAL";
    }> = [];
    const zero = await seedFixture([], false);
    scenarios.push({ fixture: zero, expectedCode: "IMPORT_BATCH_ZERO_ROW_APPROVAL", mode: "FULL" });
    const dry = await seedFixture(["VALID"], true);
    scenarios.push({ fixture: dry, expectedCode: "IMPORT_BATCH_DRY_RUN_APPROVAL_FORBIDDEN", mode: "FULL" });
    const hidden = await seedFixture(["VALID", "HIDDEN"], false);
    scenarios.push({ fixture: hidden, expectedCode: "IMPORT_BATCH_APPROVAL_POLICY_FAILED", mode: "PARTIAL" });
    const quarantine = await seedFixture(["VALID", "QUARANTINED"], false);
    scenarios.push({ fixture: quarantine, expectedCode: "IMPORT_BATCH_APPROVAL_POLICY_FAILED", mode: "PARTIAL" });
    for (const scenario of scenarios) {
      const validated = await validateFixture(scenario.fixture);
      await expect(
        approveImportBatch(scenario.fixture.approverActor, {
          batchId: scenario.fixture.batchId,
          expectedBatchVersion: validated.version,
          approvalMode: scenario.mode,
          approvalReason: "Reviewed policy scenario",
        }),
      ).rejects.toMatchObject({ code: scenario.expectedCode });
    }
  });

  it("compares underlying users across memberships and rejects the validator as approver", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    await expect(
      approveImportBatch(fixture.validatorAsApproverActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: validated.version,
        approvalMode: "FULL",
        approvalReason: "Attempted self approval",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_MAKER_CHECKER_REQUIRED", status: 409 });
  });

  it("rejects wrong capabilities, cross-tenant locators, and stale versions", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    const input = {
      batchId: fixture.batchId,
      expectedBatchVersion: validated.version,
      approvalMode: "FULL" as const,
      approvalReason: "Reviewed complete import",
    };
    await expect(
      approveImportBatch({ ...fixture.approverActor, capabilities: [] }, input),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    await expect(
      approveImportBatch(
        { ...fixture.approverActor, organizationId: randomUUID() },
        input,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_NOT_FOUND", status: 404 });
    await expect(
      approveImportBatch(fixture.approverActor, {
        ...input,
        expectedBatchVersion: validated.version + 1,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_VERSION_CONFLICT", status: 409 });
  });

  it("revalidates the approver's live database grant", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    await sql`
      delete from role_capabilities grants
      using membership_roles assigned
      where assigned.organization_id = grants.organization_id
        and assigned.role_id = grants.role_id
        and assigned.membership_id = ${fixture.approverMembershipId}
        and grants.capability_key = ${APPROVE_CAPABILITY}
    `;
    await expect(
      approveImportBatch(fixture.approverActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: validated.version,
        approvalMode: "FULL",
        approvalReason: "Caller claims a revoked capability",
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
  });

  it("rolls back approval, audit, and outbox when an effect insert fails", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    await sql.unsafe(`
      create function crm_test_reject_batch_approval_outbox() returns trigger
      language plpgsql as $$
      begin
        if new.event_type = 'crm.migration.import_batch_approved' then
          raise exception 'synthetic approval outbox failure';
        end if;
        return new;
      end;
      $$;
      create trigger crm_test_reject_batch_approval_outbox_trigger
      before insert on outbox_events
      for each row execute function crm_test_reject_batch_approval_outbox();
    `);
    try {
      await expect(
        approveImportBatch(fixture.approverActor, {
          batchId: fixture.batchId,
          expectedBatchVersion: validated.version,
          approvalMode: "FULL",
          approvalReason: "Reviewed rollback scenario",
        }),
      ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPROVAL_FAILED", status: 500 });
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_reject_batch_approval_outbox_trigger on outbox_events;
        drop function if exists crm_test_reject_batch_approval_outbox();
      `);
    }
    const [stored] = await sql<{
      status: string;
      approver: string | null;
      audits: number;
      outbox: number;
    }[]>`
      select batch.status, batch.approved_by_membership_id as approver,
             (select count(*)::int from audit_events where target_id = batch.id
               and action = 'MIGRATION_IMPORT_BATCH_APPROVED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
               and event_type = 'crm.migration.import_batch_approved') as outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ status: "VALIDATED", approver: null, audits: 0, outbox: 0 });
  });

  it("rechecks authority after a deterministic approval-versus-cutover lock wait", async () => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    const blocker = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
    let approval: Promise<unknown> | undefined;
    try {
      await blocker.begin(async (transaction) => {
        const [pid] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await transaction`
          select id from migration_domain_authorities where id = ${fixture.headId} for update
        `;
        approval = approveImportBatch(fixture.approverActor, {
          batchId: fixture.batchId,
          expectedBatchVersion: validated.version,
          approvalMode: "FULL",
          approvalReason: "Approval that must lose to cutover",
        });
        await waitUntilBlockedBy(pid!.pid);
        await transaction`
          update migration_domain_authorities
          set authority_state = 'CANONICAL_WRITABLE', authority_source_scope_id = null
          where id = ${fixture.headId}
        `;
        await transaction`
          update migration_source_scopes set source_status = 'ARCHIVED_READ_ONLY'
          where id = ${fixture.scopeId}
        `;
        await transaction`
          update migration_sources set status = 'ARCHIVED_READ_ONLY'
          where id = ${fixture.sourceId}
        `;
      });
      await expect(approval).rejects.toMatchObject({
        code: "MIGRATION_SOURCE_NOT_ACTIVE",
        status: 409,
      });
    } finally {
      await blocker.end();
    }
    const [stored] = await sql<{ status: string; approver: string | null }[]>`
      select status, approved_by_membership_id as approver
      from import_batches where id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ status: "VALIDATED", approver: null });
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntilBlockedCountBy(
  blockerPid: number,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<{ blocked_count: string }[]>`
      select count(*)::text as blocked_count
      from pg_stat_activity activity
      where activity.datname = ${expectedDatabaseName}
        and activity.pid <> pg_backend_pid()
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
    `;
    if (Number(row?.blocked_count ?? "0") >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} backends to block behind PID ${blockerPid}.`);
}

async function waitUntilBlockedBackendCount(expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<{ blocked_count: string }[]>`
      select count(*)::text as blocked_count
      from pg_stat_activity activity
      where activity.datname = ${expectedDatabaseName}
        and activity.pid <> pg_backend_pid()
        and cardinality(pg_blocking_pids(activity.pid)) > 0
    `;
    if (Number(row?.blocked_count ?? "0") >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} blocked database backends.`);
}

async function withRejectedOutboxEvent<T>(
  eventType: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!/^crm\.migration\.[a-z_]+$/.test(eventType)) {
    throw new Error("Synthetic event type is not canonical.");
  }
  await sql.unsafe(`
    create function crm_test_reject_selected_validation_outbox() returns trigger
    language plpgsql as $$
    begin
      raise exception 'synthetic validation outbox failure';
    end;
    $$;
    create trigger crm_test_reject_selected_validation_outbox_trigger
    before insert on outbox_events
    for each row when (new.event_type = '${eventType}')
    execute function crm_test_reject_selected_validation_outbox();
  `);
  try {
    return await operation();
  } finally {
    await sql.unsafe(`
      drop trigger if exists crm_test_reject_selected_validation_outbox_trigger
        on outbox_events;
      drop function if exists crm_test_reject_selected_validation_outbox();
    `);
  }
}

async function invokeNormalizedBoundary(
  path: "DIRECT" | "QUARANTINE",
  fixture: Fixture,
  ref: string,
  digest: Uint8Array,
  result: unknown,
): Promise<void> {
  const verifier = {
    async verify() {
      return result;
    },
  } as NormalizedEvidenceVerifier;
  if (path === "DIRECT") {
    await recordImportRowValidation(
      fixture.validatorActor,
      {
        importRowId: fixture.rowIds[0]!,
        expectedRowVersion: 1,
        decision: {
          outcome: "VALID",
          normalizedEvidenceRef: ref,
          normalizedSha256: digest,
          errorCode: null,
          redactedMetadata: {},
        },
      },
      verifier,
    );
    return;
  }

  await recordImportRowValidation(
    fixture.validatorActor,
    {
      importRowId: fixture.rowIds[0]!,
      expectedRowVersion: 1,
      decision: {
        outcome: "QUARANTINED",
        normalizedEvidenceRef: null,
        normalizedSha256: null,
        errorCode: "BOUNDARY_REVIEW_REQUIRED",
        redactedMetadata: { ruleCode: "BOUNDARY_REVIEW_REQUIRED" },
      },
    },
    { async verify() { throw new Error("unused"); } },
  );
  const [item] = await sql<{ id: string; item_version: string; row_version: string }[]>`
    select item.id, item.version as item_version, row_record.version as row_version
    from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
    where item.import_row_id = ${fixture.rowIds[0]!} and item.status = 'OPEN'
  `;
  if (!item) throw new Error("Expected a synthetic open quarantine item.");
  await resolveQuarantineItem(
    fixture.validatorActor,
    {
      quarantineItemId: item.id,
      disposition: "APPROVE_ROW",
      resolutionReason: "Reviewed normalized boundary",
      correctedNormalizedEvidenceRef: ref,
      expectedNormalizedSha256: digest,
      expectedItemVersion: Number(item.item_version),
      expectedRowVersion: Number(item.row_version),
    },
    verifier,
  );
}

async function expectSanitizedBoundaryRejection(operation: Promise<void>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: "NORMALIZED_EVIDENCE_BINDING_INVALID",
    status: 422,
  });
  expect(String(caught)).not.toContain("leak@example.test");
  expect(String(caught)).not.toContain("SUBSTITUTED_SECRET");
}

async function validationEffects(batchId: string, rowId: string) {
  const [stored] = await sql<{
    status: string;
    outcome: string;
    normalized_ref: string | null;
    staged: string;
    valid: string;
    row_audits: number;
    row_outbox: number;
    batch_audits: number;
    batch_outbox: number;
  }[]>`
    select batch.status, row_record.outcome,
           row_record.normalized_evidence_ref as normalized_ref,
           batch.staged_row_count as staged, batch.valid_row_count as valid,
           (select count(*)::int from audit_events where target_id = ${rowId}
             and action = 'MIGRATION_IMPORT_ROW_VALIDATED') as row_audits,
           (select count(*)::int from outbox_events where aggregate_id = ${rowId}
             and event_type = 'crm.migration.import_row_validated') as row_outbox,
           (select count(*)::int from audit_events where target_id = ${batchId}
             and action in ('MIGRATION_IMPORT_BATCH_VALIDATED', 'MIGRATION_DRY_RUN_COMPLETED'))
             as batch_audits,
           (select count(*)::int from outbox_events where aggregate_id = ${batchId}
             and event_type in ('crm.migration.import_batch_validated',
               'crm.migration.dry_run_completed')) as batch_outbox
    from import_batches batch join import_rows row_record on row_record.batch_id = batch.id
    where batch.id = ${batchId} and row_record.id = ${rowId}
  `;
  return stored;
}

describe("review correction: hostile normalized-evidence results", () => {
  it.each(["DIRECT", "QUARANTINE"] as const)(
    "%s rejects changing accessors before post-check ref/digest substitution",
    async (path) => {
      const fixture = await seedFixture();
      const expectedRef = protectedRef("expected-boundary");
      const substitutedRef = protectedRef("SUBSTITUTED_SECRET");
      const expectedDigest = sha256("expected-boundary");
      const substitutedDigest = sha256("substituted-boundary");
      let refReads = 0;
      let digestReads = 0;
      const result = {};
      Object.defineProperties(result, {
        ref: {
          enumerable: true,
          get() {
            refReads += 1;
            return refReads <= 2 ? expectedRef : substitutedRef;
          },
        },
        sha256: {
          enumerable: true,
          get() {
            digestReads += 1;
            return digestReads <= 3 ? expectedDigest : substitutedDigest;
          },
        },
      });
      await expectSanitizedBoundaryRejection(
        invokeNormalizedBoundary(path, fixture, expectedRef, expectedDigest, result),
      );
      const stored = await validationEffects(fixture.batchId, fixture.rowIds[0]!);
      expect(stored).toMatchObject({ normalized_ref: null, valid: "0" });
    },
  );

  it.each(["DIRECT", "QUARANTINE"] as const)(
    "%s rejects inherited accessors",
    async (path) => {
      const fixture = await seedFixture();
      const ref = protectedRef("inherited-boundary");
      const digest = sha256("inherited-boundary");
      const prototype = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(prototype, {
        ref: { get: () => ref },
        sha256: { get: () => digest },
      });
      const result = Object.create(prototype) as unknown;
      await expectSanitizedBoundaryRejection(
        invokeNormalizedBoundary(path, fixture, ref, digest, result),
      );
    },
  );

  it.each(["DIRECT", "QUARANTINE"] as const)(
    "%s sanitizes throwing result getters",
    async (path) => {
      const fixture = await seedFixture();
      const ref = protectedRef("throwing-boundary");
      const digest = sha256("throwing-boundary");
      const result = {};
      Object.defineProperty(result, "ref", {
        enumerable: true,
        get() {
          throw new Error("leak@example.test");
        },
      });
      Object.defineProperty(result, "sha256", { enumerable: true, value: digest });
      await expectSanitizedBoundaryRejection(
        invokeNormalizedBoundary(path, fixture, ref, digest, result),
      );
    },
  );

  it.each(["DIRECT", "QUARANTINE"] as const)(
    "%s rejects Proxy result traps without invoking them",
    async (path) => {
      const fixture = await seedFixture();
      const ref = protectedRef("proxy-boundary");
      const digest = sha256("proxy-boundary");
      let trapCalls = 0;
      const result = new Proxy(
        { ref, sha256: digest },
        {
          getOwnPropertyDescriptor() {
            trapCalls += 1;
            throw new Error("leak@example.test");
          },
        },
      );
      await expectSanitizedBoundaryRejection(
        invokeNormalizedBoundary(path, fixture, ref, digest, result),
      );
      expect(trapCalls).toBe(0);
    },
  );
});

function hostileMetadata(kind: "TOP_LEVEL" | "NESTED" | "THROWING"): Record<string, unknown> {
  if (kind === "NESTED") {
    let reads = 0;
    const nested = {};
    Object.defineProperty(nested, "detail", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "SAFE_CODE" : "leak@example.test";
      },
    });
    return { nested };
  }
  const metadata = {};
  let reads = 0;
  Object.defineProperty(metadata, "detail", {
    enumerable: true,
    get() {
      if (kind === "THROWING") throw new Error("leak@example.test");
      reads += 1;
      return reads === 1 ? "SAFE_CODE" : "leak@example.test";
    },
  });
  return metadata;
}

describe("review correction: canonical redacted metadata snapshots", () => {
  it.each([
    ["TASK7", "TOP_LEVEL"],
    ["TASK7", "NESTED"],
    ["TASK7", "THROWING"],
    ["TASK6", "TOP_LEVEL"],
    ["TASK6", "NESTED"],
    ["TASK6", "THROWING"],
  ] as const)("%s rejects %s getter metadata without leaking", async (path, kind) => {
    const fixture = await seedFixture();
    let caught: unknown;
    try {
      if (path === "TASK7") {
        await recordImportRowValidation(
          fixture.validatorActor,
          {
            importRowId: fixture.rowIds[0]!,
            expectedRowVersion: 1,
            decision: {
              outcome: "REJECTED",
              normalizedEvidenceRef: null,
              normalizedSha256: null,
              errorCode: "HOSTILE_METADATA",
              redactedMetadata: hostileMetadata(kind),
            },
          },
          { async verify() { throw new Error("unused"); } },
        );
      } else {
        await openQuarantineItem(fixture.validatorActor, {
          importRowId: fixture.rowIds[0]!,
          expectedRowVersion: 1,
          reasonCode: "HOSTILE_METADATA",
          redactedMetadata: hostileMetadata(kind),
        });
      }
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "MIGRATION_METADATA_NOT_REDACTED", status: 422 });
    expect(String(caught)).not.toContain("leak@example.test");
    const [stored] = await sql<{ outcome: string; leaked: boolean; items: number }[]>`
      select row_record.outcome,
             exists (
               select 1 from audit_events where organization_id = ${fixture.organizationId}
                 and change_summary::text like '%leak@example.test%'
               union all
               select 1 from outbox_events where organization_id = ${fixture.organizationId}
                 and payload::text like '%leak@example.test%'
             ) as leaked,
             (select count(*)::int from quarantine_items
               where import_row_id = row_record.id) as items
      from import_rows row_record where row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({ outcome: "STAGED", leaked: false, items: 0 });
  });

  it.each(["CYCLE", "EXTRA_ARRAY_PROPERTY", "PROXY"] as const)(
    "rejects %s metadata structures without evaluating traps",
    async (kind) => {
      const fixture = await seedFixture();
      let trapCalls = 0;
      let metadata: Record<string, unknown>;
      if (kind === "CYCLE") {
        metadata = {};
        metadata.self = metadata;
      } else if (kind === "EXTRA_ARRAY_PROPERTY") {
        const values = ["SAFE_CODE"] as string[] & { extra?: string };
        values.extra = "leak@example.test";
        metadata = { values };
      } else {
        metadata = new Proxy(
          { detail: "SAFE_CODE" },
          {
            ownKeys() {
              trapCalls += 1;
              throw new Error("leak@example.test");
            },
          },
        );
      }
      await expect(
        recordImportRowValidation(
          fixture.validatorActor,
          {
            importRowId: fixture.rowIds[0]!,
            expectedRowVersion: 1,
            decision: {
              outcome: "REJECTED",
              normalizedEvidenceRef: null,
              normalizedSha256: null,
              errorCode: "HOSTILE_STRUCTURE",
              redactedMetadata: metadata,
            },
          },
          { async verify() { throw new Error("unused"); } },
        ),
      ).rejects.toMatchObject({ code: "MIGRATION_METADATA_NOT_REDACTED", status: 422 });
      if (kind === "PROXY") expect(trapCalls).toBe(0);
    },
  );

  it.each(["TASK7", "TASK6"] as const)(
    "%s rejects sensitive metadata keys across every permitted separator",
    async (path) => {
      const fixture = await seedFixture();
      for (const sensitiveKey of [
        "person.name",
        "address:line1",
        "customer_email",
        "phone-number",
        "customerEmail",
      ]) {
        const operation =
          path === "TASK7"
            ? recordImportRowValidation(
                fixture.validatorActor,
                {
                  importRowId: fixture.rowIds[0]!,
                  expectedRowVersion: 1,
                  decision: {
                    outcome: "REJECTED",
                    normalizedEvidenceRef: null,
                    normalizedSha256: null,
                    errorCode: "SENSITIVE_KEY_BYPASS",
                    redactedMetadata: { [sensitiveKey]: "SAFE_CODE" },
                  },
                },
                { async verify() { throw new Error("unused"); } },
              )
            : openQuarantineItem(fixture.validatorActor, {
                importRowId: fixture.rowIds[0]!,
                expectedRowVersion: 1,
                reasonCode: "SENSITIVE_KEY_BYPASS",
                redactedMetadata: { [sensitiveKey]: "SAFE_CODE" },
              });
        await expect(operation).rejects.toMatchObject({
          code: "MIGRATION_METADATA_NOT_REDACTED",
          status: 422,
        });
      }
      expect(await validationEffects(fixture.batchId, fixture.rowIds[0]!)).toMatchObject({
        outcome: "STAGED",
        row_audits: 0,
        row_outbox: 0,
      });
    },
  );

  it.each(["TASK7", "TASK6"] as const)(
    "%s rejects embedded JSON and prose PII inside generic metadata values",
    async (path) => {
      const fixture = await seedFixture();
      for (const [errorCode, value] of [
        ["EMBEDDED_RECORD_BYPASS", 'record={"customer":"Alice Example"}'],
        ["PROSE_VALUE_BYPASS", "Alice Example"],
      ] as const) {
        const operation =
          path === "TASK7"
            ? recordImportRowValidation(
                fixture.validatorActor,
                {
                  importRowId: fixture.rowIds[0]!,
                  expectedRowVersion: 1,
                  decision: {
                    outcome: "REJECTED",
                    normalizedEvidenceRef: null,
                    normalizedSha256: null,
                    errorCode,
                    redactedMetadata: { detail: value },
                  },
                },
                { async verify() { throw new Error("unused"); } },
              )
            : openQuarantineItem(fixture.validatorActor, {
                importRowId: fixture.rowIds[0]!,
                expectedRowVersion: 1,
                reasonCode: errorCode,
                redactedMetadata: { detail: value },
              });
        await expect(operation).rejects.toMatchObject({
          code: "MIGRATION_METADATA_NOT_REDACTED",
          status: 422,
        });
      }
      expect(await validationEffects(fixture.batchId, fixture.rowIds[0]!)).toMatchObject({
        outcome: "STAGED",
        row_audits: 0,
        row_outbox: 0,
      });
    },
  );
});

describe("review correction: external-verifier acquisition envelope", () => {
  it("rejects a schema/version envelope change during verifier I/O with no validation effects", async () => {
    const fixture = await seedFixture();
    const ref = protectedRef("schema-barrier");
    const bytes = Buffer.from("schema-barrier");
    await expect(
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: fixture.rowIds[0]!,
          expectedRowVersion: 1,
          decision: {
            outcome: "VALID",
            normalizedEvidenceRef: ref,
            normalizedSha256: sha256(bytes),
            errorCode: null,
            redactedMetadata: {},
          },
        },
        {
          async verify() {
            await sql`
              update import_batches set schema_version = 'sales.v2'
              where id = ${fixture.batchId}
            `;
            return { ref, sha256: sha256(bytes) };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "IMPORT_BATCH_CHANGED_DURING_VERIFICATION",
      status: 409,
    });
    expect(await validationEffects(fixture.batchId, fixture.rowIds[0]!)).toEqual({
      status: "STAGED",
      outcome: "STAGED",
      normalized_ref: null,
      staged: "1",
      valid: "0",
      row_audits: 0,
      row_outbox: 0,
      batch_audits: 0,
      batch_outbox: 0,
    });
  });
});

describe("review correction: sensitive approval reasons and safe counters", () => {
  it.each([
    "reviewer@example.test",
    "+60 12-345 6789",
    "token=secret-value",
    '{"customer":"full-record"}',
    'record={"customer":"Alice Example"}',
  ])("rejects sensitive approval reason %s with no effects", async (reason) => {
    const fixture = await seedFixture(["VALID"], false);
    const validated = await validateFixture(fixture);
    await expect(
      approveImportBatch(fixture.approverActor, {
        batchId: fixture.batchId,
        expectedBatchVersion: validated.version,
        approvalMode: "FULL",
        approvalReason: reason,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPROVAL_REASON_REQUIRED", status: 422 });
    const [stored] = await sql<{
      status: string;
      reason: string | null;
      audits: number;
      outbox: number;
    }[]>`
      select batch.status, batch.approval_reason as reason,
             (select count(*)::int from audit_events where target_id = batch.id
               and action = 'MIGRATION_IMPORT_BATCH_APPROVED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
               and event_type = 'crm.migration.import_batch_approved') as outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ status: "VALIDATED", reason: null, audits: 0, outbox: 0 });
  });

  it("rejects MAX_SAFE + 1 counter arithmetic atomically", async () => {
    const fixture = await seedFixture();
    await sql`
      update import_batches
      set total_row_count = 9007199254740992,
          valid_row_count = 9007199254740991,
          staged_row_count = 1
      where id = ${fixture.batchId}
    `;
    const ref = protectedRef("unsafe-counter");
    const bytes = Buffer.from("unsafe-counter");
    await expect(
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: fixture.rowIds[0]!,
          expectedRowVersion: 1,
          decision: {
            outcome: "VALID",
            normalizedEvidenceRef: ref,
            normalizedSha256: sha256(bytes),
            errorCode: null,
            redactedMetadata: {},
          },
        },
        normalizedVerifier(ref, bytes),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_COUNTER_CONFLICT", status: 409 });
    const [stored] = await sql<{
      outcome: string;
      staged: string;
      valid: string;
      audits: number;
      outbox: number;
    }[]>`
      select row_record.outcome, batch.staged_row_count as staged,
             batch.valid_row_count as valid,
             (select count(*)::int from audit_events where target_id = row_record.id
               and action = 'MIGRATION_IMPORT_ROW_VALIDATED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = row_record.id
               and event_type = 'crm.migration.import_row_validated') as outbox
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      outcome: "STAGED",
      staged: "1",
      valid: "9007199254740991",
      audits: 0,
      outbox: 0,
    });
  });
});

describe("review correction: atomicity and serialization evidence", () => {
  it("rolls back row validation when its outbox effect fails", async () => {
    const fixture = await seedFixture();
    const initialBatchVersion = await batchVersion(fixture.batchId);
    await withRejectedOutboxEvent("crm.migration.import_row_validated", async () => {
      await expect(
        recordImportRowValidation(
          fixture.validatorActor,
          {
            importRowId: fixture.rowIds[0]!,
            expectedRowVersion: 1,
            decision: {
              outcome: "REJECTED",
              normalizedEvidenceRef: null,
              normalizedSha256: null,
              errorCode: "SYNTHETIC_EFFECT_FAILURE",
              redactedMetadata: { ruleCode: "SYNTHETIC_EFFECT_FAILURE" },
            },
          },
          { async verify() { throw new Error("unused"); } },
        ),
      ).rejects.toMatchObject({ code: "IMPORT_ROW_VALIDATION_FAILED", status: 500 });
    });
    const [stored] = await sql<{
      status: string;
      batch_version: string;
      outcome: string;
      row_version: string;
      staged: string;
      rejected: string;
      audits: number;
      outbox: number;
    }[]>`
      select batch.status, batch.version as batch_version, row_record.outcome,
             row_record.version as row_version, batch.staged_row_count as staged,
             batch.rejected_row_count as rejected,
             (select count(*)::int from audit_events where target_id = row_record.id
               and action = 'MIGRATION_IMPORT_ROW_VALIDATED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = row_record.id
               and event_type = 'crm.migration.import_row_validated') as outbox
      from import_batches batch join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      status: "STAGED",
      batch_version: String(initialBatchVersion),
      outcome: "STAGED",
      row_version: "1",
      staged: "1",
      rejected: "0",
      audits: 0,
      outbox: 0,
    });
  });

  it("rolls back batch validation when its outbox effect fails", async () => {
    const fixture = await seedFixture(["VALID"]);
    const initialBatchVersion = await batchVersion(fixture.batchId);
    await withRejectedOutboxEvent("crm.migration.import_batch_validated", async () => {
      await expect(
        validateImportBatch(fixture.validatorActor, {
          batchId: fixture.batchId,
          expectedBatchVersion: initialBatchVersion,
        }),
      ).rejects.toMatchObject({ code: "IMPORT_BATCH_VALIDATION_FAILED", status: 500 });
    });
    const [stored] = await sql<{
      status: string;
      version: string;
      validator: string | null;
      validated_at: Date | null;
      audits: number;
      outbox: number;
    }[]>`
      select batch.status, batch.version, batch.validated_by_membership_id as validator,
             batch.validated_at,
             (select count(*)::int from audit_events where target_id = batch.id
               and action = 'MIGRATION_IMPORT_BATCH_VALIDATED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
               and event_type = 'crm.migration.import_batch_validated') as outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "STAGED",
      version: String(initialBatchVersion),
      validator: null,
      validated_at: null,
      audits: 0,
      outbox: 0,
    });
  });

  it("rolls back dry-run completion when its outbox effect fails", async () => {
    const fixture = await seedFixture(["VALID"]);
    const validated = await validateFixture(fixture);
    await withRejectedOutboxEvent("crm.migration.dry_run_completed", async () => {
      await expect(
        completeDryRun(fixture.validatorActor, {
          batchId: fixture.batchId,
          expectedValidatedBatchVersion: validated.version,
        }),
      ).rejects.toMatchObject({ code: "DRY_RUN_COMPLETION_FAILED", status: 500 });
    });
    const [stored] = await sql<{
      status: string;
      version: string;
      dry_audits: number;
      dry_outbox: number;
    }[]>`
      select batch.status, batch.version,
             (select count(*)::int from audit_events where target_id = batch.id
               and action = 'MIGRATION_DRY_RUN_COMPLETED') as dry_audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
               and event_type = 'crm.migration.dry_run_completed') as dry_outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "VALIDATED",
      version: String(validated.version),
      dry_audits: 0,
      dry_outbox: 0,
    });
  });

  it("allows distinct staged rows that reviewed the same batch envelope to commit", async () => {
    const fixture = await seedFixture(["STAGED", "STAGED"]);
    const refs = [protectedRef("parallel-row-a"), protectedRef("parallel-row-b")];
    const digests = [sha256("parallel-row-a"), sha256("parallel-row-b")];
    const bothVerifiersEntered = deferred<void>();
    const releaseVerifiers = deferred<void>();
    let enteredCount = 0;
    const decisions = fixture.rowIds.map((rowId, index) =>
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: rowId,
          expectedRowVersion: 1,
          decision: {
            outcome: "VALID",
            normalizedEvidenceRef: refs[index]!,
            normalizedSha256: digests[index]!,
            errorCode: null,
            redactedMetadata: {},
          },
        },
        {
          async verify(ref) {
            enteredCount += 1;
            if (enteredCount === fixture.rowIds.length) {
              bothVerifiersEntered.resolve(undefined);
            }
            await releaseVerifiers.promise;
            return { ref, sha256: digests[index]! };
          },
        },
      ),
    );
    await bothVerifiersEntered.promise;
    releaseVerifiers.resolve(undefined);
    const outcomes = await Promise.allSettled(decisions);
    expect(outcomes).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    const [stored] = await sql<{
      staged: string;
      valid: string;
      valid_rows: number;
      audits: number;
      outbox: number;
    }[]>`
      select batch.staged_row_count as staged, batch.valid_row_count as valid,
             (select count(*)::int from import_rows where batch_id = batch.id
               and outcome = 'VALID') as valid_rows,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_VALIDATED') as audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_validated') as outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ staged: "0", valid: "2", valid_rows: 2, audits: 2, outbox: 2 });
  });

  it("serializes concurrent decisions for the same staged row to one exact effect", async () => {
    const fixture = await seedFixture();
    const rowId = fixture.rowIds[0]!;
    const normalizedRef = protectedRef("concurrent-row-decision");
    const normalizedBytes = Buffer.from("concurrent-row-decision");
    const decisions = await Promise.allSettled([
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: rowId,
          expectedRowVersion: 1,
          decision: {
            outcome: "VALID",
            normalizedEvidenceRef: normalizedRef,
            normalizedSha256: sha256(normalizedBytes),
            errorCode: null,
            redactedMetadata: {},
          },
        },
        normalizedVerifier(normalizedRef, normalizedBytes),
      ),
      recordImportRowValidation(
        fixture.validatorActor,
        {
          importRowId: rowId,
          expectedRowVersion: 1,
          decision: {
            outcome: "REJECTED",
            normalizedEvidenceRef: null,
            normalizedSha256: null,
            errorCode: "CONCURRENT_REJECTION",
            redactedMetadata: { ruleCode: "CONCURRENT_REJECTION" },
          },
        },
        { async verify() { throw new Error("unused"); } },
      ),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = decisions.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409 });
    const [stored] = await sql<{
      outcome: string;
      staged: string;
      valid: string;
      rejected: string;
      audits: number;
      outbox: number;
    }[]>`
      select row_record.outcome, batch.staged_row_count as staged,
             batch.valid_row_count as valid, batch.rejected_row_count as rejected,
             (select count(*)::int from audit_events where target_id = row_record.id
               and action = 'MIGRATION_IMPORT_ROW_VALIDATED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = row_record.id
               and event_type = 'crm.migration.import_row_validated') as outbox
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${rowId}
    `;
    expect(["VALID", "REJECTED"]).toContain(stored?.outcome);
    expect(stored).toMatchObject({ staged: "0", audits: 1, outbox: 1 });
    expect(Number(stored?.valid) + Number(stored?.rejected)).toBe(1);
  });

  it("deterministically lets a row decision serialize before batch validation", async () => {
    const fixture = await seedFixture();
    const rowId = fixture.rowIds[0]!;
    const initialBatchVersion = await batchVersion(fixture.batchId);
    const normalizedRef = protectedRef("decision-before-validation");
    const normalizedDigest = sha256("decision-before-validation");
    const verifierEntered = deferred<void>();
    const releaseVerifier = deferred<void>();
    const decision = recordImportRowValidation(
      fixture.validatorActor,
      {
        importRowId: rowId,
        expectedRowVersion: 1,
        decision: {
          outcome: "VALID",
          normalizedEvidenceRef: normalizedRef,
          normalizedSha256: normalizedDigest,
          errorCode: null,
          redactedMetadata: {},
        },
      },
      {
        async verify(ref) {
          verifierEntered.resolve(undefined);
          await releaseVerifier.promise;
          return { ref, sha256: normalizedDigest };
        },
      },
    );
    await verifierEntered.promise;

    const blocker = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
    let validation: Promise<unknown> | undefined;
    try {
      await blocker.begin(async (transaction) => {
        const [pid] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await transaction`select id from import_batches where id = ${fixture.batchId} for update`;
        releaseVerifier.resolve(undefined);
        await waitUntilBlockedCountBy(pid!.pid, 1);
        validation = validateImportBatch(fixture.validatorActor, {
          batchId: fixture.batchId,
          expectedBatchVersion: initialBatchVersion,
        });
        await waitUntilBlockedBackendCount(2);
      });
      await expect(decision).resolves.toBeUndefined();
      await expect(validation).rejects.toMatchObject({
        code: "IMPORT_BATCH_VERSION_CONFLICT",
        status: 409,
      });
    } finally {
      releaseVerifier.resolve(undefined);
      await Promise.allSettled([decision, ...(validation ? [validation] : [])]);
      await blocker.end();
    }
    const [stored] = await sql<{
      status: string;
      outcome: string;
      staged: string;
      valid: string;
      row_audits: number;
      row_outbox: number;
      batch_audits: number;
      batch_outbox: number;
    }[]>`
      select batch.status, row_record.outcome, batch.staged_row_count as staged,
             batch.valid_row_count as valid,
             (select count(*)::int from audit_events where target_id = row_record.id
               and action = 'MIGRATION_IMPORT_ROW_VALIDATED') as row_audits,
             (select count(*)::int from outbox_events where aggregate_id = row_record.id
               and event_type = 'crm.migration.import_row_validated') as row_outbox,
             (select count(*)::int from audit_events where target_id = batch.id
               and action = 'MIGRATION_IMPORT_BATCH_VALIDATED') as batch_audits,
             (select count(*)::int from outbox_events where aggregate_id = batch.id
               and event_type = 'crm.migration.import_batch_validated') as batch_outbox
      from import_batches batch join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${rowId}
    `;
    expect(stored).toEqual({
      status: "STAGED",
      outcome: "VALID",
      staged: "0",
      valid: "1",
      row_audits: 1,
      row_outbox: 1,
      batch_audits: 0,
      batch_outbox: 0,
    });
  });
});
