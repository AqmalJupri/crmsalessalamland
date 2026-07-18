import { createHash, randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabaseConnection } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRuntimeConfigForTests } from "@/server/env";
import type { MigrationActor } from "@/server/migration/contracts";
import {
  stageImportRows,
  type RawEvidenceVerifier,
  type StagedSourceRow,
  type VerifiedRawEvidence,
} from "@/server/migration/stage-batch";
import {
  assertRedactedMigrationMetadata,
  openQuarantineItem,
  resolveQuarantineItem,
  type NormalizedEvidenceVerifier,
} from "@/server/migration/quarantine";
import { seedReconciliationLifecycle } from "./reconciliation-fixture";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for import row service tests.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Import row tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, {
  max: 20,
  prepare: false,
  onnotice: () => undefined,
});
type TestSql = Sql | TransactionSql;

const SOURCE_CAPABILITY = "migration.source.manage";
const VALIDATE_CAPABILITY = "migration.validate";
const QUARANTINE_CAPABILITY = "migration.review_quarantine";

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function protectedRef(label: string): string {
  return `protected://row-tests/${label}/${randomUUID()}`;
}

async function* streamRows(
  rows: readonly StagedSourceRow[],
): AsyncGenerator<StagedSourceRow> {
  for (const row of rows) yield row;
}

interface TenantFixture {
  organizationId: string;
  businessUnitId: string;
  userId: string;
  membershipId: string;
  organizationMembershipId: string;
  roleId: string;
  actor: MigrationActor;
}

async function seedTenant(db: TestSql = sql): Promise<TenantFixture> {
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const organizationMembershipId = randomUUID();
  const roleId = randomUUID();
  await db`
    insert into organizations (id, code, name)
    values (${organizationId}, ${`org-${organizationId}`}, 'Row Test Organisation')
  `;
  await db`
    insert into business_units (id, organization_id, code, name)
    values (${businessUnitId}, ${organizationId}, ${`bu-${businessUnitId}`}, 'Row Test Unit')
  `;
  await db`
    insert into users (id, auth_subject, display_name, user_type, status)
    values (${userId}, ${`row-test:${userId}`}, 'Row Operator', 'HUMAN', 'ACTIVE')
  `;
  await db`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from, valid_until
    ) values
      (${membershipId}, ${organizationId}, ${businessUnitId}, ${userId}, 'ACTIVE',
       clock_timestamp() - interval '1 day', null),
      (${organizationMembershipId}, ${organizationId}, null, ${userId}, 'ACTIVE',
       clock_timestamp() - interval '1 day', null)
  `;
  await db`
    insert into roles (id, organization_id, key, name, status)
    values (${roleId}, ${organizationId}, ${`row-${roleId}`}, 'Migration Row Operator', 'ACTIVE')
  `;
  for (const capability of [
    SOURCE_CAPABILITY,
    VALIDATE_CAPABILITY,
    QUARANTINE_CAPABILITY,
  ]) {
    await db`
      insert into role_capabilities (organization_id, role_id, capability_key)
      values (${organizationId}, ${roleId}, ${capability})
    `;
  }
  await db`
    insert into membership_roles (organization_id, membership_id, role_id, valid_from)
    values
      (${organizationId}, ${membershipId}, ${roleId}, clock_timestamp() - interval '1 day'),
      (${organizationId}, ${organizationMembershipId}, ${roleId}, clock_timestamp() - interval '1 day')
  `;
  return {
    organizationId,
    businessUnitId,
    userId,
    membershipId,
    organizationMembershipId,
    roleId,
    actor: {
      userId,
      organizationId,
      activeMembershipId: membershipId,
      businessUnitId,
      capabilities: [SOURCE_CAPABILITY, VALIDATE_CAPABILITY, QUARANTINE_CAPABILITY],
    },
  };
}

interface BatchFixture {
  tenant: TenantFixture;
  sourceId: string;
  scopeId: string;
  headId: string;
  transformId: string;
  batchId: string;
  batchArtifactRef: string;
  batchSourceSha256: Buffer;
}

async function seedRegisteredBatch(
  tenant: TenantFixture | undefined = undefined,
): Promise<BatchFixture> {
  tenant ??= await seedTenant();
  const sourceId = randomUUID();
  const scopeId = randomUUID();
  const headId = randomUUID();
  const transformId = randomUUID();
  const batchId = randomUUID();
  const domainKey = `sales.rows_${randomUUID().replaceAll("-", "_")}`;
  const batchArtifactRef = protectedRef("batch-artifact");
  const batchSourceSha256 = sha256(`batch:${batchArtifactRef}`);
  await sql`
    insert into migration_sources (
      id, organization_id, business_unit_id, source_key, source_kind, source_mode,
      owner_membership_id, status
    ) values (
      ${sourceId}, ${tenant.organizationId}, ${tenant.businessUnitId},
      ${`source-${sourceId}`}, 'SALAM_CRM_JSON', 'ONE_TIME_MIGRATION',
      ${tenant.membershipId}, 'ACTIVE'
    )
  `;
  await sql`
    insert into migration_source_scopes (
      id, organization_id, business_unit_id, migration_source_id, domain_key,
      canonical_target, transition_mode, source_status
    ) values (
      ${scopeId}, ${tenant.organizationId}, ${tenant.businessUnitId}, ${sourceId},
      ${domainKey}, 'crm.canonical', 'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
    )
  `;
  await sql`
    insert into migration_domain_authorities (
      id, organization_id, business_unit_id, domain_key, canonical_target,
      authority_state, authority_source_scope_id
    ) values (
      ${headId}, ${tenant.organizationId}, ${tenant.businessUnitId}, ${domainKey},
      'crm.canonical', 'SHADOW_READ', ${scopeId}
    )
  `;
  await sql`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, approved_by_membership_id, approved_at
    ) values (
      ${transformId}, ${tenant.organizationId}, ${tenant.businessUnitId}, ${sourceId}, 1,
      'sales.v1', ${protectedRef("mapping")}, ${sha256(`mapping:${transformId}`)},
      ${protectedRef("manifest")}, ${sha256(`manifest:${transformId}`)},
      ${sha256(`release:${transformId}`)}, 'Reviewed synthetic row transform',
      ${tenant.membershipId}, clock_timestamp()
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run
    ) values (
      ${batchId}, ${tenant.organizationId}, ${tenant.businessUnitId}, ${sourceId},
      ${transformId}, ${batchArtifactRef}, ${batchSourceSha256}, 100,
      clock_timestamp() - interval '10 minutes', clock_timestamp() - interval '11 minutes',
      'sales.v1', 'REGISTERED', true
    )
  `;
  return {
    tenant,
    sourceId,
    scopeId,
    headId,
    transformId,
    batchId,
    batchArtifactRef,
    batchSourceSha256,
  };
}

interface RowEvidence {
  row: StagedSourceRow;
  bytes: Buffer;
}

function syntheticRow(label: string, rowNumber: bigint): RowEvidence {
  const bytes = Buffer.from(`synthetic-row:${label}:${randomUUID()}`);
  return {
    bytes,
    row: {
      sourceRowKey: `row-${label}-${randomUUID()}`,
      rowNumber,
      sourceObjectType: "synthetic.record",
      sourceRecordId: `record-${label}`,
      sourceLocator: `records/${rowNumber.toString()}`,
      expectedRowSha256: sha256(bytes),
      rawEvidenceRef: protectedRef(`raw-${label}`),
    },
  };
}

function rawVerifier(
  fixture: BatchFixture,
  evidence: readonly RowEvidence[],
  onVerify: (() => void) | undefined = undefined,
): RawEvidenceVerifier {
  const byRef = new Map(evidence.map((entry) => [entry.row.rawEvidenceRef, entry] as const));
  return {
    async verify(input): Promise<VerifiedRawEvidence> {
      onVerify?.();
      const entry = byRef.get(input.rawEvidenceRef);
      if (!entry) throw new Error("SYNTHETIC_RAW_EVIDENCE_NOT_FOUND");
      if (
        input.batchArtifactRef !== fixture.batchArtifactRef ||
        !Buffer.from(input.batchSourceSha256).equals(fixture.batchSourceSha256) ||
        input.sourceLocator !== entry.row.sourceLocator
      ) {
        throw new Error("SYNTHETIC_RAW_EVIDENCE_BINDING_FAILED");
      }
      return {
        ref: entry.row.rawEvidenceRef,
        sourceLocator: entry.row.sourceLocator,
        rowSha256: sha256(entry.bytes),
        batchSourceSha256: fixture.batchSourceSha256,
      };
    },
  };
}

async function rowSnapshot(batchId: string): Promise<unknown> {
  const [snapshot] = await sql<{ value: unknown }[]>`
    select jsonb_build_object(
      'batch', (
        select to_jsonb(batch_data) from (
          select id, status, total_row_count, staged_row_count, valid_row_count,
                 rejected_row_count, quarantined_row_count, hidden_row_count,
                 imported_row_count, no_op_row_count, version
          from import_batches where id = ${batchId}
        ) batch_data
      ),
      'rows', (
        select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.source_row_key), '[]'::jsonb)
        from (
          select id, source_row_key, row_number, source_object_type, source_record_id,
                 source_locator, encode(row_sha256, 'hex') as row_sha256,
                 raw_evidence_ref, normalized_evidence_ref,
                 encode(normalized_sha256, 'hex') as normalized_sha256,
                 outcome, error_code, error_metadata, version
          from import_rows where batch_id = ${batchId}
        ) row_data
      ),
      'audits', (
        select coalesce(jsonb_agg(to_jsonb(audit_data) order by audit_data.id), '[]'::jsonb)
        from (
          select id, action, target_id, change_summary
          from audit_events where target_id = ${batchId}
             or target_id in (select id from import_rows where batch_id = ${batchId})
             or target_id in (
               select item.id from quarantine_items item
               join import_rows row_record on row_record.id = item.import_row_id
               where row_record.batch_id = ${batchId}
             )
        ) audit_data
      ),
      'outbox', (
        select coalesce(jsonb_agg(to_jsonb(outbox_data) order by outbox_data.id), '[]'::jsonb)
        from (
          select id, event_type, aggregate_id, payload
          from outbox_events where aggregate_id = ${batchId}
             or aggregate_id in (select id from import_rows where batch_id = ${batchId})
             or aggregate_id in (
               select item.id from quarantine_items item
               join import_rows row_record on row_record.id = item.import_row_id
               where row_record.batch_id = ${batchId}
             )
        ) outbox_data
      )
    ) as value
  `;
  return snapshot?.value;
}

