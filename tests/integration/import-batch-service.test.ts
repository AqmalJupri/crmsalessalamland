import { createHash, randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabaseConnection } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRuntimeConfigForTests } from "@/server/env";
import { ApiError } from "@/server/http/errors";
import type { MigrationActor, SourceArtifactStore } from "@/server/migration/contracts";
import {
  registerImportBatch,
  type RegisterImportBatchInput,
} from "@/server/migration/register-batch";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for import batch service tests.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Import batch tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, {
  max: 24,
  prepare: false,
  onnotice: () => undefined,
});
type TestSql = Sql | TransactionSql;

const SOURCE_CAPABILITY = "migration.source.manage";

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function protectedRef(label: string): string {
  return `protected://batch-tests/${label}/${randomUUID()}`;
}

function artifactStore(
  entries: Readonly<Record<string, readonly Uint8Array[]>>,
): SourceArtifactStore {
  return {
    async *open(ref: string) {
      const entry = entries[ref];
      if (!entry) throw new Error("SYNTHETIC_OBJECT_NOT_FOUND_PRIVATE_DETAIL");
      for (const chunk of entry) yield chunk;
    },
  };
}

interface ArtifactFixture {
  ref: string;
  chunks: readonly Uint8Array[];
  sha256: Buffer;
  sizeBytes: bigint;
  capturedAt: Date;
  cutoffAt: Date;
  schemaVersion: string;
  store: SourceArtifactStore;
}

function syntheticArtifact(label = "source-artifact"): ArtifactFixture {
  const ref = protectedRef(label);
  const chunks = [Buffer.from(`synthetic:${label}:`), Buffer.from(randomUUID())];
  const bytes = Buffer.concat(chunks);
  const capturedAt = new Date(Date.now() - 10_000);
  const cutoffAt = new Date(capturedAt.getTime() - 1_000);
  return {
    ref,
    chunks,
    sha256: sha256(bytes),
    sizeBytes: BigInt(bytes.byteLength),
    capturedAt,
    cutoffAt,
    schemaVersion: "sales.v1",
    store: artifactStore({ [ref]: chunks }),
  };
}

interface TenantFixture {
  organizationId: string;
  businessUnitId: string;
  userId: string;
  membershipId: string;
  roleId: string;
  actor: MigrationActor;
}

async function seedTenant(db: TestSql = sql): Promise<TenantFixture> {
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const roleId = randomUUID();
  await db`
    insert into organizations (id, code, name)
    values (${organizationId}, ${`org-${organizationId}`}, 'Batch Test Organisation')
  `;
  await db`
    insert into business_units (id, organization_id, code, name)
    values (${businessUnitId}, ${organizationId}, ${`bu-${businessUnitId}`}, 'Batch Test Unit')
  `;
  await db`
    insert into users (id, auth_subject, display_name, user_type, status)
    values (${userId}, ${`test:${userId}`}, 'Batch Operator', 'HUMAN', 'ACTIVE')
  `;
  await db`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from, valid_until
    ) values (
      ${membershipId}, ${organizationId}, ${businessUnitId}, ${userId}, 'ACTIVE',
      clock_timestamp() - interval '1 day', null
    )
  `;
  await db`
    insert into roles (id, organization_id, key, name, status)
    values (${roleId}, ${organizationId}, ${`batch-${roleId}`}, 'Batch Operator', 'ACTIVE')
  `;
  await db`
    insert into role_capabilities (organization_id, role_id, capability_key)
    values (${organizationId}, ${roleId}, ${SOURCE_CAPABILITY})
  `;
  await db`
    insert into membership_roles (organization_id, membership_id, role_id, valid_from)
    values (${organizationId}, ${membershipId}, ${roleId}, clock_timestamp() - interval '1 day')
  `;
  return {
    organizationId,
    businessUnitId,
    userId,
    membershipId,
    roleId,
    actor: {
      userId,
      organizationId,
      activeMembershipId: membershipId,
      businessUnitId,
      capabilities: [SOURCE_CAPABILITY],
    },
  };
}

interface SourceFixture {
  tenant: TenantFixture;
  sourceId: string;
  scopeIds: readonly string[];
  headIds: readonly string[];
  transformId: string;
}