async function waitUntilBlockedBy(blockerPid: number): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<{ pid: number }[]>`
      select activity.pid
      from pg_stat_activity activity
      where activity.datname = ${expectedDatabaseName}
        and activity.pid <> pg_backend_pid()
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      order by activity.pid
      limit 1
    `;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected a backend to block behind PID ${blockerPid}.`);
}

async function seedFinalReconciledBatch(
  fixture: BatchFixture,
): Promise<{ finalBatchId: string; cutoffAt: Date; writeFrozenAt: Date }> {
  const dryRunId = randomUUID();
  const finalBatchId = randomUUID();
  const sourceSha = sha256(`final-cutover:${finalBatchId}`);
  const capturedAt = new Date(Date.now() - 60 * 60 * 1_000);
  const cutoffAt = new Date(capturedAt.getTime() - 60_000);
  const writeFrozenAt = new Date(cutoffAt.getTime() - 60_000);
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, total_row_count, valid_row_count,
      validated_by_membership_id, validated_at
    ) values (
      ${dryRunId}, ${fixture.tenant.organizationId}, ${fixture.tenant.businessUnitId},
      ${fixture.sourceId}, ${fixture.transformId}, ${protectedRef("final-dry")},
      ${sourceSha}, 1, ${capturedAt}, ${cutoffAt}, 'sales.v1', 'DRY_RUN_COMPLETE', true,
      1, 1, ${fixture.tenant.membershipId}, ${cutoffAt}
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
      captured_at, cutoff_at, schema_version, status, dry_run, total_row_count,
      approved_row_count, no_op_row_count, validated_by_membership_id, validated_at,
      approved_by_membership_id, approved_at, approval_mode, approval_reason,
      applied_by_membership_id, apply_run_id, apply_lease_expires_at,
      apply_started_at, applied_at
    ) values (
      ${finalBatchId}, ${fixture.tenant.organizationId}, ${fixture.tenant.businessUnitId},
      ${fixture.sourceId}, ${fixture.transformId}, ${dryRunId}, ${protectedRef("final-live")},
      ${sourceSha}, 1, ${capturedAt}, ${cutoffAt}, 'sales.v1', 'APPLIED', false,
      1, 1, 1, ${fixture.tenant.membershipId}, ${cutoffAt},
      ${fixture.tenant.membershipId}, ${new Date(cutoffAt.getTime() + 1_000)},
      'FULL', 'Synthetic reconciled cutover batch', ${fixture.tenant.membershipId},
      ${randomUUID()}, ${new Date(Date.now() + 60_000)},
      ${new Date(cutoffAt.getTime() + 2_000)}, ${new Date(cutoffAt.getTime() + 3_000)}
    )
  `;
  await seedReconciliationLifecycle(sql, {
    organizationId: fixture.tenant.organizationId,
    businessUnitId: fixture.tenant.businessUnitId,
    batchId: finalBatchId,
  });
  return { finalBatchId, cutoffAt, writeFrozenAt };
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
    AUTH_HASH_KEY: "row-tests-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "row-integration",
    OIDC_CLIENT_SECRET: "row-integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql`
    insert into capabilities (key, description, risk_level)
    values
      (${SOURCE_CAPABILITY}, 'Stage protected migration rows', 'SENSITIVE'),
      (${VALIDATE_CAPABILITY}, 'Validate migration rows', 'SENSITIVE'),
      (${QUARANTINE_CAPABILITY}, 'Review migration quarantine', 'SENSITIVE')
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("bounded protected-row staging", () => {
  it("streams more than two bounded chunks and commits exact summary/effects", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = Array.from({ length: 205 }, (_, index) =>
      syntheticRow(`stream-${index + 1}`, BigInt(index + 1)),
    );
    let verified = 0;

    const summary = await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows(evidence.map((entry) => entry.row)),
      rawVerifier(fixture, evidence, () => {
        verified += 1;
      }),
    );

    expect(verified).toBe(205);
    expect(summary).toEqual({
      totalRows: 205,
      stagedRows: 205,
      validRows: 0,
      rejectedRows: 0,
      quarantinedRows: 0,
      hiddenRows: 0,
      importedRows: 0,
      noOpRows: 0,
    });
    const transactionGroups = await sql<{ transaction_id: string; row_count: number }[]>`
      select xmin::text as transaction_id, count(*)::int as row_count
      from import_rows where batch_id = ${fixture.batchId}
      group by xmin order by xmin::text
    `;
    expect(transactionGroups.length).toBeGreaterThan(1);
    expect(Math.max(...transactionGroups.map((group) => group.row_count))).toBeLessThanOrEqual(
      100,
    );
    const [effects] = await sql<{
      status: string;
      total: string;
      staged: string;
      audits: number;
      outbox: number;
    }[]>`
      select status, total_row_count as total, staged_row_count as staged,
        (select count(*)::int from audit_events
          where target_id = ${fixture.batchId}
            and action = 'MIGRATION_IMPORT_ROWS_STAGED') as audits,
        (select count(*)::int from outbox_events
          where aggregate_id = ${fixture.batchId}
            and event_type = 'crm.migration.import_rows_staged') as outbox
      from import_batches where id = ${fixture.batchId}
    `;
    expect(effects).toEqual({
      status: "STAGED",
      total: "205",
      staged: "205",
      audits: transactionGroups.length,
      outbox: transactionGroups.length,
    });
  });

  it("leaves no database transaction open while pulling or verifying evidence", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = [syntheticRow("outside-transaction", 1n)];
    let iteratorLockChecks = 0;
    let verifierLockChecks = 0;
    async function* rows(): AsyncGenerator<StagedSourceRow> {
      await sql.begin(async (transaction) => {
        await transaction`
          select id from import_batches where id = ${fixture.batchId} for update nowait
        `;
      });
      iteratorLockChecks += 1;
      yield evidence[0]!.row;
    }
    const verifier: RawEvidenceVerifier = {
      async verify(input) {
        await sql.begin(async (transaction) => {
          await transaction`
            select id from import_batches where id = ${fixture.batchId} for update nowait
          `;
          await transaction`
            select id from migration_domain_authorities
            where id = ${fixture.headId} for update nowait
          `;
        });
        verifierLockChecks += 1;
        return rawVerifier(fixture, evidence).verify(input);
      },
    };

    await expect(
      stageImportRows(fixture.tenant.actor, fixture.batchId, rows(), verifier),
    ).resolves.toMatchObject({ totalRows: 1, stagedRows: 1 });
    expect({ iteratorLockChecks, verifierLockChecks }).toEqual({
      iteratorLockChecks: 1,
      verifierLockChecks: 1,
    });
  });

  it("transitions an empty registered batch to staged with one truthful effect", async () => {
    const fixture = await seedRegisteredBatch();
    let verifyCalls = 0;
    const summary = await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows([]),
      {
        async verify() {
          verifyCalls += 1;
          throw new Error("must not verify an absent row");
        },
      },
    );

    expect(verifyCalls).toBe(0);
    expect(summary).toEqual({
      totalRows: 0,
      stagedRows: 0,
      validRows: 0,
      rejectedRows: 0,
      quarantinedRows: 0,
      hiddenRows: 0,
      importedRows: 0,
      noOpRows: 0,
    });
    const [stored] = await sql<{ status: string; audits: number; outbox: number }[]>`
      select status,
        (select count(*)::int from audit_events where target_id = ${fixture.batchId}
          and action = 'MIGRATION_IMPORT_ROWS_STAGED') as audits,
        (select count(*)::int from outbox_events where aggregate_id = ${fixture.batchId}
          and event_type = 'crm.migration.import_rows_staged') as outbox
      from import_batches where id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ status: "STAGED", audits: 1, outbox: 1 });
  });

  it("replays the full immutable row envelope without counters or duplicate effects", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = Array.from({ length: 3 }, (_, index) =>
      syntheticRow(`replay-${index + 1}`, BigInt(index + 1)),
    );
    const verifier = rawVerifier(fixture, evidence);
    await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows(evidence.map((entry) => entry.row)),
      verifier,
    );
    const before = await rowSnapshot(fixture.batchId);

    const replay = await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows(evidence.map((entry) => ({
        ...entry.row,
        expectedRowSha256: new Uint8Array(entry.row.expectedRowSha256),
      }))),
      verifier,
    );

    expect(replay).toMatchObject({ totalRows: 3, stagedRows: 3 });
    expect(await rowSnapshot(fixture.batchId)).toEqual(before);
  });

  it("collapses concurrent exact staging to one row and one chunk effect", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = [syntheticRow("concurrent", 1n)];
    const verifier = rawVerifier(fixture, evidence);
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        stageImportRows(
          fixture.tenant.actor,
          fixture.batchId,
          streamRows([evidence[0]!.row]),
          verifier,
        ),
      ),
    );
    expect(new Set(outcomes.map((summary) => summary.totalRows))).toEqual(new Set([1]));
    const [stored] = await sql<{
      rows: number;
      total: string;
      staged: string;
      audits: number;
      outbox: number;
    }[]>`
      select
        (select count(*)::int from import_rows where batch_id = ${fixture.batchId}) as rows,
        total_row_count as total, staged_row_count as staged,
        (select count(*)::int from audit_events where target_id = ${fixture.batchId}
          and action = 'MIGRATION_IMPORT_ROWS_STAGED') as audits,
        (select count(*)::int from outbox_events where aggregate_id = ${fixture.batchId}
          and event_type = 'crm.migration.import_rows_staged') as outbox
      from import_batches where id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ rows: 1, total: "1", staged: "1", audits: 1, outbox: 1 });
  });

  it("rejects duplicate source keys and row numbers atomically within a chunk", async () => {
    const sourceKeyFixture = await seedRegisteredBatch();
    const first = syntheticRow("duplicate-source-first", 1n);
    const second = syntheticRow("duplicate-source-second", 2n);
    second.row.sourceRowKey = first.row.sourceRowKey;
    await expect(
      stageImportRows(
        sourceKeyFixture.tenant.actor,
        sourceKeyFixture.batchId,
        streamRows([first.row, second.row]),
        rawVerifier(sourceKeyFixture, [first, second]),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_SOURCE_KEY_DUPLICATE", status: 409 });

    const rowNumberFixture = await seedRegisteredBatch();
    const third = syntheticRow("duplicate-number-first", 9n);
    const fourth = syntheticRow("duplicate-number-second", 9n);
    await expect(
      stageImportRows(
        rowNumberFixture.tenant.actor,
        rowNumberFixture.batchId,
        streamRows([third.row, fourth.row]),
        rawVerifier(rowNumberFixture, [third, fourth]),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_NUMBER_DUPLICATE", status: 409 });
    const [counts] = await sql<{ source_rows: number; number_rows: number }[]>`
      select
        (select count(*)::int from import_rows
          where batch_id = ${sourceKeyFixture.batchId}) as source_rows,
        (select count(*)::int from import_rows
          where batch_id = ${rowNumberFixture.batchId}) as number_rows
    `;
    expect(counts).toEqual({ source_rows: 0, number_rows: 0 });
  });

  it("rejects a cross-chunk duplicate envelope but retains and converges committed chunks", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = Array.from({ length: 101 }, (_, index) =>
      syntheticRow(`cross-chunk-${index + 1}`, BigInt(index + 1)),
    );
    evidence[100]!.row.sourceRowKey = evidence[0]!.row.sourceRowKey;
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows(evidence.map((entry) => entry.row)),
        rawVerifier(fixture, evidence),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_REPLAY_CONFLICT", status: 409 });
    const [afterFailure] = await sql<{ rows: number; total: string }[]>`
      select (select count(*)::int from import_rows where batch_id = ${fixture.batchId}) as rows,
             total_row_count as total
      from import_batches where id = ${fixture.batchId}
    `;
    expect(afterFailure).toEqual({ rows: 100, total: "100" });

    const replacement = syntheticRow("cross-chunk-replacement", 101n);
    const convergent = [...evidence.slice(0, 100), replacement];
    const summary = await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows(convergent.map((entry) => entry.row)),
      rawVerifier(fixture, convergent),
    );
    expect(summary).toMatchObject({ totalRows: 101, stagedRows: 101 });
  });

  it("converges after the source iterator crashes between committed chunks", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = Array.from({ length: 101 }, (_, index) =>
      syntheticRow(`crash-${index + 1}`, BigInt(index + 1)),
    );
    async function* crashingRows(): AsyncGenerator<StagedSourceRow> {
      for (let index = 0; index < 100; index += 1) yield evidence[index]!.row;
      throw new Error("SYNTHETIC_PRIVATE_ITERATOR_FAILURE");
    }
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        crashingRows(),
        rawVerifier(fixture, evidence),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_STREAM_FAILED", status: 422 });
    const [partial] = await sql<{ rows: number; total: string }[]>`
      select (select count(*)::int from import_rows where batch_id = ${fixture.batchId}) as rows,
             total_row_count as total
      from import_batches where id = ${fixture.batchId}
    `;
    expect(partial).toEqual({ rows: 100, total: "100" });

    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows(evidence.map((entry) => entry.row)),
        rawVerifier(fixture, evidence),
      ),
    ).resolves.toMatchObject({ totalRows: 101, stagedRows: 101 });
  });
});

describe("raw evidence authority and tenant boundaries", () => {
  it("rejects invalid caller SHA length before invoking the verifier", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("invalid-sha", 1n);
    evidence.row.expectedRowSha256 = new Uint8Array(31);
    let verifierCalls = 0;
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify() {
            verifierCalls += 1;
            throw new Error("must not be called");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "SHA256_DIGEST_INVALID", status: 422 });
    expect(verifierCalls).toBe(0);
  });

  it("treats the caller digest only as a comparison against verified bytes", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("caller-mismatch", 1n);
    evidence.row.expectedRowSha256 = sha256("caller-reviewed-different-bytes");
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        rawVerifier(fixture, [evidence]),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_CHECKSUM_MISMATCH", status: 422 });
  });

  it.each([
    {
      name: "reference",
      expectedCode: "RAW_EVIDENCE_BINDING_INVALID",
      mutate: (verified: VerifiedRawEvidence) => ({
        ...verified,
        ref: protectedRef("substituted-ref"),
      }),
    },
    {
      name: "locator",
      expectedCode: "RAW_EVIDENCE_BINDING_INVALID",
      mutate: (verified: VerifiedRawEvidence) => ({
        ...verified,
        sourceLocator: "records/substituted",
      }),
    },
    {
      name: "row digest",
      expectedCode: "IMPORT_ROW_CHECKSUM_MISMATCH",
      mutate: (verified: VerifiedRawEvidence) => ({
        ...verified,
        rowSha256: sha256("substituted-row"),
      }),
    },
    {
      name: "batch checksum",
      expectedCode: "RAW_EVIDENCE_BINDING_INVALID",
      mutate: (verified: VerifiedRawEvidence) => ({
        ...verified,
        batchSourceSha256: sha256("substituted-batch"),
      }),
    },
  ])("rejects a verifier-substituted $name", async ({ mutate, expectedCode }) => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("substitution", 1n);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            return mutate(await trusted.verify(input));
          },
        },
      ),
    ).rejects.toMatchObject({ code: expectedCode, status: 422 });
    const [count] = await sql<{ rows: number }[]>`
      select count(*)::int as rows from import_rows where batch_id = ${fixture.batchId}
    `;
    expect(count).toEqual({ rows: 0 });
  });

  it.each([
    null,
    {},
    {
      ref: "protected://row-tests/malformed/value",
      sourceLocator: "records/1",
      rowSha256: new Uint8Array(31),
      batchSourceSha256: new Uint8Array(32),
    },
  ])("rejects malformed verifier output %#", async (malformed) => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("malformed", 1n);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify() {
            return malformed as VerifiedRawEvidence;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "RAW_EVIDENCE_BINDING_INVALID", status: 422 });
  });

  it("maps verifier failures without exposing private adapter details", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("verifier-throws", 1n);
    let error: unknown;
    try {
      await stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify() {
            throw new Error("PRIVATE_CUSTOMER_PHONE_0123456789");
          },
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "RAW_EVIDENCE_VERIFICATION_FAILED", status: 422 });
    expect(String(error)).not.toContain("0123456789");
  });

  it("maps hostile stream and verifier accessors without exposing private details", async () => {
    const fixture = await seedRegisteredBatch();
    const hiddenStreamDetail = "PRIVATE_STREAM_CUSTOMER_0123456789";
    const hostileRows = Object.defineProperty({}, Symbol.asyncIterator, {
      get() {
        throw new Error(hiddenStreamDetail);
      },
    }) as AsyncIterable<StagedSourceRow>;
    let streamError: unknown;
    try {
      await stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        hostileRows,
        { async verify() { throw new Error("must not verify"); } },
      );
    } catch (caught) {
      streamError = caught;
    }
    expect(streamError).toMatchObject({ code: "IMPORT_ROW_STREAM_FAILED", status: 422 });
    expect(String(streamError)).not.toContain(hiddenStreamDetail);

    const hiddenVerifierDetail = "PRIVATE_VERIFIER_CUSTOMER_email@example.test";
    const hostileVerifier = Object.defineProperty({}, "verify", {
      get() {
        throw new Error(hiddenVerifierDetail);
      },
    }) as RawEvidenceVerifier;
    let verifierError: unknown;
    try {
      await stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([]),
        hostileVerifier,
      );
    } catch (caught) {
      verifierError = caught;
    }
    expect(verifierError).toMatchObject({ code: "IMPORT_ROW_INPUT_INVALID", status: 422 });
    expect(String(verifierError)).not.toContain(hiddenVerifierDetail);
  });

  it("copies caller digest bytes before an untrusted verifier can mutate its input", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("byte-alias", 1n);
    const expectedBefore = Buffer.from(evidence.row.expectedRowSha256);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            const verified = await trusted.verify(input);
            input.expectedRowSha256.fill(0);
            return verified;
          },
        },
      ),
    ).resolves.toMatchObject({ totalRows: 1 });
    expect(Buffer.from(evidence.row.expectedRowSha256)).toEqual(expectedBefore);
  });

  it("conceals cross-tenant batches before any protected evidence access", async () => {
    const owner = await seedRegisteredBatch();
    const foreign = await seedTenant();
    const evidence = syntheticRow("cross-tenant", 1n);
    let verifierCalls = 0;
    await expect(
      stageImportRows(
        foreign.actor,
        owner.batchId,
        streamRows([evidence.row]),
        {
          async verify() {
            verifierCalls += 1;
            throw new Error("must not access foreign evidence");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_NOT_FOUND", status: 404 });
    expect(verifierCalls).toBe(0);
  });

  it("rechecks live membership after verification and before persistence", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("revoked-after-verifier", 1n);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            const verified = await trusted.verify(input);
            await sql`
              update memberships set status = 'REVOKED'
              where organization_id = ${fixture.tenant.organizationId}
                and id = ${fixture.tenant.membershipId}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });
    const [count] = await sql<{ rows: number }[]>`
      select count(*)::int as rows from import_rows where batch_id = ${fixture.batchId}
    `;
    expect(count).toEqual({ rows: 0 });
  });

  it("rechecks live database capability after verification", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("capability-revoked", 1n);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            const verified = await trusted.verify(input);
            await sql`
              delete from role_capabilities
              where organization_id = ${fixture.tenant.organizationId}
                and role_id = ${fixture.tenant.roleId}
                and capability_key = ${SOURCE_CAPABILITY}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    const [count] = await sql<{ rows: number }[]>`
      select count(*)::int as rows from import_rows where batch_id = ${fixture.batchId}
    `;
    expect(count).toEqual({ rows: 0 });
  });

  it("rechecks the batch envelope/version after verifier I/O", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("batch-version-race", 1n);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            const verified = await trusted.verify(input);
            await sql`
              update import_batches set operator_reason = 'Synthetic verifier race marker'
              where id = ${fixture.batchId}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "IMPORT_BATCH_CHANGED_DURING_VERIFICATION",
      status: 409,
    });
  });

  it("rejects a version-only batch mutation before writing a newly verified row", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("batch-version-only-race", 1n);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            const verified = await trusted.verify(input);
            await sql`
              update import_batches set updated_at = clock_timestamp()
              where id = ${fixture.batchId}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "IMPORT_BATCH_CHANGED_DURING_VERIFICATION",
      status: 409,
    });
    const [count] = await sql<{ rows: number }[]>`
      select count(*)::int as rows from import_rows where batch_id = ${fixture.batchId}
    `;
    expect(count).toEqual({ rows: 0 });
  });

  it("closes the async source iterator when row validation rejects a chunk", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = Array.from({ length: 100 }, (_, index) =>
      syntheticRow(`iterator-close-${index + 1}`, BigInt(index + 1)),
    );
    evidence[0]!.row.expectedRowSha256 = new Uint8Array(31);
    let closed = false;
    async function* rows(): AsyncGenerator<StagedSourceRow> {
      try {
        for (const entry of evidence) yield entry.row;
      } finally {
        closed = true;
      }
    }
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        rows(),
        { async verify() { throw new Error("must not verify"); } },
      ),
    ).rejects.toMatchObject({ code: "SHA256_DIGEST_INVALID", status: 422 });
    expect(closed).toBe(true);
  });

  it("preserves the primary sanitized error when the iterator return accessor is hostile", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("hostile-return-accessor", 1n);
    evidence.row.expectedRowSha256 = new Uint8Array(31);
    const hiddenDetail = "PRIVATE_RETURN_ACCESSOR_CUSTOMER_0123456789";
    let pulls = 0;
    const iterator = Object.defineProperty(
      {
        async next(): Promise<IteratorResult<StagedSourceRow>> {
          pulls += 1;
          return pulls === 1
            ? { done: false, value: evidence.row }
            : { done: true, value: undefined };
        },
      },
      "return",
      {
        get() {
          throw new Error(hiddenDetail);
        },
      },
    ) as AsyncIterator<StagedSourceRow>;
    const rows: AsyncIterable<StagedSourceRow> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    let error: unknown;
    try {
      await stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        rows,
        { async verify() { throw new Error("must not verify"); } },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SHA256_DIGEST_INVALID", status: 422 });
    expect(String(error)).not.toContain(hiddenDetail);
  });

  it("rechecks source authority after verifier I/O", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("authority-race", 1n);
    const trusted = rawVerifier(fixture, [evidence]);
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([evidence.row]),
        {
          async verify(input) {
            const verified = await trusted.verify(input);
            await sql`
              update migration_sources set status = 'ARCHIVED_READ_ONLY'
              where id = ${fixture.sourceId}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_NOT_ACTIVE", status: 409 });
    const [count] = await sql<{ rows: number }[]>`
      select count(*)::int as rows from import_rows where batch_id = ${fixture.batchId}
    `;
    expect(count).toEqual({ rows: 0 });
  });

  it("rolls back row, counters, audit, and outbox when an effect insert fails", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = syntheticRow("atomic-effect-failure", 1n);
    await sql.unsafe(`
      create function crm_test_reject_row_stage_outbox() returns trigger
      language plpgsql as $$
      begin
        if new.aggregate_id = '${fixture.batchId}'::uuid
           and new.event_type = 'crm.migration.import_rows_staged' then
          raise exception 'synthetic outbox failure';
        end if;
        return new;
      end; $$;
      create trigger crm_test_reject_row_stage_outbox_trigger
      before insert on outbox_events
      for each row execute function crm_test_reject_row_stage_outbox();
    `);
    try {
      await expect(
        stageImportRows(
          fixture.tenant.actor,
          fixture.batchId,
          streamRows([evidence.row]),
          rawVerifier(fixture, [evidence]),
        ),
      ).rejects.toMatchObject({ code: "IMPORT_ROW_STAGE_FAILED", status: 500 });
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_reject_row_stage_outbox_trigger on outbox_events;
        drop function if exists crm_test_reject_row_stage_outbox();
      `);
    }
    const [stored] = await sql<{
      rows: number;
      status: string;
      total: string;
      audits: number;
      outbox: number;
    }[]>`
      select
        (select count(*)::int from import_rows where batch_id = ${fixture.batchId}) as rows,
        status, total_row_count as total,
        (select count(*)::int from audit_events where target_id = ${fixture.batchId}
          and action = 'MIGRATION_IMPORT_ROWS_STAGED') as audits,
        (select count(*)::int from outbox_events where aggregate_id = ${fixture.batchId}
          and event_type = 'crm.migration.import_rows_staged') as outbox
      from import_batches where id = ${fixture.batchId}
    `;
    expect(stored).toEqual({ rows: 0, status: "REGISTERED", total: "0", audits: 0, outbox: 0 });
  });
});