async function insertTransform(
  fixture: Pick<SourceFixture, "tenant" | "sourceId">,
  options: { versionNo: number; repairOfTransformId?: string | null } = { versionNo: 1 },
  db: TestSql = sql,
): Promise<string> {
  const id = randomUUID();
  await db`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, repair_of_transform_id, approved_by_membership_id, approved_at
    ) values (
      ${id}, ${fixture.tenant.organizationId}, ${fixture.tenant.businessUnitId},
      ${fixture.sourceId}, ${options.versionNo}, 'sales.v1', ${protectedRef("mapping")},
      ${sha256(`mapping:${id}`)}, ${protectedRef("manifest")},
      ${sha256(`manifest:${id}`)}, ${sha256(`release:${id}`)},
      'Reviewed synthetic batch transform', ${options.repairOfTransformId ?? null},
      ${fixture.tenant.membershipId}, clock_timestamp()
    )
  `;
  return id;
}

async function seedActiveSource(
  tenant: TenantFixture | undefined = undefined,
  options: { domains?: readonly string[] } = {},
): Promise<SourceFixture> {
  tenant ??= await seedTenant();
  const sourceId = randomUUID();
  const domains =
    options.domains ??
    ([
      `sales.alpha_${randomUUID().replaceAll("-", "_")}`,
      `sales.omega_${randomUUID().replaceAll("-", "_")}`,
    ] as const);
  const scopeIds = domains.map(() => randomUUID());
  const headIds = domains.map(() => randomUUID());
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
  for (let index = 0; index < domains.length; index += 1) {
    await sql`
      insert into migration_source_scopes (
        id, organization_id, business_unit_id, migration_source_id, domain_key,
        canonical_target, transition_mode, source_status
      ) values (
        ${scopeIds[index]!}, ${tenant.organizationId}, ${tenant.businessUnitId},
        ${sourceId}, ${domains[index]!}, 'crm.canonical', 'ONE_TIME_CUTOVER',
        'ACTIVE_AUTHORITY'
      )
    `;
    await sql`
      insert into migration_domain_authorities (
        id, organization_id, business_unit_id, domain_key, canonical_target,
        authority_state, authority_source_scope_id
      ) values (
        ${headIds[index]!}, ${tenant.organizationId}, ${tenant.businessUnitId},
        ${domains[index]!}, 'crm.canonical', 'SHADOW_READ', ${scopeIds[index]!}
      )
    `;
  }
  const partial = { tenant, sourceId };
  const transformId = await insertTransform(partial, { versionNo: 1 });
  return { tenant, sourceId, scopeIds, headIds, transformId };
}

function validInput(
  fixture: SourceFixture,
  artifact: ArtifactFixture,
  overrides: Partial<RegisterImportBatchInput> = {},
): RegisterImportBatchInput {
  return {
    businessUnitId: fixture.tenant.businessUnitId,
    migrationSourceId: fixture.sourceId,
    transformVersionId: fixture.transformId,
    protectedArtifactRef: artifact.ref,
    expectedSourceSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes,
    capturedAt: new Date(artifact.capturedAt.getTime()),
    cutoffAt: new Date(artifact.cutoffAt.getTime()),
    schemaVersion: artifact.schemaVersion,
    dryRun: true,
    validatedDryRunBatchId: null,
    repairOfBatchId: null,
    operatorReason: null,
    ...overrides,
  };
}

async function completeDryRun(batchId: string, tenant: TenantFixture): Promise<void> {
  await sql`
    update import_batches
    set status = 'DRY_RUN_COMPLETE', validated_by_membership_id = ${tenant.membershipId},
        validated_at = clock_timestamp()
    where organization_id = ${tenant.organizationId} and id = ${batchId}
  `;
}

async function batchEvidenceSnapshot(
  organizationId: string,
  sourceId: string,
): Promise<unknown> {
  const [snapshot] = await sql<{
    batches: unknown;
    audits: unknown;
    outbox: unknown;
  }[]>`
    select
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, transform_version_id, validated_dry_run_batch_id, repair_of_batch_id,
                protected_artifact_ref, encode(source_sha256, 'hex') as source_sha256,
                size_bytes, captured_at, cutoff_at, schema_version, status, dry_run,
                operator_reason, version, created_at, updated_at
         from import_batches
         where organization_id = ${organizationId} and migration_source_id = ${sourceId}
       ) row_data) as batches,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, action, target_id, correlation_id, change_summary, occurred_at, recorded_at
         from audit_events
         where organization_id = ${organizationId}
           and action = 'MIGRATION_IMPORT_BATCH_REGISTERED'
       ) row_data) as audits,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, event_type, aggregate_id, correlation_id, payload, status,
                version, occurred_at, created_at, updated_at
         from outbox_events
         where organization_id = ${organizationId}
           and event_type = 'crm.migration.import_batch_registered'
       ) row_data) as outbox
  `;
  return snapshot;
}

async function batchRowSnapshot(batchId: string): Promise<unknown> {
  const [snapshot] = await sql<{ batch: unknown }[]>`
    select to_jsonb(row_data) as batch
    from (
      select id, organization_id, business_unit_id, migration_source_id,
             transform_version_id, validated_dry_run_batch_id, repair_of_batch_id,
             protected_artifact_ref, encode(source_sha256, 'hex') as source_sha256,
             size_bytes, captured_at, cutoff_at, schema_version, status, dry_run,
             operator_reason, version, created_at, updated_at
      from import_batches where id = ${batchId}
    ) row_data
  `;
  return snapshot?.batch;
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

async function waitUntilAnotherBackendBlockedByAny(
  blockerPids: readonly number[],
  excludedPids: readonly number[],
): Promise<{ pid: number; blockerPids: readonly number[] }> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await sql<{ pid: number; blocker_pids: number[] }[]>`
      select activity.pid, pg_blocking_pids(activity.pid) as blocker_pids
      from pg_stat_activity activity
      where activity.datname = ${expectedDatabaseName}
        and activity.pid <> pg_backend_pid()
    `;
    const row = rows.find(
      (candidate) =>
        !excludedPids.includes(candidate.pid) &&
        candidate.blocker_pids.some((pid) => blockerPids.includes(pid)),
    );
    if (row) return { pid: row.pid, blockerPids: row.blocker_pids };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected another backend to block behind one of PIDs ${blockerPids.join(", ")}.`,
  );
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
    AUTH_HASH_KEY: "batch-tests-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "batch-integration",
    OIDC_CLIENT_SECRET: "batch-integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql`
    insert into capabilities (key, description, risk_level)
    values (${SOURCE_CAPABILITY}, 'Manage reviewed migration sources', 'SENSITIVE')
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("checksum-idempotent import batch registration", () => {
  it("registers the first dry run with one atomic audit and outbox effect", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("first-dry-run");

    const result = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact),
      artifact.store,
    );

    expect(result).toEqual({ batchId: expect.any(String), replayed: false });
    const [batch] = await sql<{
      status: string;
      dry_run: boolean;
      source_sha256: Buffer;
      size_bytes: string;
      protected_artifact_ref: string;
    }[]>`
      select status, dry_run, source_sha256, size_bytes, protected_artifact_ref
      from import_batches
      where organization_id = ${fixture.tenant.organizationId} and id = ${result.batchId}
    `;
    expect(batch).toMatchObject({
      status: "REGISTERED",
      dry_run: true,
      size_bytes: artifact.sizeBytes.toString(),
      protected_artifact_ref: artifact.ref,
    });
    expect(Buffer.from(batch!.source_sha256)).toEqual(artifact.sha256);
    const [effects] = await sql<{ batches: number; audits: number; outbox: number }[]>`
      select
        (select count(*)::int from import_batches where id = ${result.batchId}) as batches,
        (select count(*)::int from audit_events
          where target_id = ${result.batchId}
            and action = 'MIGRATION_IMPORT_BATCH_REGISTERED') as audits,
        (select count(*)::int from outbox_events
          where aggregate_id = ${result.batchId}
            and event_type = 'crm.migration.import_batch_registered') as outbox
    `;
    expect(effects).toEqual({ batches: 1, audits: 1, outbox: 1 });
  });

  it("collapses at least twenty concurrent same-mode registrations to one immutable batch", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("concurrent-dry-run");
    const input = validInput(fixture, artifact);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        registerImportBatch(fixture.tenant.actor, input, artifact.store),
      ),
    );

    expect(new Set(results.map((result) => result.batchId))).toHaveLength(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    const [counts] = await sql<{ batches: number; audits: number; outbox: number }[]>`
      select
        (select count(*)::int from import_batches
          where organization_id = ${fixture.tenant.organizationId}
            and migration_source_id = ${fixture.sourceId}) as batches,
        (select count(*)::int from audit_events
          where organization_id = ${fixture.tenant.organizationId}
            and action = 'MIGRATION_IMPORT_BATCH_REGISTERED') as audits,
        (select count(*)::int from outbox_events
          where organization_id = ${fixture.tenant.organizationId}
            and event_type = 'crm.migration.import_batch_registered') as outbox
    `;
    expect(counts).toEqual({ batches: 1, audits: 1, outbox: 1 });
  });

  it(
    "serializes concurrent first registrations across divergent transforms before lineage read",
    async () => {
      const fixture = await seedActiveSource();
      const artifact = syntheticArtifact("divergent-transform-race");
      const divergentTransformId = await insertTransform(fixture, { versionNo: 2 });
      const advisoryKey = 918_005;
      const digestHex = artifact.sha256.toString("hex");
      await sql.unsafe(`
        create function crm_test_pause_divergent_batch_insert() returns trigger
        language plpgsql as $$
        begin
          if new.migration_source_id = '${fixture.sourceId}'::uuid
             and new.source_sha256 = decode('${digestHex}', 'hex')
             and new.dry_run then
            perform pg_advisory_xact_lock(${advisoryKey});
          end if;
          return new;
        end; $$;
        create trigger crm_test_pause_divergent_batch_insert_trigger
        before insert on import_batches
        for each row execute function crm_test_pause_divergent_batch_insert();
      `);
      let releaseBarrier!: () => void;
      const mayReleaseBarrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let reportBarrier!: (pid: number) => void;
      const barrierHeld = new Promise<number>((resolve) => {
        reportBarrier = resolve;
      });
      const blocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`select pg_advisory_xact_lock(${advisoryKey})`;
        reportBarrier(backend!.pid);
        await mayReleaseBarrier;
      });
      let first: Promise<{ batchId: string; replayed: boolean }> | undefined;
      let second: Promise<{ batchId: string; replayed: boolean }> | undefined;
      let outcomes: PromiseSettledResult<{ batchId: string; replayed: boolean }>[] = [];
      try {
        const blockerPid = await barrierHeld;
        first = registerImportBatch(
          fixture.tenant.actor,
          validInput(fixture, artifact),
          artifact.store,
        );
        const firstPid = await waitUntilBlockedBy(blockerPid);
        second = registerImportBatch(
          fixture.tenant.actor,
          validInput(fixture, artifact, {
            transformVersionId: divergentTransformId,
          }),
          artifact.store,
        );
        const secondWait = await waitUntilAnotherBackendBlockedByAny(
          [blockerPid, firstPid],
          [blockerPid, firstPid],
        );
        expect(secondWait.blockerPids).toContain(firstPid);
        releaseBarrier();
        await blocker;
        outcomes = await Promise.allSettled([first, second]);
      } finally {
        releaseBarrier();
        const pending: Promise<unknown>[] = [blocker];
        if (first) pending.push(first);
        if (second) pending.push(second);
        await Promise.allSettled(pending);
        await sql.unsafe(`
          drop trigger if exists crm_test_pause_divergent_batch_insert_trigger
            on import_batches;
          drop function if exists crm_test_pause_divergent_batch_insert();
        `);
      }
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          code: "IMPORT_BATCH_REPAIR_REQUIRED",
          status: 409,
        }),
      });
      const [counts] = await sql<{ batches: number; audits: number; outbox: number }[]>`
        select
          (select count(*)::int from import_batches
            where organization_id = ${fixture.tenant.organizationId}
              and migration_source_id = ${fixture.sourceId}
              and source_sha256 = ${artifact.sha256}) as batches,
          (select count(*)::int from audit_events
            where organization_id = ${fixture.tenant.organizationId}
              and action = 'MIGRATION_IMPORT_BATCH_REGISTERED') as audits,
          (select count(*)::int from outbox_events
            where organization_id = ${fixture.tenant.organizationId}
              and event_type = 'crm.migration.import_batch_registered') as outbox
      `;
      expect(counts).toEqual({ batches: 1, audits: 1, outbox: 1 });
    },
    15_000,
  );

  it("promotes only an exact completed dry run and replays the distinct live batch", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("dry-to-live");
    const dry = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact),
      artifact.store,
    );
    await completeDryRun(dry.batchId, fixture.tenant);
    const liveInput = validInput(fixture, artifact, {
      dryRun: false,
      validatedDryRunBatchId: dry.batchId,
    });

    const firstLive = await registerImportBatch(fixture.tenant.actor, liveInput, artifact.store);
    const replay = await registerImportBatch(fixture.tenant.actor, liveInput, artifact.store);

    expect(firstLive).toEqual({ batchId: expect.any(String), replayed: false });
    expect(firstLive.batchId).not.toBe(dry.batchId);
    expect(replay).toEqual({ batchId: firstLive.batchId, replayed: true });
    const [stored] = await sql<{
      dry_run: boolean;
      validated_dry_run_batch_id: string;
      status: string;
    }[]>`
      select dry_run, validated_dry_run_batch_id, status from import_batches
      where organization_id = ${fixture.tenant.organizationId} and id = ${firstLive.batchId}
    `;
    expect(stored).toEqual({
      dry_run: false,
      validated_dry_run_batch_id: dry.batchId,
      status: "REGISTERED",
    });
  });

  it("rejects missing, incomplete, foreign, and envelope-mismatched dry-run lineage", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("dry-lineage");
    const dry = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact),
      artifact.store,
    );
    const live = validInput(fixture, artifact, {
      dryRun: false,
      validatedDryRunBatchId: dry.batchId,
    });

    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...live, validatedDryRunBatchId: null },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_DRY_RUN_REQUIRED", status: 422 });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...live, validatedDryRunBatchId: randomUUID() },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_DRY_RUN_NOT_FOUND", status: 404 });
    await expect(
      registerImportBatch(fixture.tenant.actor, live, artifact.store),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_DRY_RUN_INVALID", status: 409 });

    await completeDryRun(dry.batchId, fixture.tenant);
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...live, cutoffAt: new Date(live.cutoffAt.getTime() - 1) },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_DRY_RUN_MISMATCH", status: 409 });

    const other = await seedActiveSource(fixture.tenant);
    const otherDry = await registerImportBatch(
      other.tenant.actor,
      validInput(other, artifact),
      artifact.store,
    );
    await completeDryRun(otherDry.batchId, other.tenant);
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...live, validatedDryRunBatchId: otherDry.batchId },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_DRY_RUN_NOT_FOUND", status: 404 });

    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...validInput(fixture, artifact), validatedDryRunBatchId: dry.batchId },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_DRY_RUN_FORBIDDEN", status: 422 });
  });

  it("rejects streamed checksum, exact size, and capture/cutoff contract mismatches", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("artifact-contract");
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, { expectedSourceSha256: sha256("wrong") }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH", status: 422 });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, { expectedSizeBytes: artifact.sizeBytes + 1n }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_SIZE_MISMATCH", status: 422 });

    let opened = false;
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, {
          cutoffAt: new Date(artifact.capturedAt.getTime() + 1),
        }),
        {
          async *open() {
            opened = true;
            yield artifact.chunks[0]!;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_TIME_INVALID", status: 422 });
    expect(opened).toBe(false);
  });

  it("rejects a same-key replay whose immutable acquisition envelope differs", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("replay-envelope");
    const input = validInput(fixture, artifact);
    await registerImportBatch(fixture.tenant.actor, input, artifact.store);

    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...input, capturedAt: new Date(input.capturedAt.getTime() + 1) },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_IDEMPOTENCY_CONFLICT", status: 409 });
    const alternateRef = protectedRef("other-location");
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...input, protectedArtifactRef: alternateRef },
        artifactStore({ [alternateRef]: artifact.chunks }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("requires exact transform and batch repair lineage plus a bounded operator reason", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("transform-repair");
    const original = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact),
      artifact.store,
    );
    const originalBefore = await batchRowSnapshot(original.batchId);
    const unrelatedTransform = await insertTransform(fixture, { versionNo: 2 });

    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, { transformVersionId: unrelatedTransform }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_REPAIR_REQUIRED", status: 409 });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, {
          transformVersionId: unrelatedTransform,
          repairOfBatchId: original.batchId,
          operatorReason: "Attempted unrelated transform",
        }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_REPAIR_LINEAGE_INVALID", status: 409 });

    const repairTransform = await insertTransform(fixture, {
      versionNo: 3,
      repairOfTransformId: fixture.transformId,
    });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, { transformVersionId: repairTransform }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_REPAIR_REQUIRED", status: 409 });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, {
          transformVersionId: repairTransform,
          repairOfBatchId: original.batchId,
          operatorReason: "   ",
        }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_INPUT_INVALID", status: 422 });

    const repaired = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact, {
        transformVersionId: repairTransform,
        repairOfBatchId: original.batchId,
        operatorReason: "Reviewed correction for the prior transform",
      }),
      artifact.store,
    );
    expect(repaired.replayed).toBe(false);
    const [stored] = await sql<{
      repair_of_batch_id: string;
      transform_version_id: string;
      operator_reason: string;
    }[]>`
      select repair_of_batch_id, transform_version_id, operator_reason
      from import_batches where id = ${repaired.batchId}
    `;
    expect(stored).toEqual({
      repair_of_batch_id: original.batchId,
      transform_version_id: repairTransform,
      operator_reason: "Reviewed correction for the prior transform",
    });
    expect(await batchRowSnapshot(original.batchId)).toEqual(originalBefore);
  });

  it("rejects repair targets from another source, checksum, execution mode, or tenant", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("invalid-repair-target");
    const prior = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact),
      artifact.store,
    );
    const repairTransform = await insertTransform(fixture, {
      versionNo: 2,
      repairOfTransformId: fixture.transformId,
    });
    const otherSource = await seedActiveSource(fixture.tenant);
    const otherPrior = await registerImportBatch(
      otherSource.tenant.actor,
      validInput(otherSource, artifact),
      artifact.store,
    );
    const otherTenantSource = await seedActiveSource();
    const otherTenantPrior = await registerImportBatch(
      otherTenantSource.tenant.actor,
      validInput(otherTenantSource, artifact),
      artifact.store,
    );
    const repairBase = validInput(fixture, artifact, {
      transformVersionId: repairTransform,
      operatorReason: "Reviewed correction",
    });

    for (const repairOfBatchId of [otherPrior.batchId, otherTenantPrior.batchId]) {
      await expect(
        registerImportBatch(
          fixture.tenant.actor,
          { ...repairBase, repairOfBatchId },
          artifact.store,
        ),
      ).rejects.toMatchObject({ code: "IMPORT_BATCH_REPAIR_TARGET_NOT_FOUND", status: 404 });
    }

    await completeDryRun(prior.batchId, fixture.tenant);
    const live = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, artifact, {
        dryRun: false,
        validatedDryRunBatchId: prior.batchId,
      }),
      artifact.store,
    );
    const beforeWrongMode = await batchEvidenceSnapshot(
      fixture.tenant.organizationId,
      fixture.sourceId,
    );
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...repairBase, repairOfBatchId: live.batchId },
        artifact.store,
      ),
    ).rejects.toMatchObject({
      code: "IMPORT_BATCH_REPAIR_TARGET_NOT_FOUND",
      status: 404,
    });
    expect(
      await batchEvidenceSnapshot(fixture.tenant.organizationId, fixture.sourceId),
    ).toEqual(beforeWrongMode);

    const otherArtifact = syntheticArtifact("wrong-repair-checksum");
    const wrongChecksumPrior = await registerImportBatch(
      fixture.tenant.actor,
      validInput(fixture, otherArtifact),
      otherArtifact.store,
    );
    const beforeWrongChecksum = await batchEvidenceSnapshot(
      fixture.tenant.organizationId,
      fixture.sourceId,
    );
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...repairBase, repairOfBatchId: wrongChecksumPrior.batchId },
        artifact.store,
      ),
    ).rejects.toMatchObject({
      // Ineligible mode/checksum targets are intentionally scoped out rather than disclosed.
      code: "IMPORT_BATCH_REPAIR_TARGET_NOT_FOUND",
      status: 404,
    });
    expect(
      await batchEvidenceSnapshot(fixture.tenant.organizationId, fixture.sourceId),
    ).toEqual(beforeWrongChecksum);
  });

  it("fails closed for cross-tenant IDs, wrong active BU, and revoked database grants", async () => {
    const fixture = await seedActiveSource();
    const attacker = await seedTenant();
    const artifact = syntheticArtifact("tenant-boundary");
    await expect(
      registerImportBatch(
        attacker.actor,
        {
          ...validInput(fixture, artifact),
          businessUnitId: attacker.businessUnitId,
        },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_NOT_FOUND", status: 404 });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        { ...validInput(fixture, artifact), businessUnitId: randomUUID() },
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SCOPE_FORBIDDEN", status: 403 });

    await sql`
      delete from role_capabilities
      where organization_id = ${fixture.tenant.organizationId}
        and role_id = ${fixture.tenant.roleId}
        and capability_key = ${SOURCE_CAPABILITY}
    `;
    await expect(
      registerImportBatch(fixture.tenant.actor, validInput(fixture, artifact), artifact.store),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
  });

  it("rejects a source schema that is not bound by the approved transform", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("transform-schema");
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact, { schemaVersion: "sales.v2" }),
        artifact.store,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_TRANSFORM_MISMATCH", status: 409 });
  });

  it("rejects sources that no longer own active noncanonical authority heads", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("inactive-authority");
    await sql`
      update migration_sources set status = 'REGISTERED'
      where organization_id = ${fixture.tenant.organizationId} and id = ${fixture.sourceId}
    `;
    await expect(
      registerImportBatch(fixture.tenant.actor, validInput(fixture, artifact), artifact.store),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_NOT_ACTIVE", status: 409 });
  });

  it(
    "takes sorted FOR SHARE head locks before touching later heads",
    async () => {
      const orderedDomains = await sql<{ domain_key: string }[]>`
        select domain_key
        from (values ('sales.a_'), ('sales.a0')) candidate(domain_key)
        order by domain_key
      `;
      const fixture = await seedActiveSource(await seedTenant(), {
        domains: [...orderedDomains].reverse().map((row) => row.domain_key),
      });
      const artifact = syntheticArtifact("sorted-head-locks");
      const ordered = await sql<{ id: string; domain_key: string }[]>`
        select id, domain_key from migration_domain_authorities
        where organization_id = ${fixture.tenant.organizationId}
          and business_unit_id = ${fixture.tenant.businessUnitId}
          and id = any(${fixture.headIds})
        order by business_unit_id, domain_key, id
      `;
      expect(fixture.headIds).toEqual([...ordered].reverse().map((row) => row.id));
      expect(ordered.map((row) => row.domain_key)).toEqual(
        orderedDomains.map((row) => row.domain_key),
      );
      let release!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reportLock!: (pid: number) => void;
      const lockHeld = new Promise<number>((resolve) => {
        reportLock = resolve;
      });
      const blocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where id = ${ordered[0]!.id} for update
        `;
        reportLock(backend!.pid);
        await mayRelease;
      });
      let registration: Promise<{ batchId: string; replayed: boolean }> | undefined;
      try {
        const blockerPid = await lockHeld;
        registration = registerImportBatch(
          fixture.tenant.actor,
          validInput(fixture, artifact),
          artifact.store,
        );
        await waitUntilBlockedBy(blockerPid);
        await sql.begin(async (transaction) => {
          await transaction`
            select id from migration_domain_authorities
            where id = ${ordered[1]!.id} for update nowait
          `;
        });
        release();
        await blocker;
        await expect(registration).resolves.toMatchObject({ replayed: false });
      } finally {
        release();
        const pending: Promise<unknown>[] = [blocker];
        if (registration) pending.push(registration);
        await Promise.allSettled(pending);
      }
    },
    15_000,
  );

  it(
    "waits behind canonical cutover and rejects after rechecking the archived source",
    async () => {
      const fixture = await seedActiveSource();
      const artifact = syntheticArtifact("cutover-race");
      let releaseCutover!: () => void;
      const mayCutover = new Promise<void>((resolve) => {
        releaseCutover = resolve;
      });
      let reportLock!: (pid: number) => void;
      const headsLocked = new Promise<number>((resolve) => {
        reportLock = resolve;
      });
      const cutover = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where organization_id = ${fixture.tenant.organizationId}
            and business_unit_id = ${fixture.tenant.businessUnitId}
            and id = any(${fixture.headIds})
          order by business_unit_id, domain_key, id
          for update
        `;
        reportLock(backend!.pid);
        await mayCutover;
        await transaction`
          update migration_domain_authorities
          set authority_state = 'CANONICAL_WRITABLE', authority_source_scope_id = null
          where organization_id = ${fixture.tenant.organizationId}
            and id = any(${fixture.headIds})
        `;
        await transaction`
          update migration_source_scopes set source_status = 'ARCHIVED_READ_ONLY'
          where organization_id = ${fixture.tenant.organizationId}
            and migration_source_id = ${fixture.sourceId}
        `;
        await transaction`
          update migration_sources set status = 'ARCHIVED_READ_ONLY'
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${fixture.sourceId}
        `;
      });
      let registration: Promise<{ batchId: string; replayed: boolean }> | undefined;
      try {
        const blockerPid = await headsLocked;
        registration = registerImportBatch(
          fixture.tenant.actor,
          validInput(fixture, artifact),
          artifact.store,
        );
        await waitUntilBlockedBy(blockerPid);
        releaseCutover();
        await cutover;
        await expect(registration).rejects.toMatchObject({
          code: "MIGRATION_SOURCE_NOT_ACTIVE",
          status: 409,
        });
      } finally {
        releaseCutover();
        const pending: Promise<unknown>[] = [cutover];
        if (registration) pending.push(registration);
        await Promise.allSettled(pending);
      }
      const [count] = await sql<{ count: number }[]>`
        select count(*)::int as count from import_batches
        where organization_id = ${fixture.tenant.organizationId}
          and migration_source_id = ${fixture.sourceId}
      `;
      expect(count?.count).toBe(0);
    },
    15_000,
  );

  it("rolls back batch, audit, and outbox atomically while sanitizing raw database errors", async () => {
    for (const scenario of [
      {
        label: "batch",
        table: "import_batches",
        condition: "true",
      },
      {
        label: "audit",
        table: "audit_events",
        condition: "new.action = 'MIGRATION_IMPORT_BATCH_REGISTERED'",
      },
      {
        label: "outbox",
        table: "outbox_events",
        condition: "new.event_type = 'crm.migration.import_batch_registered'",
      },
    ] as const) {
      const fixture = await seedActiveSource();
      const artifact = syntheticArtifact(`raw-${scenario.label}`);
      await sql.unsafe(`
        create function crm_test_fail_batch_${scenario.label}() returns trigger
        language plpgsql as $$
        begin
          if ${scenario.condition} then
            raise exception 'synthetic ${scenario.label} database secret';
          end if;
          return new;
        end; $$;
        create trigger crm_test_fail_batch_${scenario.label}_trigger
        before insert on ${scenario.table}
        for each row execute function crm_test_fail_batch_${scenario.label}();
      `);
      let failure: unknown;
      try {
        try {
          await registerImportBatch(
            fixture.tenant.actor,
            validInput(fixture, artifact),
            artifact.store,
          );
        } catch (error: unknown) {
          failure = error;
        }
      } finally {
        await sql.unsafe(`
          drop trigger if exists crm_test_fail_batch_${scenario.label}_trigger
            on ${scenario.table};
          drop function if exists crm_test_fail_batch_${scenario.label}();
        `);
      }
      expect(failure, scenario.label).toMatchObject({
        code: "IMPORT_BATCH_REGISTRATION_FAILED",
        status: 500,
      });
      const exposed = `${String(failure)} ${JSON.stringify(failure)}`;
      expect(exposed).not.toContain(`synthetic ${scenario.label} database secret`);
      expect(exposed).not.toContain(`crm_test_fail_batch_${scenario.label}`);
      const [counts] = await sql<{ batches: number; audits: number; outbox: number }[]>`
        select
          (select count(*)::int from import_batches
            where organization_id = ${fixture.tenant.organizationId}
              and migration_source_id = ${fixture.sourceId}) as batches,
          (select count(*)::int from audit_events
            where organization_id = ${fixture.tenant.organizationId}
              and action = 'MIGRATION_IMPORT_BATCH_REGISTERED') as audits,
          (select count(*)::int from outbox_events
            where organization_id = ${fixture.tenant.organizationId}
              and event_type = 'crm.migration.import_batch_registered') as outbox
      `;
      expect(counts, scenario.label).toEqual({ batches: 0, audits: 0, outbox: 0 });
    }
  });

  it("sanitizes provider and runtime artifact failures without opening a transaction", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("provider-errors");
    const providerSecret = "SYNTHETIC_PRIVATE_PROVIDER_TOKEN";
    let failure: unknown;
    try {
      await registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact),
        {
          open() {
            throw new ApiError(418, "PROVIDER_PRIVATE_ERROR", providerSecret);
          },
        },
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "ARTIFACT_READ_FAILED", status: 422 });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(providerSecret);
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(
      "PROVIDER_PRIVATE_ERROR",
    );

    async function* malformedRuntimeStream() {
      yield "not bytes" as unknown as Uint8Array;
    }
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact),
        { open: () => malformedRuntimeStream() },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_CHUNK_INVALID", status: 422 });
    await expect(
      registerImportBatch(
        fixture.tenant.actor,
        validInput(fixture, artifact),
        null as never,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_READ_FAILED", status: 422 });
  });

  it("returns exact replay without mutating batch or evidence timestamps and versions", async () => {
    const fixture = await seedActiveSource();
    const artifact = syntheticArtifact("replay-no-mutation");
    const input = validInput(fixture, artifact);
    const first = await registerImportBatch(fixture.tenant.actor, input, artifact.store);
    await completeDryRun(first.batchId, fixture.tenant);
    const before = await batchEvidenceSnapshot(fixture.tenant.organizationId, fixture.sourceId);

    const replay = await registerImportBatch(fixture.tenant.actor, input, artifact.store);
    const after = await batchEvidenceSnapshot(fixture.tenant.organizationId, fixture.sourceId);

    expect(replay).toEqual({ batchId: first.batchId, replayed: true });
    expect(after).toEqual(before);
  });
});