interface StoredRowFixture {
  evidence: RowEvidence;
  rowId: string;
  rowVersion: number;
}

async function stageOneRow(
  fixture: BatchFixture,
  label: string,
): Promise<StoredRowFixture> {
  const evidence = syntheticRow(label, 1n);
  await stageImportRows(
    fixture.tenant.actor,
    fixture.batchId,
    streamRows([evidence.row]),
    rawVerifier(fixture, [evidence]),
  );
  const [stored] = await sql<{ id: string; version: string }[]>`
    select id, version from import_rows
    where organization_id = ${fixture.tenant.organizationId}
      and batch_id = ${fixture.batchId}
      and source_row_key = ${evidence.row.sourceRowKey}
  `;
  if (!stored) throw new Error("Synthetic staged row was not stored.");
  return { evidence, rowId: stored.id, rowVersion: Number(stored.version) };
}

async function openSyntheticQuarantine(
  fixture: BatchFixture,
  row: StoredRowFixture,
  reasonCode = "AMBIGUOUS_SOURCE_STATE",
): Promise<{ quarantineItemId: string; itemVersion: number; rowVersion: number }> {
  const result = await openQuarantineItem(fixture.tenant.actor, {
    importRowId: row.rowId,
    expectedRowVersion: row.rowVersion,
    reasonCode,
    redactedMetadata: { fieldCode: "legacy_status", ruleCode: "UNMAPPED_ENUM" },
  });
  const [stored] = await sql<{ item_version: string; row_version: string }[]>`
    select item.version as item_version, row_record.version as row_version
    from quarantine_items item
    join import_rows row_record on row_record.id = item.import_row_id
    where item.id = ${result.quarantineItemId}
  `;
  if (!stored) throw new Error("Synthetic quarantine item was not stored.");
  return {
    quarantineItemId: result.quarantineItemId,
    itemVersion: Number(stored.item_version),
    rowVersion: Number(stored.row_version),
  };
}

function normalizedVerifier(
  ref: string,
  bytes: Uint8Array,
  onVerify: (() => void) | undefined = undefined,
): NormalizedEvidenceVerifier {
  return {
    async verify(candidateRef, expectedSha256) {
      onVerify?.();
      if (candidateRef !== ref) throw new Error("SYNTHETIC_NORMALIZED_REF_NOT_FOUND");
      const digest = sha256(bytes);
      if (
        expectedSha256 !== null &&
        !Buffer.from(expectedSha256).equals(digest)
      ) {
        throw new Error("SYNTHETIC_NORMALIZED_CHECKSUM_MISMATCH");
      }
      return { ref, sha256: digest };
    },
  };
}

describe("redacted quarantine creation", () => {
  it.each([
    { label: "email", metadata: { detail: "customer@example.test" } },
    { label: "phone", metadata: { detail: "+60 12-345 6789" } },
    { label: "credential key", metadata: { apiToken: "redacted" } },
    { label: "credential value", metadata: { detail: "Bearer abc.def.ghi" } },
    { label: "full JSON record", metadata: { detail: '{"name":"Synthetic Person"}' } },
    { label: "nested leakage", metadata: { details: [{ nested: { email: "a@b.test" } }] } },
  ])("rejects $label without echoing raw metadata", async ({ metadata }) => {
    let error: unknown;
    try {
      assertRedactedMigrationMetadata(metadata, "redactedMetadata");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "MIGRATION_METADATA_NOT_REDACTED", status: 422 });
    expect(String(error)).not.toContain(JSON.stringify(metadata));
  });

  it("rejects excessive metadata depth, size, arrays, and object breadth", () => {
    expect(() =>
      assertRedactedMigrationMetadata(
        { a: { b: { c: { d: { e: { f: "too-deep" } } } } } },
        "redactedMetadata",
      ),
    ).toThrowError(expect.objectContaining({ code: "MIGRATION_METADATA_NOT_REDACTED" }));
    expect(() =>
      assertRedactedMigrationMetadata(
        { values: Array.from({ length: 129 }, (_, index) => `code-${index}`) },
        "redactedMetadata",
      ),
    ).toThrowError(expect.objectContaining({ code: "MIGRATION_METADATA_NOT_REDACTED" }));
    expect(() =>
      assertRedactedMigrationMetadata({ detail: "x".repeat(8_193) }, "redactedMetadata"),
    ).toThrowError(expect.objectContaining({ code: "MIGRATION_METADATA_NOT_REDACTED" }));
  });

  it("replays an exact open reason, conflicts on changed metadata, and preserves distinct reasons", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "one-open");
    const opened = await openSyntheticQuarantine(fixture, row, "FIRST_REVIEW_REASON");
    const replay = await openQuarantineItem(fixture.tenant.actor, {
      importRowId: row.rowId,
      expectedRowVersion: row.rowVersion,
      reasonCode: "FIRST_REVIEW_REASON",
      redactedMetadata: { fieldCode: "legacy_status", ruleCode: "UNMAPPED_ENUM" },
    });
    expect(replay).toEqual({ quarantineItemId: opened.quarantineItemId, replayed: true });
    await expect(
      openQuarantineItem(fixture.tenant.actor, {
        importRowId: row.rowId,
        expectedRowVersion: opened.rowVersion,
        reasonCode: "FIRST_REVIEW_REASON",
        redactedMetadata: { fieldCode: "legacy_status", ruleCode: "DIFFERENT_RULE" },
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_IDEMPOTENCY_CONFLICT", status: 409 });
    const second = await openQuarantineItem(fixture.tenant.actor, {
      importRowId: row.rowId,
      expectedRowVersion: opened.rowVersion,
      reasonCode: "SECOND_REVIEW_REASON",
      redactedMetadata: { fieldCode: "identity", ruleCode: "AMBIGUOUS_MATCH" },
    });
    expect(second).toEqual({ quarantineItemId: expect.any(String), replayed: false });
    const [stored] = await sql<{
      items: number;
      quarantined: string;
      staged: string;
      row_outcome: string;
      audits: number;
      outbox: number;
    }[]>`
      select
        (select count(*)::int from quarantine_items where import_row_id = ${row.rowId}) as items,
        batch.quarantined_row_count as quarantined,
        batch.staged_row_count as staged,
        row_record.outcome as row_outcome,
        (select count(*)::int from audit_events where target_id = ${row.rowId}
          and action = 'MIGRATION_IMPORT_ROW_QUARANTINED') as audits,
        (select count(*)::int from outbox_events where aggregate_id = ${row.rowId}
          and event_type = 'crm.migration.import_row_quarantined') as outbox
      from import_batches batch
      join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${row.rowId}
    `;
    expect(stored).toEqual({
      items: 2,
      quarantined: "1",
      staged: "0",
      row_outcome: "QUARANTINED",
      audits: 2,
      outbox: 2,
    });
  });

  it("serializes concurrent same-reason creation to one exact replayable item", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "concurrent-open");
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        openQuarantineItem(fixture.tenant.actor, {
          importRowId: row.rowId,
          expectedRowVersion: row.rowVersion,
          reasonCode: "CONCURRENT_REASON",
          redactedMetadata: { fieldCode: "identity", ruleCode: "SAME_RULE" },
        }),
      ),
    );
    expect(new Set(outcomes.map((outcome) => outcome.quarantineItemId))).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(7);
    const [count] = await sql<{ items: number }[]>`
      select count(*)::int as items from quarantine_items
      where import_row_id = ${row.rowId} and status = 'OPEN'
    `;
    expect(count).toEqual({ items: 1 });
  });

  it("fails closed when an exact open-reason replay is orphaned from row summary state", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "orphaned-open-replay");
    const opened = await openSyntheticQuarantine(fixture, row, "ORPHANED_REASON");
    await sql.begin(async (transaction) => {
      await transaction`
        update import_rows set outcome = 'STAGED', error_code = null, error_metadata = '{}'::jsonb
        where id = ${row.rowId}
      `;
      await transaction`
        update import_batches set staged_row_count = 1, quarantined_row_count = 0
        where id = ${fixture.batchId}
      `;
    });
    await expect(
      openQuarantineItem(fixture.tenant.actor, {
        importRowId: row.rowId,
        expectedRowVersion: opened.rowVersion,
        reasonCode: "ORPHANED_REASON",
        redactedMetadata: { fieldCode: "legacy_status", ruleCode: "UNMAPPED_ENUM" },
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_STATE_CONFLICT", status: 409 });
  });

  it("does not reopen a resolved reason when an old open command is retried", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "resolved-open-retry");
    const reasonB = await openSyntheticQuarantine(fixture, row, "REASON_B_REMAINS_OPEN");
    const originalReasonAInput = {
      importRowId: row.rowId,
      expectedRowVersion: reasonB.rowVersion,
      reasonCode: "REASON_A_REVIEWED",
      redactedMetadata: { fieldCode: "identity", ruleCode: "AMBIGUOUS_MATCH" },
    };
    const reasonA = await openQuarantineItem(fixture.tenant.actor, originalReasonAInput);
    const [versions] = await sql<{ item_version: string; row_version: string }[]>`
      select item.version as item_version, row_record.version as row_version
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${reasonA.quarantineItemId}
    `;
    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: reasonA.quarantineItemId,
        disposition: "REJECT_ROW",
        resolutionReason: "Reason A explicitly reviewed and rejected",
        correctedNormalizedEvidenceRef: null,
        expectedNormalizedSha256: null,
        expectedItemVersion: Number(versions!.item_version),
        expectedRowVersion: Number(versions!.row_version),
      },
      { async verify() { throw new Error("must not verify rejection"); } },
    );
    await expect(
      openQuarantineItem(fixture.tenant.actor, originalReasonAInput),
    ).rejects.toMatchObject({ code: "QUARANTINE_VERSION_CONFLICT", status: 409 });
    const [stored] = await sql<{ reason_a_items: number; open_b: number; outcome: string }[]>`
      select
        (select count(*)::int from quarantine_items
          where import_row_id = ${row.rowId} and reason_code = 'REASON_A_REVIEWED') as reason_a_items,
        (select count(*)::int from quarantine_items
          where import_row_id = ${row.rowId} and reason_code = 'REASON_B_REMAINS_OPEN'
            and status = 'OPEN') as open_b,
        outcome
      from import_rows where id = ${row.rowId}
    `;
    expect(stored).toEqual({ reason_a_items: 1, open_b: 1, outcome: "QUARANTINED" });
  });
});

describe("versioned quarantine resolution", () => {
  it("approves only exact corrected verified evidence and commits all effects atomically", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "approve-corrected");
    const opened = await openSyntheticQuarantine(fixture, row);
    const correctedRef = protectedRef("normalized-corrected");
    const correctedBytes = Buffer.from("synthetic-corrected-normalized-record");
    const correctedSha = sha256(correctedBytes);
    const [before] = await sql<{
      raw_ref: string;
      row_sha: Buffer;
      source_locator: string;
    }[]>`
      select raw_evidence_ref as raw_ref, row_sha256 as row_sha,
             source_locator from import_rows where id = ${row.rowId}
    `;

    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: opened.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "Reviewed against the signed normalized schema",
        correctedNormalizedEvidenceRef: correctedRef,
        expectedNormalizedSha256: correctedSha,
        expectedItemVersion: opened.itemVersion,
        expectedRowVersion: opened.rowVersion,
      },
      normalizedVerifier(correctedRef, correctedBytes),
    );

    const [stored] = await sql<{
      item_status: string;
      resolution: string;
      resolved_by: string;
      resolution_reason: string;
      row_outcome: string;
      normalized_ref: string;
      normalized_sha: Buffer;
      raw_ref: string;
      row_sha: Buffer;
      source_locator: string;
      valid: string;
      quarantined: string;
      audits: number;
      outbox: number;
    }[]>`
      select item.status as item_status, item.resolution,
             item.resolved_by_membership_id as resolved_by,
             item.resolution_reason,
             row_record.outcome as row_outcome,
             row_record.normalized_evidence_ref as normalized_ref,
             row_record.normalized_sha256 as normalized_sha,
             row_record.raw_evidence_ref as raw_ref,
             row_record.row_sha256 as row_sha,
             row_record.source_locator,
             batch.valid_row_count as valid,
             batch.quarantined_row_count as quarantined,
             (select count(*)::int from audit_events where target_id = item.id
               and action = 'MIGRATION_QUARANTINE_RESOLVED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = item.id
               and event_type = 'crm.migration.quarantine_resolved') as outbox
      from quarantine_items item
      join import_rows row_record on row_record.id = item.import_row_id
      join import_batches batch on batch.id = row_record.batch_id
      where item.id = ${opened.quarantineItemId}
    `;
    expect(stored).toMatchObject({
      item_status: "RESOLVED",
      resolution: "APPROVE_ROW",
      resolved_by: fixture.tenant.membershipId,
      resolution_reason: "Reviewed against the signed normalized schema",
      row_outcome: "VALID",
      normalized_ref: correctedRef,
      raw_ref: before!.raw_ref,
      source_locator: before!.source_locator,
      valid: "1",
      quarantined: "0",
      audits: 1,
      outbox: 1,
    });
    expect(Buffer.from(stored!.normalized_sha)).toEqual(correctedSha);
    expect(Buffer.from(stored!.row_sha)).toEqual(Buffer.from(before!.row_sha));
  });

  it("reuses already verified normalized evidence without invoking the verifier", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "approve-existing");
    const existingRef = protectedRef("normalized-existing");
    const existingSha = sha256("already-verified-normalized");
    await sql`
      update import_rows
      set normalized_evidence_ref = ${existingRef}, normalized_sha256 = ${existingSha}
      where id = ${row.rowId}
    `;
    const [versioned] = await sql<{ version: string }[]>`
      select version from import_rows where id = ${row.rowId}
    `;
    row.rowVersion = Number(versioned!.version);
    const opened = await openSyntheticQuarantine(fixture, row);
    let verifierCalls = 0;

    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: opened.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "Reused prior schema-verified normalized evidence",
        correctedNormalizedEvidenceRef: null,
        expectedNormalizedSha256: null,
        expectedItemVersion: opened.itemVersion,
        expectedRowVersion: opened.rowVersion,
      },
      {
        async verify() {
          verifierCalls += 1;
          throw new Error("must not reverify persisted normalized evidence");
        },
      },
    );
    expect(verifierCalls).toBe(0);
    const [stored] = await sql<{ ref: string; sha: Buffer; outcome: string }[]>`
      select normalized_evidence_ref as ref, normalized_sha256 as sha, outcome
      from import_rows where id = ${row.rowId}
    `;
    expect(stored).toMatchObject({ ref: existingRef, outcome: "VALID" });
    expect(Buffer.from(stored!.sha)).toEqual(existingSha);
  });

  it("requires a bounded redacted reason and forbids every corrected input for rejection", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "reject-contract");
    const opened = await openSyntheticQuarantine(fixture, row);
    const correctedRef = protectedRef("reject-corrected");
    const correctedSha = sha256("reject-corrected");
    let verifierCalls = 0;
    const verifier: NormalizedEvidenceVerifier = {
      async verify() {
        verifierCalls += 1;
        return { ref: correctedRef, sha256: correctedSha };
      },
    };

    for (const resolutionReason of ["", "   ", "012-3456789", "x".repeat(2_001)]) {
      await expect(
        resolveQuarantineItem(
          fixture.tenant.actor,
          {
            quarantineItemId: opened.quarantineItemId,
            disposition: "REJECT_ROW",
            resolutionReason,
            correctedNormalizedEvidenceRef: null,
            expectedNormalizedSha256: null,
            expectedItemVersion: opened.itemVersion,
            expectedRowVersion: opened.rowVersion,
          },
          verifier,
        ),
      ).rejects.toMatchObject({ code: "QUARANTINE_RESOLUTION_INVALID", status: 422 });
    }
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "REJECT_ROW",
          resolutionReason: "Rejected after reviewed source ambiguity",
          correctedNormalizedEvidenceRef: correctedRef,
          expectedNormalizedSha256: correctedSha,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        verifier,
      ),
    ).rejects.toMatchObject({ code: "QUARANTINE_CORRECTION_FORBIDDEN", status: 422 });
    expect(verifierCalls).toBe(0);
  });

  it("rejects a row while preserving immutable raw and existing normalized evidence", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "reject-row");
    const existingRef = protectedRef("normalized-rejected-existing");
    const existingSha = sha256("rejected-existing-normalized");
    await sql`
      update import_rows set normalized_evidence_ref = ${existingRef},
        normalized_sha256 = ${existingSha} where id = ${row.rowId}
    `;
    const [versioned] = await sql<{ version: string }[]>`
      select version from import_rows where id = ${row.rowId}
    `;
    row.rowVersion = Number(versioned!.version);
    const opened = await openSyntheticQuarantine(fixture, row, "UNSUPPORTED_STATE");
    const before = await rowSnapshot(fixture.batchId);
    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: opened.quarantineItemId,
        disposition: "REJECT_ROW",
        resolutionReason: "Rejected after explicit reviewed disposition",
        correctedNormalizedEvidenceRef: null,
        expectedNormalizedSha256: null,
        expectedItemVersion: opened.itemVersion,
        expectedRowVersion: opened.rowVersion,
      },
      {
        async verify() {
          throw new Error("must not verify a rejection");
        },
      },
    );
    const [stored] = await sql<{
      outcome: string;
      error_code: string;
      normalized_ref: string;
      normalized_sha: Buffer;
      rejected: string;
      quarantined: string;
      raw_ref: string;
      row_sha: Buffer;
    }[]>`
      select row_record.outcome, row_record.error_code,
             row_record.normalized_evidence_ref as normalized_ref,
             row_record.normalized_sha256 as normalized_sha,
             batch.rejected_row_count as rejected,
             batch.quarantined_row_count as quarantined,
             row_record.raw_evidence_ref as raw_ref,
             row_record.row_sha256 as row_sha
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${row.rowId}
    `;
    expect(stored).toMatchObject({
      outcome: "REJECTED",
      error_code: "UNSUPPORTED_STATE",
      normalized_ref: existingRef,
      rejected: "1",
      quarantined: "0",
    });
    expect(Buffer.from(stored!.normalized_sha)).toEqual(existingSha);
    expect(JSON.stringify(before)).toContain(stored!.raw_ref);
    expect(JSON.stringify(before)).toContain(Buffer.from(stored!.row_sha).toString("hex"));
  });

  it("rejects approval without persisted or corrected verified normalized evidence", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "approve-missing-normalized");
    const opened = await openSyntheticQuarantine(fixture, row);
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Attempted approval without normalized evidence",
          correctedNormalizedEvidenceRef: null,
          expectedNormalizedSha256: null,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify() {
            throw new Error("must not be called");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "QUARANTINE_NORMALIZED_EVIDENCE_REQUIRED", status: 409 });
  });

  it("rejects an unprotected persisted normalized reference before approval", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "approve-unprotected-existing");
    await sql`
      update import_rows set normalized_evidence_ref = 'https://public.example.test/raw.json',
        normalized_sha256 = ${sha256("unprotected-existing")}
      where id = ${row.rowId}
    `;
    const [versioned] = await sql<{ version: string }[]>`
      select version from import_rows where id = ${row.rowId}
    `;
    row.rowVersion = Number(versioned!.version);
    const opened = await openSyntheticQuarantine(fixture, row);
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Attempted reuse of unprotected normalized evidence",
          correctedNormalizedEvidenceRef: null,
          expectedNormalizedSha256: null,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        { async verify() { throw new Error("must not verify persisted evidence"); } },
      ),
    ).rejects.toMatchObject({ code: "PROTECTED_ARTIFACT_REF_INVALID", status: 422 });
  });

  it.each([
    {
      name: "reference",
      mutate: (ref: string, digest: Buffer) => ({ ref: protectedRef("substitute"), sha256: digest }),
    },
    {
      name: "digest",
      mutate: (ref: string) => ({ ref, sha256: sha256("substituted-normalized") }),
    },
    {
      name: "digest length",
      mutate: (ref: string) => ({ ref, sha256: new Uint8Array(31) }),
    },
  ])("rejects corrected verifier-substituted $name", async ({ mutate }) => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, `corrected-substitution-${randomUUID()}`);
    const opened = await openSyntheticQuarantine(fixture, row);
    const correctedRef = protectedRef("corrected-substitution");
    const correctedSha = sha256("corrected-substitution");
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed corrected normalized evidence",
          correctedNormalizedEvidenceRef: correctedRef,
          expectedNormalizedSha256: correctedSha,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify() {
            return mutate(correctedRef, correctedSha);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "NORMALIZED_EVIDENCE_BINDING_INVALID", status: 422 });
    const [stored] = await sql<{ status: string; outcome: string }[]>`
      select item.status, row_record.outcome
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${opened.quarantineItemId}
    `;
    expect(stored).toEqual({ status: "OPEN", outcome: "QUARANTINED" });
  });

  it("maps corrected verifier failures without leaking adapter detail", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "corrected-verifier-throws");
    const opened = await openSyntheticQuarantine(fixture, row);
    const correctedRef = protectedRef("corrected-throws");
    const correctedSha = sha256("corrected-throws");
    let error: unknown;
    try {
      await resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed corrected normalized evidence",
          correctedNormalizedEvidenceRef: correctedRef,
          expectedNormalizedSha256: correctedSha,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify() {
            throw new Error("PRIVATE_NORMALIZED_CUSTOMER_email@example.test");
          },
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "NORMALIZED_EVIDENCE_VERIFICATION_FAILED",
      status: 422,
    });
    expect(String(error)).not.toContain("email@example.test");
  });

  it("maps a hostile normalized verifier accessor without leaking adapter detail", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "corrected-verifier-accessor");
    const opened = await openSyntheticQuarantine(fixture, row);
    const correctedRef = protectedRef("corrected-accessor");
    const hiddenDetail = "PRIVATE_NORMALIZED_ACCESSOR_email@example.test";
    const hostileVerifier = Object.defineProperty({}, "verify", {
      get() {
        throw new Error(hiddenDetail);
      },
    }) as NormalizedEvidenceVerifier;
    let error: unknown;
    try {
      await resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed corrected normalized evidence accessor",
          correctedNormalizedEvidenceRef: correctedRef,
          expectedNormalizedSha256: sha256("corrected-accessor"),
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        hostileVerifier,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "QUARANTINE_RESOLUTION_INVALID", status: 422 });
    expect(String(error)).not.toContain(hiddenDetail);
  });

  it("rejects stale row/item versions and serializes concurrent resolution", async () => {
    const staleFixture = await seedRegisteredBatch();
    const staleRow = await stageOneRow(staleFixture, "stale-resolution");
    const stale = await openSyntheticQuarantine(staleFixture, staleRow);
    const normalizedRef = protectedRef("stale-normalized");
    const normalizedBytes = Buffer.from("stale-normalized");
    const normalizedSha = sha256(normalizedBytes);
    await expect(
      resolveQuarantineItem(
        staleFixture.tenant.actor,
        {
          quarantineItemId: stale.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed stale resolution attempt",
          correctedNormalizedEvidenceRef: normalizedRef,
          expectedNormalizedSha256: normalizedSha,
          expectedItemVersion: stale.itemVersion + 1,
          expectedRowVersion: stale.rowVersion,
        },
        normalizedVerifier(normalizedRef, normalizedBytes),
      ),
    ).rejects.toMatchObject({ code: "QUARANTINE_VERSION_CONFLICT", status: 409 });
    await expect(
      resolveQuarantineItem(
        staleFixture.tenant.actor,
        {
          quarantineItemId: stale.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed stale resolution attempt",
          correctedNormalizedEvidenceRef: normalizedRef,
          expectedNormalizedSha256: normalizedSha,
          expectedItemVersion: stale.itemVersion,
          expectedRowVersion: stale.rowVersion + 1,
        },
        normalizedVerifier(normalizedRef, normalizedBytes),
      ),
    ).rejects.toMatchObject({ code: "QUARANTINE_VERSION_CONFLICT", status: 409 });

    const concurrentFixture = await seedRegisteredBatch();
    const concurrentRow = await stageOneRow(concurrentFixture, "concurrent-resolution");
    const concurrent = await openSyntheticQuarantine(concurrentFixture, concurrentRow);
    const correctedRef = protectedRef("concurrent-normalized");
    const correctedBytes = Buffer.from("concurrent-normalized");
    const correctedSha = sha256(correctedBytes);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        resolveQuarantineItem(
          concurrentFixture.tenant.actor,
          {
            quarantineItemId: concurrent.quarantineItemId,
            disposition: "APPROVE_ROW" as const,
            resolutionReason: "Reviewed concurrent resolution",
            correctedNormalizedEvidenceRef: correctedRef,
            expectedNormalizedSha256: correctedSha,
            expectedItemVersion: concurrent.itemVersion,
            expectedRowVersion: concurrent.rowVersion,
          },
          normalizedVerifier(correctedRef, correctedBytes),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(7);
    const [effects] = await sql<{ valid: string; quarantined: string; audits: number; outbox: number }[]>`
      select batch.valid_row_count as valid,
             batch.quarantined_row_count as quarantined,
             (select count(*)::int from audit_events where target_id = item.id
               and action = 'MIGRATION_QUARANTINE_RESOLVED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = item.id
               and event_type = 'crm.migration.quarantine_resolved') as outbox
      from quarantine_items item
      join import_rows row_record on row_record.id = item.import_row_id
      join import_batches batch on batch.id = row_record.batch_id
      where item.id = ${concurrent.quarantineItemId}
    `;
    expect(effects).toEqual({ valid: "1", quarantined: "0", audits: 1, outbox: 1 });
  });

  it("allows two reviewers to resolve distinct rows concurrently in one batch", async () => {
    const fixture = await seedRegisteredBatch();
    const evidence = [
      syntheticRow("parallel-resolution-a", 1n),
      syntheticRow("parallel-resolution-b", 2n),
    ];
    await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows(evidence.map((entry) => entry.row)),
      rawVerifier(fixture, evidence),
    );
    const storedRows = await sql<{ id: string; source_row_key: string; version: string }[]>`
      select id, source_row_key, version from import_rows
      where batch_id = ${fixture.batchId} order by source_row_key
    `;
    const opened = [] as {
      quarantineItemId: string;
      itemVersion: number;
      rowVersion: number;
    }[];
    for (let index = 0; index < storedRows.length; index += 1) {
      const stored = storedRows[index]!;
      const created = await openQuarantineItem(fixture.tenant.actor, {
        importRowId: stored.id,
        expectedRowVersion: Number(stored.version),
        reasonCode: `PARALLEL_REASON_${index + 1}`,
        redactedMetadata: { fieldCode: "legacy_status", ruleCode: `RULE_${index + 1}` },
      });
      const [versions] = await sql<{ item_version: string; row_version: string }[]>`
        select item.version as item_version, row_record.version as row_version
        from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
        where item.id = ${created.quarantineItemId}
      `;
      opened.push({
        quarantineItemId: created.quarantineItemId,
        itemVersion: Number(versions!.item_version),
        rowVersion: Number(versions!.row_version),
      });
    }

    let releaseVerifiers!: () => void;
    const verifierRelease = new Promise<void>((resolve) => {
      releaseVerifiers = resolve;
    });
    const enteredResolvers: Array<() => void> = [];
    const verifierEntered = opened.map(
      () => new Promise<void>((resolve) => enteredResolvers.push(resolve)),
    );
    const corrections = opened.map((_, index) => {
      const ref = protectedRef(`parallel-normalized-${index + 1}`);
      const bytes = Buffer.from(`parallel-normalized-${index + 1}`);
      return { ref, sha: sha256(bytes) };
    });
    const resolutions = opened.map((item, index) =>
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: item.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: `Distinct row ${index + 1} explicitly reviewed and approved`,
          correctedNormalizedEvidenceRef: corrections[index]!.ref,
          expectedNormalizedSha256: corrections[index]!.sha,
          expectedItemVersion: item.itemVersion,
          expectedRowVersion: item.rowVersion,
        },
        {
          async verify(ref, expectedSha256) {
            enteredResolvers[index]!();
            await verifierRelease;
            expect(ref).toBe(corrections[index]!.ref);
            expect(Buffer.from(expectedSha256!)).toEqual(corrections[index]!.sha);
            return { ref, sha256: corrections[index]!.sha };
          },
        },
      ),
    );
    await Promise.all(verifierEntered);
    releaseVerifiers();
    const outcomes = await Promise.allSettled(resolutions);
    expect(outcomes).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    const [summary] = await sql<{
      valid: string;
      quarantined: string;
      resolved_items: number;
      valid_rows: number;
    }[]>`
      select valid_row_count as valid, quarantined_row_count as quarantined,
        (select count(*)::int from quarantine_items item
          join import_rows row_record on row_record.id = item.import_row_id
          where row_record.batch_id = ${fixture.batchId} and item.status = 'RESOLVED') as resolved_items,
        (select count(*)::int from import_rows
          where batch_id = ${fixture.batchId} and outcome = 'VALID') as valid_rows
      from import_batches where id = ${fixture.batchId}
    `;
    expect(summary).toEqual({
      valid: "2",
      quarantined: "0",
      resolved_items: 2,
      valid_rows: 2,
    });
  });

  it("conceals foreign items before normalized evidence access", async () => {
    const owner = await seedRegisteredBatch();
    const row = await stageOneRow(owner, "foreign-resolution");
    const opened = await openSyntheticQuarantine(owner, row);
    const foreign = await seedTenant();
    const correctedRef = protectedRef("foreign-corrected");
    const correctedSha = sha256("foreign-corrected");
    let verifierCalls = 0;
    await expect(
      resolveQuarantineItem(
        foreign.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Attempted foreign resolution",
          correctedNormalizedEvidenceRef: correctedRef,
          expectedNormalizedSha256: correctedSha,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify() {
            verifierCalls += 1;
            throw new Error("must not access foreign evidence");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "QUARANTINE_ITEM_NOT_FOUND", status: 404 });
    expect(verifierCalls).toBe(0);
  });

  it("rechecks membership after corrected evidence verification", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "resolution-revoked");
    const opened = await openSyntheticQuarantine(fixture, row);
    const correctedRef = protectedRef("resolution-revoked");
    const correctedBytes = Buffer.from("resolution-revoked");
    const correctedSha = sha256(correctedBytes);
    const trusted = normalizedVerifier(correctedRef, correctedBytes);
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed before membership revocation",
          correctedNormalizedEvidenceRef: correctedRef,
          expectedNormalizedSha256: correctedSha,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify(ref, expected) {
            const verified = await trusted.verify(ref, expected);
            await sql`
              update memberships set status = 'REVOKED'
              where organization_id = ${fixture.tenant.organizationId}
                and id = ${fixture.tenant.membershipId}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });
    const [stored] = await sql<{ status: string; outcome: string }[]>`
      select item.status, row_record.outcome
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${opened.quarantineItemId}
    `;
    expect(stored).toEqual({ status: "OPEN", outcome: "QUARANTINED" });
  });

  it("keeps the row quarantined until every distinct reason closes, then all approvals validate", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "multi-reason-approve");
    const first = await openSyntheticQuarantine(fixture, row, "IDENTITY_AMBIGUOUS");
    const secondResult = await openQuarantineItem(fixture.tenant.actor, {
      importRowId: row.rowId,
      expectedRowVersion: first.rowVersion,
      reasonCode: "FINANCE_LINEAGE_AMBIGUOUS",
      redactedMetadata: { fieldCode: "payment_lineage", ruleCode: "MULTIPLE_MATCHES" },
    });
    const [secondVersion] = await sql<{ item_version: string; row_version: string }[]>`
      select item.version as item_version, row_record.version as row_version
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${secondResult.quarantineItemId}
    `;
    const correctedRef = protectedRef("multi-reason-normalized");
    const correctedBytes = Buffer.from("multi-reason-normalized");
    const correctedSha = sha256(correctedBytes);

    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: first.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "Identity ambiguity reviewed and approved",
        correctedNormalizedEvidenceRef: correctedRef,
        expectedNormalizedSha256: correctedSha,
        expectedItemVersion: first.itemVersion,
        expectedRowVersion: Number(secondVersion!.row_version),
      },
      normalizedVerifier(correctedRef, correctedBytes),
    );
    const [intermediate] = await sql<{
      outcome: string;
      quarantined: string;
      valid: string;
      version: string;
    }[]>`
      select row_record.outcome, batch.quarantined_row_count as quarantined,
             batch.valid_row_count as valid, row_record.version
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${row.rowId}
    `;
    expect(intermediate).toMatchObject({ outcome: "QUARANTINED", quarantined: "1", valid: "0" });

    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: secondResult.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "Finance lineage ambiguity reviewed and approved",
        correctedNormalizedEvidenceRef: null,
        expectedNormalizedSha256: null,
        expectedItemVersion: Number(secondVersion!.item_version),
        expectedRowVersion: Number(intermediate!.version),
      },
      {
        async verify() {
          throw new Error("must reuse coherent persisted evidence");
        },
      },
    );
    const [final] = await sql<{ outcome: string; quarantined: string; valid: string }[]>`
      select row_record.outcome, batch.quarantined_row_count as quarantined,
             batch.valid_row_count as valid
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${row.rowId}
    `;
    expect(final).toEqual({ outcome: "VALID", quarantined: "0", valid: "1" });
  });

  it("makes any resolved rejection dominate the final multi-reason disposition", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "multi-reason-reject");
    const first = await openSyntheticQuarantine(fixture, row, "IDENTITY_REJECTED");
    const secondResult = await openQuarantineItem(fixture.tenant.actor, {
      importRowId: row.rowId,
      expectedRowVersion: first.rowVersion,
      reasonCode: "STATUS_REVIEW",
      redactedMetadata: { fieldCode: "legacy_status", ruleCode: "REVIEW_REQUIRED" },
    });
    const [versions] = await sql<{
      second_item_version: string;
      row_version: string;
    }[]>`
      select item.version as second_item_version, row_record.version as row_version
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${secondResult.quarantineItemId}
    `;
    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: first.quarantineItemId,
        disposition: "REJECT_ROW",
        resolutionReason: "Identity ambiguity explicitly rejected",
        correctedNormalizedEvidenceRef: null,
        expectedNormalizedSha256: null,
        expectedItemVersion: first.itemVersion,
        expectedRowVersion: Number(versions!.row_version),
      },
      { async verify() { throw new Error("must not verify rejection"); } },
    );
    const normalizedRef = protectedRef("multi-reject-normalized");
    const normalizedBytes = Buffer.from("multi-reject-normalized");
    const normalizedSha = sha256(normalizedBytes);
    const [currentRow] = await sql<{ version: string }[]>`
      select version from import_rows where id = ${row.rowId}
    `;
    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: secondResult.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "Status review independently approved",
        correctedNormalizedEvidenceRef: normalizedRef,
        expectedNormalizedSha256: normalizedSha,
        expectedItemVersion: Number(versions!.second_item_version),
        expectedRowVersion: Number(currentRow!.version),
      },
      normalizedVerifier(normalizedRef, normalizedBytes),
    );
    const [final] = await sql<{
      outcome: string;
      error_code: string;
      rejected: string;
      quarantined: string;
      valid: string;
    }[]>`
      select row_record.outcome, row_record.error_code,
             batch.rejected_row_count as rejected,
             batch.quarantined_row_count as quarantined,
             batch.valid_row_count as valid
      from import_rows row_record join import_batches batch on batch.id = row_record.batch_id
      where row_record.id = ${row.rowId}
    `;
    expect(final).toEqual({
      outcome: "REJECTED",
      error_code: "IDENTITY_REJECTED",
      rejected: "1",
      quarantined: "0",
      valid: "0",
    });
  });

  it("rejects conflicting corrected evidence across approved reasons", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "multi-reason-conflict");
    const first = await openSyntheticQuarantine(fixture, row, "FIRST_APPROVAL");
    const secondResult = await openQuarantineItem(fixture.tenant.actor, {
      importRowId: row.rowId,
      expectedRowVersion: first.rowVersion,
      reasonCode: "SECOND_APPROVAL",
      redactedMetadata: { fieldCode: "identity", ruleCode: "SECOND_CHECK" },
    });
    const firstRef = protectedRef("first-normalized");
    const firstBytes = Buffer.from("first-normalized");
    const firstSha = sha256(firstBytes);
    const [before] = await sql<{ row_version: string; second_version: string }[]>`
      select row_record.version as row_version, item.version as second_version
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${secondResult.quarantineItemId}
    `;
    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: first.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "First independent review approved",
        correctedNormalizedEvidenceRef: firstRef,
        expectedNormalizedSha256: firstSha,
        expectedItemVersion: first.itemVersion,
        expectedRowVersion: Number(before!.row_version),
      },
      normalizedVerifier(firstRef, firstBytes),
    );
    const secondRef = protectedRef("second-normalized");
    const secondBytes = Buffer.from("second-normalized");
    const secondSha = sha256(secondBytes);
    const [current] = await sql<{ version: string }[]>`
      select version from import_rows where id = ${row.rowId}
    `;
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: secondResult.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Second independent review approved",
          correctedNormalizedEvidenceRef: secondRef,
          expectedNormalizedSha256: secondSha,
          expectedItemVersion: Number(before!.second_version),
          expectedRowVersion: Number(current!.version),
        },
        normalizedVerifier(secondRef, secondBytes),
      ),
    ).rejects.toMatchObject({ code: "QUARANTINE_NORMALIZED_EVIDENCE_CONFLICT", status: 409 });
    const [stored] = await sql<{ status: string; outcome: string }[]>`
      select item.status, row_record.outcome
      from quarantine_items item join import_rows row_record on row_record.id = item.import_row_id
      where item.id = ${secondResult.quarantineItemId}
    `;
    expect(stored).toEqual({ status: "OPEN", outcome: "QUARANTINED" });
  });

  it("keeps item, row, batch, and authority locks closed during normalized verification", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "normalized-outside-transaction");
    const opened = await openSyntheticQuarantine(fixture, row);
    const ref = protectedRef("normalized-lock-proof");
    const bytes = Buffer.from("normalized-lock-proof");
    const digest = sha256(bytes);
    await resolveQuarantineItem(
      fixture.tenant.actor,
      {
        quarantineItemId: opened.quarantineItemId,
        disposition: "APPROVE_ROW",
        resolutionReason: "Verified outside all database locks",
        correctedNormalizedEvidenceRef: ref,
        expectedNormalizedSha256: digest,
        expectedItemVersion: opened.itemVersion,
        expectedRowVersion: opened.rowVersion,
      },
      {
        async verify(candidateRef) {
          await sql.begin(async (transaction) => {
            await transaction`select id from quarantine_items where id = ${opened.quarantineItemId} for update nowait`;
            await transaction`select id from import_rows where id = ${row.rowId} for update nowait`;
            await transaction`select id from import_batches where id = ${fixture.batchId} for update nowait`;
            await transaction`select id from migration_domain_authorities where id = ${fixture.headId} for update nowait`;
          });
          return { ref: candidateRef, sha256: digest };
        },
      },
    );
  });

  it("rechecks quarantine capability after normalized verifier I/O", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "resolution-capability-revoked");
    const opened = await openSyntheticQuarantine(fixture, row);
    const ref = protectedRef("resolution-capability-revoked");
    const bytes = Buffer.from("resolution-capability-revoked");
    const digest = sha256(bytes);
    const trusted = normalizedVerifier(ref, bytes);
    await expect(
      resolveQuarantineItem(
        fixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "APPROVE_ROW",
          resolutionReason: "Reviewed before capability revocation",
          correctedNormalizedEvidenceRef: ref,
          expectedNormalizedSha256: digest,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify(candidateRef, expected) {
            const verified = await trusted.verify(candidateRef, expected);
            await sql`
              delete from role_capabilities
              where organization_id = ${fixture.tenant.organizationId}
                and role_id = ${fixture.tenant.roleId}
                and capability_key = ${QUARANTINE_CAPABILITY}
            `;
            return verified;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
  });

  it("rolls back item, row, counters, audit, and outbox when resolution effects fail", async () => {
    const fixture = await seedRegisteredBatch();
    const row = await stageOneRow(fixture, "resolution-effect-failure");
    const opened = await openSyntheticQuarantine(fixture, row);
    await sql.unsafe(`
      create function crm_test_reject_resolution_outbox() returns trigger
      language plpgsql as $$
      begin
        if new.aggregate_id = '${opened.quarantineItemId}'::uuid
           and new.event_type = 'crm.migration.quarantine_resolved' then
          raise exception 'synthetic resolution outbox failure';
        end if;
        return new;
      end; $$;
      create trigger crm_test_reject_resolution_outbox_trigger
      before insert on outbox_events
      for each row execute function crm_test_reject_resolution_outbox();
    `);
    try {
      await expect(
        resolveQuarantineItem(
          fixture.tenant.actor,
          {
            quarantineItemId: opened.quarantineItemId,
            disposition: "REJECT_ROW",
            resolutionReason: "Reviewed rejection before synthetic effect failure",
            correctedNormalizedEvidenceRef: null,
            expectedNormalizedSha256: null,
            expectedItemVersion: opened.itemVersion,
            expectedRowVersion: opened.rowVersion,
          },
          { async verify() { throw new Error("must not verify rejection"); } },
        ),
      ).rejects.toMatchObject({ code: "QUARANTINE_RESOLUTION_FAILED", status: 500 });
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_reject_resolution_outbox_trigger on outbox_events;
        drop function if exists crm_test_reject_resolution_outbox();
      `);
    }
    const [stored] = await sql<{
      item_status: string;
      row_outcome: string;
      quarantined: string;
      rejected: string;
      audits: number;
      outbox: number;
    }[]>`
      select item.status as item_status, row_record.outcome as row_outcome,
             batch.quarantined_row_count as quarantined,
             batch.rejected_row_count as rejected,
             (select count(*)::int from audit_events where target_id = item.id
               and action = 'MIGRATION_QUARANTINE_RESOLVED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = item.id
               and event_type = 'crm.migration.quarantine_resolved') as outbox
      from quarantine_items item
      join import_rows row_record on row_record.id = item.import_row_id
      join import_batches batch on batch.id = row_record.batch_id
      where item.id = ${opened.quarantineItemId}
    `;
    expect(stored).toEqual({
      item_status: "OPEN",
      row_outcome: "QUARANTINED",
      quarantined: "1",
      rejected: "0",
      audits: 0,
      outbox: 0,
    });
  });
});

describe("terminal and immutable-envelope protection", () => {
  it.each([
    ["rowNumber", (row: StagedSourceRow) => ({ ...row, rowNumber: 2n })],
    ["sourceObjectType", (row: StagedSourceRow) => ({ ...row, sourceObjectType: "synthetic.other" })],
    ["sourceRecordId", (row: StagedSourceRow) => ({ ...row, sourceRecordId: "record-other" })],
    ["sourceLocator", (row: StagedSourceRow) => ({ ...row, sourceLocator: "records/other" })],
  ] as const)("rejects replay mutation of %s", async (_field, mutate) => {
    const fixture = await seedRegisteredBatch();
    const original = syntheticRow(`immutable-${String(_field)}`, 1n);
    await stageImportRows(
      fixture.tenant.actor,
      fixture.batchId,
      streamRows([original.row]),
      rawVerifier(fixture, [original]),
    );
    const modified: RowEvidence = { ...original, row: mutate(original.row) };
    await expect(
      stageImportRows(
        fixture.tenant.actor,
        fixture.batchId,
        streamRows([modified.row]),
        rawVerifier(fixture, [modified]),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_REPLAY_CONFLICT", status: 409 });
  });

  it("protects terminal batches from staging and quarantine resolution", async () => {
    const stageFixture = await seedRegisteredBatch();
    await sql`
      update import_batches set status = 'FAILED', failure_code = 'SYNTHETIC_TERMINAL'
      where id = ${stageFixture.batchId}
    `;
    const evidence = syntheticRow("terminal-stage", 1n);
    let verifierCalls = 0;
    await expect(
      stageImportRows(
        stageFixture.tenant.actor,
        stageFixture.batchId,
        streamRows([evidence.row]),
        {
          async verify() {
            verifierCalls += 1;
            throw new Error("must not verify terminal batch evidence");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_TERMINAL", status: 409 });
    expect(verifierCalls).toBe(0);

    const resolutionFixture = await seedRegisteredBatch();
    const row = await stageOneRow(resolutionFixture, "terminal-resolution");
    const opened = await openSyntheticQuarantine(resolutionFixture, row);
    await sql`
      update import_batches set status = 'FAILED', failure_code = 'SYNTHETIC_TERMINAL'
      where id = ${resolutionFixture.batchId}
    `;
    await expect(
      resolveQuarantineItem(
        resolutionFixture.tenant.actor,
        {
          quarantineItemId: opened.quarantineItemId,
          disposition: "REJECT_ROW",
          resolutionReason: "Attempted terminal resolution",
          correctedNormalizedEvidenceRef: null,
          expectedNormalizedSha256: null,
          expectedItemVersion: opened.itemVersion,
          expectedRowVersion: opened.rowVersion,
        },
        {
          async verify() {
            throw new Error("must not verify terminal resolution");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_TERMINAL", status: 409 });
  });
});

describe("authority serialization", () => {
  it(
    "makes a staging chunk wait for cutover, recheck, and commit no post-cutover row",
    async () => {
      const fixture = await seedRegisteredBatch();
      const final = await seedFinalReconciledBatch(fixture);
      const cutoverGroupId = randomUUID();
      const transitionId = randomUUID();
      let releaseCutover!: () => void;
      const mayReleaseCutover = new Promise<void>((resolve) => {
        releaseCutover = resolve;
      });
      let reportCutoverReady!: (pid: number) => void;
      const cutoverReady = new Promise<number>((resolve) => {
        reportCutoverReady = resolve;
      });
      const cutover = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where id = ${fixture.headId} for update
        `;
        await transaction`
          insert into source_authority_transition_groups (
            id, organization_id, idempotency_key, group_size, group_sha256,
            plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
          ) values (
            ${cutoverGroupId}, ${fixture.tenant.organizationId},
            ${`row-race-${randomUUID()}`}, 1, ${sha256(`group:${cutoverGroupId}`)},
            ${protectedRef("row-race-plan")}, ${sha256(`plan:${cutoverGroupId}`)},
            ${fixture.tenant.organizationMembershipId}, 'Synthetic staging race cutover'
          )
        `;
        await transaction`
          insert into source_authority_transitions (
            id, organization_id, business_unit_id, transition_group_id,
            domain_authority_id, from_source_scope_id, to_source_scope_id,
            from_state, to_state, write_frozen_at, final_batch_id, final_cutoff_at
          ) values (
            ${transitionId}, ${fixture.tenant.organizationId}, ${fixture.tenant.businessUnitId},
            ${cutoverGroupId}, ${fixture.headId}, ${fixture.scopeId}, null,
            'SHADOW_READ', 'CANONICAL_WRITABLE', ${final.writeFrozenAt},
            ${final.finalBatchId}, ${final.cutoffAt}
          )
        `;
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
        reportCutoverReady(backend!.pid);
        await mayReleaseCutover;
      });
      const evidence = syntheticRow("cutover-race", 1n);
      let verifierCalls = 0;
      let staging: ReturnType<typeof stageImportRows> | undefined;
      try {
        const cutoverPid = await cutoverReady;
        staging = stageImportRows(
          fixture.tenant.actor,
          fixture.batchId,
          streamRows([evidence.row]),
          rawVerifier(fixture, [evidence], () => {
            verifierCalls += 1;
          }),
        );
        await waitUntilBlockedBy(cutoverPid);
        releaseCutover();
        await cutover;
        await expect(staging).rejects.toMatchObject({
          code: "MIGRATION_SOURCE_NOT_ACTIVE",
          status: 409,
        });
      } finally {
        releaseCutover();
        await Promise.allSettled([cutover, ...(staging ? [staging] : [])]);
      }
      expect(verifierCalls).toBe(0);
      const [stored] = await sql<{
        groups: number;
        transitions: number;
        rows: number;
        status: string;
        authority_state: string;
      }[]>`
        select
          (select count(*)::int from source_authority_transition_groups
            where id = ${cutoverGroupId}) as groups,
          (select count(*)::int from source_authority_transitions
            where transition_group_id = ${cutoverGroupId}) as transitions,
          (select count(*)::int from import_rows where batch_id = ${fixture.batchId}) as rows,
          source.status, authority.authority_state
        from migration_sources source
        join migration_domain_authorities authority
          on authority.organization_id = source.organization_id
         and authority.business_unit_id = source.business_unit_id
         and authority.id = ${fixture.headId}
        where source.id = ${fixture.sourceId}
      `;
      expect(stored).toEqual({
        groups: 1,
        transitions: 1,
        rows: 0,
        status: "ARCHIVED_READ_ONLY",
        authority_state: "CANONICAL_WRITABLE",
      });
    },
    15_000,
  );
});
