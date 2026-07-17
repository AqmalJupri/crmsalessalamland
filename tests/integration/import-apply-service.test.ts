import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabaseConnection } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { businessUnits } from "@/server/db/schema";
import { resetRuntimeConfigForTests } from "@/server/env";
import type { MigrationActor } from "@/server/migration/contracts";
import {
  applyImportBatch,
  type ApprovedEvidenceLoader,
  type ApprovedEvidenceValidator,
  type ApprovedImportRow,
  type CanonicalImportWriter,
} from "@/server/migration/apply-batch";
import type { MigrationDatabaseTransaction } from "@/server/migration/stage-batch";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for import apply tests.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Import apply tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, {
  max: 24,
  prepare: false,
  onnotice: () => undefined,
});
const APPLY_CAPABILITY = "migration.apply";

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function evidenceBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function protectedRef(label: string): string {
  return `protected://apply-tests/${label}/${randomUUID()}`;
}

interface EvidenceValue {
  name: string;
  nested: {
    sequence: number;
  };
}

interface EvidenceEntry {
  readonly value: EvidenceValue;
  readonly protectedBytes: Buffer;
  readonly digest: Buffer;
}

interface ApplyFixture {
  organizationId: string;
  businessUnitId: string;
  originalBusinessUnitName: string;
  validatorMembershipId: string;
  approverUserId: string;
  approverMembershipId: string;
  approverApplyMembershipId: string;
  approverAsApplierActor: MigrationActor;
  applierUserId: string;
  applierMembershipId: string;
  applierAlternateMembershipId: string;
  applierActor: MigrationActor;
  applierAlternateActor: MigrationActor;
  takeoverUserId: string;
  takeoverMembershipId: string;
  takeoverActor: MigrationActor;
  applyRoleId: string;
  sourceId: string;
  scopeId: string;
  headId: string;
  transformId: string;
  dryRunBatchId: string;
  batchId: string;
  approvedBatchVersion: number;
  rowIds: string[];
  sourceRowKeys: string[];
  evidenceByRowId: Map<string, EvidenceEntry>;
  destinationBySourceKey: Map<string, string>;
  repairOfBatchId: string | null;
  operatorReason: string | null;
}

type SeedOutcome = "VALID" | "REJECTED";

async function seedApplyFixture(
  options: {
    outcomes?: readonly SeedOutcome[];
    status?: "VALIDATED" | "APPROVED";
  } = {},
): Promise<ApplyFixture> {
  const outcomes = options.outcomes ?? (["VALID", "VALID"] as const);
  const status = options.status ?? "APPROVED";
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const originalBusinessUnitName = "Apply Test Unit";
  const validatorUserId = randomUUID();
  const validatorMembershipId = randomUUID();
  const approverUserId = randomUUID();
  const approverMembershipId = randomUUID();
  const approverApplyMembershipId = randomUUID();
  const applierUserId = randomUUID();
  const applierMembershipId = randomUUID();
  const applierAlternateMembershipId = randomUUID();
  const takeoverUserId = randomUUID();
  const takeoverMembershipId = randomUUID();
  const applyRoleId = randomUUID();
  const sourceId = randomUUID();
  const scopeId = randomUUID();
  const headId = randomUUID();
  const transformId = randomUUID();
  const dryRunBatchId = randomUUID();
  const batchId = randomUUID();
  const domainKey = `sales.apply_${randomUUID().replaceAll("-", "_")}`;
  const sourceSha = sha256(`apply-batch:${batchId}`);

  await sql`
    insert into organizations (id, code, name)
    values (${organizationId}, ${`org-${organizationId}`}, 'Apply Test Organisation')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values (
      ${businessUnitId}, ${organizationId}, ${`bu-${businessUnitId}`},
      ${originalBusinessUnitName}
    )
  `;
  await sql`
    insert into users (id, auth_subject, display_name, user_type, status)
    values
      (${validatorUserId}, ${`apply-validator:${validatorUserId}`},
       'Apply Validator', 'HUMAN', 'ACTIVE'),
      (${approverUserId}, ${`apply-approver:${approverUserId}`},
       'Apply Approver', 'HUMAN', 'ACTIVE'),
      (${applierUserId}, ${`apply-worker:${applierUserId}`},
       'Apply Worker', 'HUMAN', 'ACTIVE'),
      (${takeoverUserId}, ${`apply-takeover:${takeoverUserId}`},
       'Apply Takeover Worker', 'HUMAN', 'ACTIVE')
  `;
  await sql`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from
    ) values
      (${validatorMembershipId}, ${organizationId}, ${businessUnitId}, ${validatorUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${approverMembershipId}, ${organizationId}, ${businessUnitId}, ${approverUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${approverApplyMembershipId}, ${organizationId}, null, ${approverUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${applierMembershipId}, ${organizationId}, ${businessUnitId}, ${applierUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${applierAlternateMembershipId}, ${organizationId}, null, ${applierUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${takeoverMembershipId}, ${organizationId}, ${businessUnitId}, ${takeoverUserId},
       'ACTIVE', clock_timestamp() - interval '1 day')
  `;
  await sql`
    insert into roles (id, organization_id, key, name, status)
    values (
      ${applyRoleId}, ${organizationId}, ${`apply-${applyRoleId}`},
      'Canonical Migration Applier', 'ACTIVE'
    )
  `;
  await sql`
    insert into role_capabilities (organization_id, role_id, capability_key)
    values (${organizationId}, ${applyRoleId}, ${APPLY_CAPABILITY})
  `;
  await sql`
    insert into membership_roles (organization_id, membership_id, role_id, valid_from)
    values
      (${organizationId}, ${approverApplyMembershipId}, ${applyRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${applierMembershipId}, ${applyRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${applierAlternateMembershipId}, ${applyRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${takeoverMembershipId}, ${applyRoleId},
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
      ${sha256(`release:${transformId}`)}, 'Reviewed apply transform',
      ${validatorMembershipId}, clock_timestamp() - interval '10 minutes'
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, validated_by_membership_id, validated_at
    ) values (
      ${dryRunBatchId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${protectedRef("dry-run")}, ${sourceSha}, 1,
      clock_timestamp() - interval '8 minutes', clock_timestamp() - interval '9 minutes',
      'sales.v1', 'DRY_RUN_COMPLETE', true, ${validatorMembershipId},
      clock_timestamp() - interval '7 minutes'
    )
  `;

  const validCount = outcomes.filter((outcome) => outcome === "VALID").length;
  const rejectedCount = outcomes.filter((outcome) => outcome === "REJECTED").length;
  const approved = status === "APPROVED";
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
      captured_at, cutoff_at, schema_version, status, dry_run, total_row_count,
      valid_row_count, rejected_row_count, approved_row_count,
      validated_by_membership_id, validated_at, approved_by_membership_id, approved_at,
      approval_mode, approval_reason
    ) values (
      ${batchId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${dryRunBatchId}, ${protectedRef("live-batch")}, ${sourceSha}, 1,
      clock_timestamp() - interval '6 minutes', clock_timestamp() - interval '9 minutes',
      'sales.v1', ${status}, false, ${outcomes.length}, ${validCount}, ${rejectedCount},
      ${approved ? validCount : 0}, ${validatorMembershipId},
      clock_timestamp() - interval '5 minutes',
      ${approved ? approverMembershipId : null},
      ${approved ? new Date(Date.now() - 4 * 60_000) : null},
      ${approved ? (rejectedCount > 0 ? "PARTIAL" : "FULL") : null},
      ${approved ? "Reviewed rows approved for canonical apply" : null}
    )
  `;

  const rowIds: string[] = [];
  const sourceRowKeys: string[] = [];
  const evidenceByRowId = new Map<string, EvidenceEntry>();
  const destinationBySourceKey = new Map<string, string>();
  for (const [index, outcome] of outcomes.entries()) {
    const rowId = randomUUID();
    const sourceRowKey = `apply-row-${index}-${randomUUID()}`;
    const value: EvidenceValue = {
      name: `Canonical row ${index}`,
      nested: { sequence: index + 1 },
    };
    const protectedBytes = evidenceBytes(value);
    const digest = sha256(protectedBytes);
    const normalizedRef = outcome === "VALID" ? protectedRef(`normalized-${index}`) : null;
    const errorCode = outcome === "REJECTED" ? "REVIEWED_SOURCE_REJECTION" : null;
    await sql`
      insert into import_rows (
        id, organization_id, business_unit_id, batch_id, source_row_key, row_number,
        source_object_type, source_record_id, source_locator, row_sha256, raw_evidence_ref,
        normalized_evidence_ref, normalized_sha256, outcome, error_code, error_metadata
      ) values (
        ${rowId}, ${organizationId}, ${businessUnitId}, ${batchId}, ${sourceRowKey},
        ${index + 1}, 'synthetic.record', ${`record-${index + 1}`},
        ${`records/${index + 1}`}, ${sha256(`raw:${rowId}`)}, ${protectedRef("raw")},
        ${normalizedRef}, ${outcome === "VALID" ? digest : null}, ${outcome},
        ${errorCode}, ${sql.json(errorCode === null ? {} : { ruleCode: errorCode })}
      )
    `;
    rowIds.push(rowId);
    sourceRowKeys.push(sourceRowKey);
    if (outcome === "VALID") {
      evidenceByRowId.set(rowId, { value, protectedBytes, digest });
    }
    destinationBySourceKey.set(sourceRowKey, randomUUID());
  }

  return {
    organizationId,
    businessUnitId,
    originalBusinessUnitName,
    validatorMembershipId,
    approverUserId,
    approverMembershipId,
    approverApplyMembershipId,
    approverAsApplierActor: {
      userId: approverUserId,
      organizationId,
      activeMembershipId: approverApplyMembershipId,
      businessUnitId,
      capabilities: [APPLY_CAPABILITY],
    },
    applierUserId,
    applierMembershipId,
    applierAlternateMembershipId,
    applierActor: {
      userId: applierUserId,
      organizationId,
      activeMembershipId: applierMembershipId,
      businessUnitId,
      capabilities: [APPLY_CAPABILITY],
    },
    applierAlternateActor: {
      userId: applierUserId,
      organizationId,
      activeMembershipId: applierAlternateMembershipId,
      businessUnitId,
      capabilities: [APPLY_CAPABILITY],
    },
    takeoverUserId,
    takeoverMembershipId,
    takeoverActor: {
      userId: takeoverUserId,
      organizationId,
      activeMembershipId: takeoverMembershipId,
      businessUnitId,
      capabilities: [APPLY_CAPABILITY],
    },
    applyRoleId,
    sourceId,
    scopeId,
    headId,
    transformId,
    dryRunBatchId,
    batchId,
    approvedBatchVersion: 1,
    rowIds,
    sourceRowKeys,
    evidenceByRowId,
    destinationBySourceKey,
    repairOfBatchId: null,
    operatorReason: null,
  };
}

async function seedRepairFixture(
  original: ApplyFixture,
  value: EvidenceValue = { name: "Reviewed repair", nested: { sequence: 99 } },
): Promise<ApplyFixture> {
  const transformId = randomUUID();
  const dryRunBatchId = randomUUID();
  const batchId = randomUUID();
  const rowId = randomUUID();
  const sourceSha = sha256(`repair:${batchId}`);
  const protectedBytes = evidenceBytes(value);
  const digest = sha256(protectedBytes);
  const operatorReason = "Reviewed correction for the prior canonical import";
  const [version] = await sql<{ version_no: number }[]>`
    select coalesce(max(version_no), 0)::int + 1 as version_no
    from transform_versions
    where organization_id = ${original.organizationId}
      and migration_source_id = ${original.sourceId}
  `;
  await sql`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, repair_of_transform_id, approved_by_membership_id, approved_at
    ) values (
      ${transformId}, ${original.organizationId}, ${original.businessUnitId},
      ${original.sourceId}, ${version!.version_no}, 'sales.v1', ${protectedRef("repair-map")},
      ${sha256(`mapping:${transformId}`)}, ${protectedRef("repair-manifest")},
      ${sha256(`manifest:${transformId}`)}, ${sha256(`release:${transformId}`)},
      'Reviewed repair transform', ${original.transformId},
      ${original.validatorMembershipId}, clock_timestamp() - interval '3 minutes'
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, validated_by_membership_id, validated_at
    ) values (
      ${dryRunBatchId}, ${original.organizationId}, ${original.businessUnitId},
      ${original.sourceId}, ${transformId}, ${protectedRef("repair-dry")}, ${sourceSha}, 1,
      clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '4 minutes',
      'sales.v1', 'DRY_RUN_COMPLETE', true, ${original.validatorMembershipId},
      clock_timestamp() - interval '90 seconds'
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, repair_of_batch_id, protected_artifact_ref, source_sha256,
      size_bytes, captured_at, cutoff_at, schema_version, status, dry_run,
      total_row_count, valid_row_count, approved_row_count,
      validated_by_membership_id, validated_at, approved_by_membership_id, approved_at,
      approval_mode, approval_reason, operator_reason
    ) values (
      ${batchId}, ${original.organizationId}, ${original.businessUnitId},
      ${original.sourceId}, ${transformId}, ${dryRunBatchId}, ${original.batchId},
      ${protectedRef("repair-live")}, ${sourceSha}, 1, clock_timestamp() - interval '1 minute',
      clock_timestamp() - interval '4 minutes', 'sales.v1', 'APPROVED', false,
      1, 1, 1, ${original.validatorMembershipId}, clock_timestamp() - interval '50 seconds',
      ${original.approverMembershipId}, clock_timestamp() - interval '40 seconds',
      'FULL', 'Reviewed repair row approved', ${operatorReason}
    )
  `;
  await sql`
    insert into import_rows (
      id, organization_id, business_unit_id, batch_id, source_row_key, row_number,
      source_object_type, source_record_id, source_locator, row_sha256, raw_evidence_ref,
      normalized_evidence_ref, normalized_sha256, outcome
    ) values (
      ${rowId}, ${original.organizationId}, ${original.businessUnitId}, ${batchId},
      ${original.sourceRowKeys[0]!}, 1, 'synthetic.record', 'repair-record', 'records/repair',
      ${sha256(`raw:${rowId}`)}, ${protectedRef("repair-raw")},
      ${protectedRef("repair-normalized")}, ${digest}, 'VALID'
    )
  `;
  return {
    ...original,
    transformId,
    dryRunBatchId,
    batchId,
    approvedBatchVersion: 1,
    rowIds: [rowId],
    sourceRowKeys: [original.sourceRowKeys[0]!],
    evidenceByRowId: new Map([[rowId, { value, protectedBytes, digest }]]),
    repairOfBatchId: original.batchId,
    operatorReason,
  };
}

function evidenceLoader(
  fixture: ApplyFixture,
  beforeReturn: ((row: ApprovedImportRow) => Promise<void> | void) | undefined = undefined,
): ApprovedEvidenceLoader {
  return {
    async load(row) {
      const entry = fixture.evidenceByRowId.get(row.id);
      if (!entry) throw new Error("SYNTHETIC_PRIVATE_EVIDENCE_NOT_FOUND");
      await beforeReturn?.(row);
      return {
        protectedBytes: new Uint8Array(entry.protectedBytes),
      };
    },
  };
}

function evidenceValidator(
  fixture: ApplyFixture,
): ApprovedEvidenceValidator<EvidenceValue> {
  return {
    parseAndValidate(binding, protectedBytes) {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(protectedBytes),
      );
      if (
        binding.migrationSourceId !== fixture.sourceId ||
        binding.schemaVersion !== "sales.v1" ||
        binding.sourceObjectType !== "synthetic.record" ||
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join("\0") !== "name\0nested"
      ) {
        throw new Error("SYNTHETIC_ADAPTER_SCHEMA_INVALID");
      }
      const record = value as unknown as Record<string, unknown>;
      const nested = record.nested;
      if (
        typeof record.name !== "string" ||
        record.name.length < 1 ||
        nested === null ||
        typeof nested !== "object" ||
        Array.isArray(nested) ||
        Object.keys(nested).join("\0") !== "sequence" ||
        !Number.isSafeInteger((nested as Record<string, unknown>).sequence) ||
        ((nested as Record<string, number>).sequence ?? 0) < 1
      ) {
        throw new Error("SYNTHETIC_ADAPTER_SCHEMA_INVALID");
      }
      return value as EvidenceValue;
    },
  };
}

function canonicalWriter(
  fixture: ApplyFixture,
  options: {
    outcome?: "IMPORTED" | "NO_OP_REPLAY";
    destination?: (row: ApprovedImportRow) => string;
    beforeReturn?: (
      transaction: MigrationDatabaseTransaction,
      row: ApprovedImportRow,
      value: Readonly<EvidenceValue>,
    ) => Promise<void> | void;
  } = {},
): CanonicalImportWriter<MigrationDatabaseTransaction, EvidenceValue> {
  return {
    async apply(transaction, row, value) {
      await options.beforeReturn?.(transaction, row, value);
      return {
        outcome: options.outcome ?? "IMPORTED",
        destinationEntityType: "crm.synthetic_record",
        destinationEntityId:
          options.destination?.(row) ?? fixture.destinationBySourceKey.get(row.sourceRowKey)!,
      };
    },
  };
}

function startInput(
  fixture: ApplyFixture,
  applyRunId: string,
  overrides: Partial<{
    expectedApprovedBatchVersion: number;
    leaseSeconds: number;
    chunkSize: number;
    evidenceLoader: ApprovedEvidenceLoader;
    evidenceValidator: ApprovedEvidenceValidator<EvidenceValue>;
    writer: CanonicalImportWriter<MigrationDatabaseTransaction, EvidenceValue>;
  }> = {},
) {
  return {
    mode: "START" as const,
    batchId: fixture.batchId,
    expectedApprovedBatchVersion:
      overrides.expectedApprovedBatchVersion ?? fixture.approvedBatchVersion,
    applyRunId,
    leaseSeconds: overrides.leaseSeconds ?? 30,
    chunkSize: overrides.chunkSize ?? 2,
    evidenceLoader: overrides.evidenceLoader ?? evidenceLoader(fixture),
    evidenceValidator: overrides.evidenceValidator ?? evidenceValidator(fixture),
    writer: overrides.writer ?? canonicalWriter(fixture),
  };
}

function resumeInput(
  fixture: ApplyFixture,
  applyRunId: string,
  overrides: Partial<{
    leaseSeconds: number;
    chunkSize: number;
    evidenceLoader: ApprovedEvidenceLoader;
    evidenceValidator: ApprovedEvidenceValidator<EvidenceValue>;
    writer: CanonicalImportWriter<MigrationDatabaseTransaction, EvidenceValue>;
  }> = {},
) {
  return {
    mode: "RESUME" as const,
    batchId: fixture.batchId,
    applyRunId,
    leaseSeconds: overrides.leaseSeconds ?? 30,
    chunkSize: overrides.chunkSize ?? 2,
    evidenceLoader: overrides.evidenceLoader ?? evidenceLoader(fixture),
    evidenceValidator: overrides.evidenceValidator ?? evidenceValidator(fixture),
    writer: overrides.writer ?? canonicalWriter(fixture),
  };
}

async function applySnapshot(batchId: string): Promise<unknown> {
  const [snapshot] = await sql<{ value: unknown }[]>`
    select jsonb_build_object(
      'batch', (
        select to_jsonb(batch_data) from (
          select id, status, total_row_count, valid_row_count, rejected_row_count,
                 approved_row_count, imported_row_count, no_op_row_count,
                 applied_by_membership_id, apply_run_id, apply_lease_expires_at,
                 apply_started_at, applied_at, version, updated_at
          from import_batches where id = ${batchId}
        ) batch_data
      ),
      'rows', (
        select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
        from (
          select id, outcome, resolved_link_id, version, updated_at,
                 encode(normalized_sha256, 'hex') as normalized_sha256
          from import_rows where batch_id = ${batchId}
        ) row_data
      ),
      'links', (
        select coalesce(jsonb_agg(to_jsonb(link_data) order by link_data.link_version), '[]'::jsonb)
        from (
          select id, import_row_id, source_object_type, source_row_key, link_version,
                 supersedes_link_id, destination_entity_type, destination_entity_id,
                 correction_reason, created_by_membership_id, created_at
          from legacy_object_links
          where import_row_id in (select id from import_rows where batch_id = ${batchId})
             or id in (select resolved_link_id from import_rows where batch_id = ${batchId})
        ) link_data
      ),
      'audits', (
        select coalesce(jsonb_agg(to_jsonb(audit_data) order by audit_data.id), '[]'::jsonb)
        from (
          select id, action, target_id, outcome, reason, correlation_id,
                 change_summary, occurred_at, recorded_at
          from audit_events where correlation_id = ${batchId}
        ) audit_data
      ),
      'outbox', (
        select coalesce(jsonb_agg(to_jsonb(outbox_data) order by outbox_data.id), '[]'::jsonb)
        from (
          select id, event_type, aggregate_id, aggregate_version, correlation_id,
                 payload, status, version, occurred_at, created_at, updated_at
          from outbox_events where correlation_id = ${batchId}
        ) outbox_data
      )
    ) as value
  `;
  return snapshot?.value;
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
  throw new Error(`Expected apply to block behind PID ${blockerPid}.`);
}

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

beforeAll(async () => {
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    PRODUCT_SURFACE: "crm",
    DEPLOYMENT_ENVIRONMENT: "local",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "24",
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: "apply-tests-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "apply-integration",
    OIDC_CLIENT_SECRET: "apply-integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql`
    insert into capabilities (key, description, risk_level)
    values (${APPLY_CAPABILITY}, 'Apply approved migration rows', 'PRIVILEGED')
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("approved-row canonical apply lifecycle", () => {
  it("imports approved rows with immutable verified values and exact canonical lineage", async () => {
    const fixture = await seedApplyFixture();
    const runId = randomUUID();
    let writerCalls = 0;
    const originalValues = [...fixture.evidenceByRowId.values()].map((entry) => entry.value);
    const writer = canonicalWriter(fixture, {
      async beforeReturn(transaction, row, value) {
        writerCalls += 1;
        expect(Object.isFrozen(row)).toBe(true);
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.nested)).toBe(true);
        expect(originalValues).not.toContain(value);
        expect(transaction).not.toBe(sql);
        expect("databaseUrl" in (transaction as unknown as object)).toBe(false);
      },
    });

    const summary = await applyImportBatch(
      fixture.applierActor,
      startInput(fixture, runId, { writer }),
    );

    expect(summary).toMatchObject({
      batchId: fixture.batchId,
      importedRows: 2,
      noOpRows: 0,
      rejectedRows: 0,
      appliedAt: expect.any(Date),
      replayed: false,
    });
    expect(writerCalls).toBe(2);
    const [stored] = await sql<{
      status: string;
      valid_count: string;
      imported_count: string;
      row_count: number;
      link_count: number;
      row_audits: number;
      row_outbox: number;
      batch_audits: number;
      batch_outbox: number;
    }[]>`
      select batch.status, batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             (select count(*)::int from import_rows where batch_id = batch.id
               and outcome = 'IMPORTED' and resolved_link_id is not null) as row_count,
             (select count(*)::int from legacy_object_links link
               join import_rows row_record on row_record.id = link.import_row_id
               where row_record.batch_id = batch.id) as link_count,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action in ('MIGRATION_IMPORT_BATCH_APPLY_STARTED',
                              'MIGRATION_IMPORT_BATCH_APPLIED')) as batch_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type in ('crm.migration.import_batch_apply_started',
                                  'crm.migration.import_batch_applied')) as batch_outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "APPLIED",
      valid_count: "0",
      imported_count: "2",
      row_count: 2,
      link_count: 2,
      row_audits: 2,
      row_outbox: 2,
      batch_audits: 2,
      batch_outbox: 2,
    });
  });

  it("returns a partial-approval summary with its reviewed rejected rows", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID", "REJECTED"] });
    const summary = await applyImportBatch(
      fixture.applierActor,
      startInput(fixture, randomUUID()),
    );
    expect(summary).toMatchObject({
      importedRows: 1,
      noOpRows: 0,
      rejectedRows: 1,
      replayed: false,
    });
  });

  it("rejects an unapproved batch without loading evidence", async () => {
    const fixture = await seedApplyFixture({ status: "VALIDATED" });
    let loads = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: evidenceLoader(fixture, () => {
            loads += 1;
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPLY_STATE_INVALID", status: 409 });
    expect(loads).toBe(0);
  });

  it("rejects the underlying approver as applier through a different membership", async () => {
    const fixture = await seedApplyFixture();
    await expect(
      applyImportBatch(
        fixture.approverAsApplierActor,
        startInput(fixture, randomUUID()),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_MAKER_CHECKER_REQUIRED", status: 409 });
  });

  it("rejects a quarantined row hidden behind approved counters", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const rowId = fixture.rowIds[0]!;
    await sql`
      update import_rows set outcome = 'QUARANTINED', error_code = 'LATE_QUARANTINE',
          error_metadata = ${sql.json({ ruleCode: "LATE_QUARANTINE" })}
      where id = ${rowId}
    `;
    await sql`
      insert into quarantine_items (
        organization_id, business_unit_id, import_row_id, reason_code, reason_metadata
      ) values (
        ${fixture.organizationId}, ${fixture.businessUnitId}, ${rowId}, 'LATE_QUARANTINE',
        ${sql.json({ ruleCode: "LATE_QUARANTINE" })}
      )
    `;
    await expect(
      applyImportBatch(fixture.applierActor, startInput(fixture, randomUUID())),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPROVED_ROWS_INVALID", status: 409 });
  });

  it("rejects a pre-imported row hidden behind approved counters", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const linkId = randomUUID();
    await sql`
      insert into legacy_object_links (
        id, organization_id, business_unit_id, migration_source_id, import_row_id,
        source_object_type, source_row_key, link_version, destination_entity_type,
        destination_entity_id, created_by_membership_id
      ) values (
        ${linkId}, ${fixture.organizationId}, ${fixture.businessUnitId}, ${fixture.sourceId},
        ${fixture.rowIds[0]!}, 'synthetic.record', ${fixture.sourceRowKeys[0]!}, 1,
        'crm.synthetic_record', ${fixture.destinationBySourceKey.get(fixture.sourceRowKeys[0]!)!},
        ${fixture.applierMembershipId}
      )
    `;
    await sql`
      update import_rows set outcome = 'IMPORTED', resolved_link_id = ${linkId}
      where id = ${fixture.rowIds[0]!}
    `;
    await expect(
      applyImportBatch(fixture.applierActor, startInput(fixture, randomUUID())),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPROVED_ROWS_INVALID", status: 409 });
  });

  it("performs the initial claim as one exact versioned compare-and-set", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    const loaderEntered = deferred<void>();
    const releaseLoader = deferred<void>();
    const operation = applyImportBatch(
      fixture.applierActor,
      startInput(fixture, runId, {
        evidenceLoader: evidenceLoader(fixture, async () => {
          loaderEntered.resolve(undefined);
          await releaseLoader.promise;
        }),
      }),
    );
    await loaderEntered.promise;
    const [claimed] = await sql<{
      status: string;
      version: string;
      run_id: string;
      applier: string;
      lease_live: boolean;
    }[]>`
      select status, version, apply_run_id as run_id,
             applied_by_membership_id as applier,
             apply_lease_expires_at > clock_timestamp() as lease_live
      from import_batches where id = ${fixture.batchId}
    `;
    expect(claimed).toEqual({
      status: "APPLYING",
      version: String(fixture.approvedBatchVersion + 1),
      run_id: runId,
      applier: fixture.applierMembershipId,
      lease_live: true,
    });
    releaseLoader.resolve(undefined);
    await expect(operation).resolves.toMatchObject({ replayed: false });

    const stale = await seedApplyFixture({ outcomes: ["VALID"] });
    await expect(
      applyImportBatch(
        stale.applierActor,
        startInput(stale, randomUUID(), { expectedApprovedBatchVersion: 2 }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_VERSION_CONFLICT", status: 409 });
  });

  it("does not compare the stale original approved version after the first chunk", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID", "VALID", "VALID"] });
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), { chunkSize: 1 }),
      ),
    ).resolves.toMatchObject({ importedRows: 3, replayed: false });
  });
});

describe("resume, leases, replay, and concurrency", () => {
  it("resumes after a crash between rows without duplicating the committed writer outcome", async () => {
    const fixture = await seedApplyFixture();
    const runId = randomUUID();
    let calls = 0;
    const crashingWriter = canonicalWriter(fixture, {
      beforeReturn() {
        calls += 1;
        if (calls === 2) throw new Error("SYNTHETIC_PRIVATE_PROCESS_CRASH");
      },
    });
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, runId, { chunkSize: 1, writer: crashingWriter }),
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 });
    const [crashed] = await sql<{
      status: string;
      valid_count: string;
      imported_count: string;
      links: number;
    }[]>`
      select batch.status, batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             (select count(*)::int from legacy_object_links link
               join import_rows row_record on row_record.id = link.import_row_id
               where row_record.batch_id = batch.id) as links
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(crashed).toEqual({
      status: "APPLYING",
      valid_count: "1",
      imported_count: "1",
      links: 1,
    });

    let resumedWriterCalls = 0;
    const summary = await applyImportBatch(
      fixture.applierAlternateActor,
      resumeInput(fixture, runId, {
        chunkSize: 1,
        writer: canonicalWriter(fixture, {
          beforeReturn() {
            resumedWriterCalls += 1;
          },
        }),
      }),
    );
    expect(summary).toMatchObject({ importedRows: 2, replayed: false });
    expect(resumedWriterCalls).toBe(1);
  });

  it("renews an expired lease from the database clock for the same run and identity", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, runId, {
          leaseSeconds: 1,
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              throw new Error("SYNTHETIC_PAUSE_AFTER_CLAIM");
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 });
    await sql`select pg_sleep(1.1)`;

    const summary = await applyImportBatch(
      fixture.applierAlternateActor,
      resumeInput(fixture, runId, { leaseSeconds: 5 }),
    );
    expect(summary).toMatchObject({ importedRows: 1, replayed: false });
    const [stored] = await sql<{
      applier: string;
      resume_audits: number;
      resume_outbox: number;
    }[]>`
      select batch.applied_by_membership_id as applier,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_BATCH_APPLY_RESUMED') as resume_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_batch_apply_resumed') as resume_outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      applier: fixture.applierMembershipId,
      resume_audits: 1,
      resume_outbox: 1,
    });
  });

  it("allows concurrent same-run resumes while executing each writer exactly once", async () => {
    const fixture = await seedApplyFixture();
    const runId = randomUUID();
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, runId, {
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              throw new Error("SYNTHETIC_STARTER_EXIT");
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 });

    const bothLoadersEntered = deferred<void>();
    const releaseLoaders = deferred<void>();
    let loadCount = 0;
    const sharedLoader = evidenceLoader(fixture, async () => {
      loadCount += 1;
      if (loadCount === 2) bothLoadersEntered.resolve(undefined);
      if (loadCount <= 2) await releaseLoaders.promise;
    });
    let writerCalls = 0;
    const sharedWriter = canonicalWriter(fixture, {
      beforeReturn() {
        writerCalls += 1;
      },
    });
    const left = applyImportBatch(
      fixture.applierActor,
      resumeInput(fixture, runId, {
        chunkSize: 1,
        evidenceLoader: sharedLoader,
        writer: sharedWriter,
      }),
    );
    const right = applyImportBatch(
      fixture.applierAlternateActor,
      resumeInput(fixture, runId, {
        chunkSize: 1,
        evidenceLoader: sharedLoader,
        writer: sharedWriter,
      }),
    );
    await bothLoadersEntered.promise;
    releaseLoaders.resolve(undefined);
    const results = await Promise.all([left, right]);
    expect(results.map((result) => result.importedRows)).toEqual([2, 2]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(writerCalls).toBe(2);
  });

  it("returns replay to a delayed same-run worker after its peer finalizes without calling its writer", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    const delayedLoaderEntered = deferred<void>();
    const releaseDelayedLoader = deferred<void>();
    let delayedWriterCalls = 0;
    const delayed = applyImportBatch(
      fixture.applierActor,
      startInput(fixture, runId, {
        evidenceLoader: evidenceLoader(fixture, async () => {
          delayedLoaderEntered.resolve(undefined);
          await releaseDelayedLoader.promise;
        }),
        writer: canonicalWriter(fixture, {
          beforeReturn() {
            delayedWriterCalls += 1;
          },
        }),
      }),
    );
    await delayedLoaderEntered.promise;

    const winner = await applyImportBatch(
      fixture.applierAlternateActor,
      resumeInput(fixture, runId),
    );
    releaseDelayedLoader.resolve(undefined);
    const replay = await delayed;

    expect(winner).toMatchObject({ importedRows: 1, replayed: false });
    expect(replay).toEqual({ ...winner, replayed: true });
    expect(delayedWriterCalls).toBe(0);
  });

  it("overlaps distinct row-level writer transactions within one bounded chunk", async () => {
    const fixture = await seedApplyFixture();
    const firstWriterEntered = deferred<void>();
    const secondWriterEntered = deferred<void>();
    const releaseWriters = deferred<void>();
    const enteredRows = new Set<string>();
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const applying = applyImportBatch(
      fixture.applierActor,
      startInput(fixture, randomUUID(), {
        chunkSize: 2,
        writer: canonicalWriter(fixture, {
          async beforeReturn(_transaction, row) {
            enteredRows.add(row.id);
            activeWriters += 1;
            maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
            if (enteredRows.size === 1) firstWriterEntered.resolve(undefined);
            if (enteredRows.size === 2) secondWriterEntered.resolve(undefined);
            await releaseWriters.promise;
            activeWriters -= 1;
          },
        }),
      }),
    );
    await firstWriterEntered.promise;
    const overlapped = await Promise.race([
      secondWriterEntered.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseWriters.resolve(undefined);
    const summary = await applying;

    expect(overlapped).toBe(true);
    expect(maxActiveWriters).toBe(2);
    expect(enteredRows).toEqual(new Set(fixture.rowIds));
    expect(summary).toMatchObject({ importedRows: 2, replayed: false });
  });

  it("waits for every sibling row transaction to settle before reporting a chunk failure", async () => {
    const fixture = await seedApplyFixture();
    const siblingWriterEntered = deferred<void>();
    const releaseSiblingWriter = deferred<void>();
    const failingRowId = fixture.rowIds[0]!;
    let callSettled = false;
    const applying = applyImportBatch(
      fixture.applierActor,
      startInput(fixture, randomUUID(), {
        chunkSize: 2,
        writer: canonicalWriter(fixture, {
          async beforeReturn(_transaction, row) {
            if (row.id === failingRowId) throw new Error("SYNTHETIC_ROW_FAILURE");
            siblingWriterEntered.resolve(undefined);
            await releaseSiblingWriter.promise;
          },
        }),
      }),
    )
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
      .finally(() => {
        callSettled = true;
      });
    await siblingWriterEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callSettled).toBe(false);
    releaseSiblingWriter.resolve(undefined);
    const result = await applying;

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 },
    });
    const [stored] = await sql<{
      status: string;
      valid_count: string;
      imported_count: string;
      valid_rows: number;
      imported_rows: number;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select batch.status,
             batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             (select count(*)::int from import_rows where batch_id = batch.id
               and outcome = 'VALID') as valid_rows,
             (select count(*)::int from import_rows where batch_id = batch.id
               and outcome = 'IMPORTED') as imported_rows,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox
      from import_batches batch where batch.id = ${fixture.batchId}
    `;
    expect(stored).toEqual({
      status: "APPLYING",
      valid_count: "1",
      imported_count: "1",
      valid_rows: 1,
      imported_rows: 1,
      row_audits: 1,
      row_outbox: 1,
    });
  });

  it("rejects a live competing run before evidence access", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, runId, {
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              throw new Error("SYNTHETIC_LEAVE_APPLYING");
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 });
    let loads = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        resumeInput(fixture, randomUUID(), {
          evidenceLoader: evidenceLoader(fixture, () => {
            loads += 1;
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPLY_LEASE_CONFLICT", status: 409 });
    expect(loads).toBe(0);
  });

  it("fails closed on an expired cross-identity takeover", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, runId, {
          leaseSeconds: 1,
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              throw new Error("SYNTHETIC_EXPIRED_OWNER");
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 });
    await sql`select pg_sleep(1.1)`;
    await expect(
      applyImportBatch(
        fixture.takeoverActor,
        resumeInput(fixture, runId),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_APPLY_TAKEOVER_REQUIRED", status: 409 });
  });

  it("returns exact APPLIED replay without any evidence or database mutation", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    const first = await applyImportBatch(
      fixture.applierActor,
      startInput(fixture, runId),
    );
    const before = await applySnapshot(fixture.batchId);
    let loads = 0;
    const replay = await applyImportBatch(
      fixture.applierAlternateActor,
      startInput(fixture, runId, {
        evidenceLoader: evidenceLoader(fixture, () => {
          loads += 1;
        }),
      }),
    );
    const after = await applySnapshot(fixture.batchId);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(loads).toBe(0);
    expect(after).toEqual(before);
  });
});

describe("canonical transaction atomicity and authority races", () => {
  it("rechecks authority after waiting behind a canonical cutover", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const runId = randomUUID();
    const loaderEntered = deferred<void>();
    const releaseLoader = deferred<void>();
    let writerCalls = 0;
    const operation = applyImportBatch(
      fixture.applierActor,
      startInput(fixture, runId, {
        evidenceLoader: evidenceLoader(fixture, async () => {
          loaderEntered.resolve(undefined);
          await releaseLoader.promise;
        }),
        writer: canonicalWriter(fixture, {
          beforeReturn() {
            writerCalls += 1;
          },
        }),
      }),
    );
    await loaderEntered.promise;

    const blocker = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    const releaseCutover = deferred<void>();
    const cutoverReady = deferred<number>();
    const cutover = blocker.begin(async (transaction) => {
      const [backend] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await transaction`
        select id from migration_domain_authorities where id = ${fixture.headId} for update
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
      cutoverReady.resolve(backend!.pid);
      await releaseCutover.promise;
    });
    try {
      const cutoverPid = await cutoverReady.promise;
      releaseLoader.resolve(undefined);
      await waitUntilBlockedBy(cutoverPid);
      releaseCutover.resolve(undefined);
      await cutover;
      await expect(operation).rejects.toMatchObject({
        code: "MIGRATION_SOURCE_NOT_ACTIVE",
        status: 409,
      });
    } finally {
      releaseLoader.resolve(undefined);
      releaseCutover.resolve(undefined);
      await Promise.allSettled([operation, cutover]);
      await blocker.end();
    }
    expect(writerCalls).toBe(0);
    const [stored] = await sql<{ outcome: string; links: number }[]>`
      select row_record.outcome,
             (select count(*)::int from legacy_object_links
               where import_row_id = row_record.id) as links
      from import_rows row_record where row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({ outcome: "VALID", links: 0 });
  });

  it("rolls back canonical writer mutations and sanitizes writer failure detail", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const secret = "SYNTHETIC_PRIVATE_CANONICAL_SECRET";
    let failure: unknown;
    try {
      await applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          writer: canonicalWriter(fixture, {
            async beforeReturn(transaction) {
              await transaction
                .update(businessUnits)
                .set({ name: "WRITER_MUTATION_MUST_ROLL_BACK" })
                .where(eq(businessUnits.id, fixture.businessUnitId));
              throw new Error(secret);
            },
          }),
        }),
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "CANONICAL_IMPORT_WRITER_FAILED", status: 500 });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(secret);
    const [stored] = await sql<{
      name: string;
      outcome: string;
      links: number;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select unit.name, row_record.outcome,
             (select count(*)::int from legacy_object_links
               where import_row_id = row_record.id) as links,
             (select count(*)::int from audit_events where target_id = row_record.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where aggregate_id = row_record.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox
      from business_units unit cross join import_rows row_record
      where unit.id = ${fixture.businessUnitId} and row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      name: fixture.originalBusinessUnitName,
      outcome: "VALID",
      links: 0,
      row_audits: 0,
      row_outbox: 0,
    });
  });

  it.each(["audit", "outbox"] as const)(
    "rolls back writer, lineage, row, counters, and %s effect failure atomically",
    async (kind) => {
      const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
      const functionName = `crm_test_fail_apply_${kind}`;
      const table = kind === "audit" ? "audit_events" : "outbox_events";
      const condition =
        kind === "audit"
          ? "new.action = 'MIGRATION_IMPORT_ROW_APPLIED'"
          : "new.event_type = 'crm.migration.import_row_applied'";
      await sql.unsafe(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          if ${condition} then raise exception 'synthetic apply ${kind} failure'; end if;
          return new;
        end; $$;
        create trigger ${functionName}_trigger before insert on ${table}
        for each row execute function ${functionName}();
      `);
      try {
        await expect(
          applyImportBatch(
            fixture.applierActor,
            startInput(fixture, randomUUID(), {
              writer: canonicalWriter(fixture, {
                async beforeReturn(transaction) {
                  await transaction
                    .update(businessUnits)
                    .set({ name: `FAILED_${kind.toUpperCase()}_MUTATION` })
                    .where(eq(businessUnits.id, fixture.businessUnitId));
                },
              }),
            }),
          ),
        ).rejects.toMatchObject({ code: "IMPORT_ROW_APPLY_FAILED", status: 500 });
      } finally {
        await sql.unsafe(`
          drop trigger if exists ${functionName}_trigger on ${table};
          drop function if exists ${functionName}();
        `);
      }
      const [stored] = await sql<{
        name: string;
        outcome: string;
        valid_count: string;
        imported_count: string;
        links: number;
        row_audits: number;
        row_outbox: number;
      }[]>`
        select unit.name, row_record.outcome, batch.valid_row_count as valid_count,
               batch.imported_row_count as imported_count,
               (select count(*)::int from legacy_object_links
                 where import_row_id = row_record.id) as links,
               (select count(*)::int from audit_events where target_id = row_record.id
                 and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
               (select count(*)::int from outbox_events where aggregate_id = row_record.id
                 and event_type = 'crm.migration.import_row_applied') as row_outbox
        from business_units unit cross join import_rows row_record
        join import_batches batch on batch.id = row_record.batch_id
        where unit.id = ${fixture.businessUnitId} and row_record.id = ${fixture.rowIds[0]!}
      `;
      expect(stored).toEqual({
        name: fixture.originalBusinessUnitName,
        outcome: "VALID",
        valid_count: "1",
        imported_count: "0",
        links: 0,
        row_audits: 0,
        row_outbox: 0,
      });
    },
  );

  it("rolls back a writer that revokes its own live capability", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          writer: canonicalWriter(fixture, {
            async beforeReturn(transaction) {
              await transaction.execute(
                `delete from role_capabilities
                 where organization_id = '${fixture.organizationId}'::uuid
                   and role_id = '${fixture.applyRoleId}'::uuid
                   and capability_key = '${APPLY_CAPABILITY}'`,
              );
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    const [stored] = await sql<{ grants: number; outcome: string; links: number }[]>`
      select
        (select count(*)::int from role_capabilities
          where organization_id = ${fixture.organizationId}
            and role_id = ${fixture.applyRoleId}
            and capability_key = ${APPLY_CAPABILITY}) as grants,
        row_record.outcome,
        (select count(*)::int from legacy_object_links
          where import_row_id = row_record.id) as links
      from import_rows row_record where row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({ grants: 1, outcome: "VALID", links: 0 });
  });
});

describe("repair-only replay and correction lineage", () => {
  it("uses the current link for a distinct repair-only NO_OP without changing original evidence", async () => {
    const original = await seedApplyFixture({ outcomes: ["VALID"] });
    const originalRunId = randomUUID();
    await applyImportBatch(original.applierActor, startInput(original, originalRunId));
    const [originalRowBefore] = await sql<{
      outcome: string;
      resolved_link_id: string;
      version: string;
    }[]>`
      select outcome, resolved_link_id, version from import_rows
      where id = ${original.rowIds[0]!}
    `;
    const repair = await seedRepairFixture(
      original,
      original.evidenceByRowId.get(original.rowIds[0]!)!.value,
    );
    const currentLinkId = originalRowBefore!.resolved_link_id;
    const summary = await applyImportBatch(
      repair.applierActor,
      startInput(repair, randomUUID(), {
        writer: canonicalWriter(repair, {
          outcome: "NO_OP_REPLAY",
          destination: () => original.destinationBySourceKey.get(original.sourceRowKeys[0]!)!,
        }),
      }),
    );
    expect(summary).toMatchObject({ importedRows: 0, noOpRows: 1, replayed: false });
    const [stored] = await sql<{
      original_outcome: string;
      original_link: string;
      original_version: string;
      repair_outcome: string;
      repair_link: string;
      links: number;
    }[]>`
      select original.outcome as original_outcome,
             original.resolved_link_id as original_link,
             original.version as original_version,
             repair.outcome as repair_outcome,
             repair.resolved_link_id as repair_link,
             (select count(*)::int from legacy_object_links
               where migration_source_id = ${original.sourceId}
                 and source_row_key = ${original.sourceRowKeys[0]!}) as links
      from import_rows original cross join import_rows repair
      where original.id = ${original.rowIds[0]!} and repair.id = ${repair.rowIds[0]!}
    `;
    expect(stored).toEqual({
      original_outcome: "IMPORTED",
      original_link: currentLinkId,
      original_version: originalRowBefore!.version,
      repair_outcome: "NO_OP_REPLAY",
      repair_link: currentLinkId,
      links: 1,
    });
  });

  it("rejects repair-only NO_OP when verified normalized evidence differs from the linked canonical origin", async () => {
    const original = await seedApplyFixture({ outcomes: ["VALID"] });
    await applyImportBatch(original.applierActor, startInput(original, randomUUID()));
    const repair = await seedRepairFixture(original, {
      name: "Different verified repair value",
      nested: { sequence: 404 },
    });
    await expect(
      applyImportBatch(
        repair.applierActor,
        startInput(repair, randomUUID(), {
          writer: canonicalWriter(repair, {
            outcome: "NO_OP_REPLAY",
            destination: () =>
              original.destinationBySourceKey.get(original.sourceRowKeys[0]!)!,
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_NO_OP_VALUE_MISMATCH", status: 409 });
    const [stored] = await sql<{
      status: string;
      valid_count: string;
      imported_count: string;
      no_op_count: string;
      outcome: string;
      resolved_link_id: string | null;
      links: number;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select batch.status,
             batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             batch.no_op_row_count as no_op_count,
             row_record.outcome,
             row_record.resolved_link_id,
             (select count(*)::int from legacy_object_links
               where migration_source_id = ${repair.sourceId}
                 and source_row_key = ${repair.sourceRowKeys[0]!}) as links,
             (select count(*)::int from audit_events
               where correlation_id = batch.id
                 and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events
               where correlation_id = batch.id
                 and event_type = 'crm.migration.import_row_applied') as row_outbox
      from import_batches batch
      join import_rows row_record
        on row_record.organization_id = batch.organization_id
       and row_record.business_unit_id = batch.business_unit_id
       and row_record.batch_id = batch.id
      where batch.id = ${repair.batchId} and row_record.id = ${repair.rowIds[0]!}
    `;
    expect(stored).toEqual({
      status: "APPLYING",
      valid_count: "1",
      imported_count: "0",
      no_op_count: "0",
      outcome: "VALID",
      resolved_link_id: null,
      links: 1,
      row_audits: 0,
      row_outbox: 0,
    });
  });

  it("forbids NO_OP_REPLAY on a non-repair row", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          writer: canonicalWriter(fixture, { outcome: "NO_OP_REPLAY" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_NO_OP_REPAIR_REQUIRED", status: 409 });
  });

  it("appends a unique correction link with reason and actor", async () => {
    const original = await seedApplyFixture({ outcomes: ["VALID"] });
    await applyImportBatch(original.applierActor, startInput(original, randomUUID()));
    const [head] = await sql<{ id: string }[]>`
      select id from legacy_object_links where import_row_id = ${original.rowIds[0]!}
    `;
    const repair = await seedRepairFixture(original);
    const correctedDestination = randomUUID();
    await applyImportBatch(
      repair.applierActor,
      startInput(repair, randomUUID(), {
        writer: canonicalWriter(repair, { destination: () => correctedDestination }),
      }),
    );
    const links = await sql<{
      link_version: number;
      supersedes_link_id: string | null;
      destination_entity_id: string;
      correction_reason: string | null;
      created_by_membership_id: string;
    }[]>`
      select link_version, supersedes_link_id, destination_entity_id,
             correction_reason, created_by_membership_id
      from legacy_object_links
      where migration_source_id = ${original.sourceId}
        and source_row_key = ${original.sourceRowKeys[0]!}
      order by link_version
    `;
    expect(links).toEqual([
      expect.objectContaining({ link_version: 1, supersedes_link_id: null }),
      {
        link_version: 2,
        supersedes_link_id: head!.id,
        destination_entity_id: correctedDestination,
        correction_reason: repair.operatorReason,
        created_by_membership_id: repair.applierMembershipId,
      },
    ]);
  });

  it("rejects a duplicate lineage head created during evidence loading", async () => {
    const original = await seedApplyFixture({ outcomes: ["VALID"] });
    await applyImportBatch(original.applierActor, startInput(original, randomUUID()));
    const repair = await seedRepairFixture(original);
    let writerCalls = 0;
    const loader = evidenceLoader(repair, async () => {
      const shadowBatchId = randomUUID();
      const shadowRowId = randomUUID();
      const shadowSourceSha = sha256(`shadow:${shadowBatchId}`);
      await sql`
        insert into import_batches (
          id, organization_id, business_unit_id, migration_source_id, transform_version_id,
          protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
          schema_version, status, dry_run, total_row_count, valid_row_count
        ) values (
          ${shadowBatchId}, ${repair.organizationId}, ${repair.businessUnitId},
          ${repair.sourceId}, ${repair.transformId}, ${protectedRef("shadow-batch")},
          ${shadowSourceSha}, 1, clock_timestamp(), clock_timestamp() - interval '1 minute',
          'sales.v1', 'STAGED', true, 1, 1
        )
      `;
      await sql`
        insert into import_rows (
          id, organization_id, business_unit_id, batch_id, source_row_key,
          source_object_type, source_locator, row_sha256, raw_evidence_ref,
          normalized_evidence_ref, normalized_sha256, outcome
        ) values (
          ${shadowRowId}, ${repair.organizationId}, ${repair.businessUnitId}, ${shadowBatchId},
          ${repair.sourceRowKeys[0]!}, 'synthetic.record', 'records/shadow',
          ${sha256(`raw:${shadowRowId}`)}, ${protectedRef("shadow-raw")},
          ${protectedRef("shadow-normalized")}, ${sha256("shadow-normalized")}, 'VALID'
        )
      `;
      const [current] = await sql<{ id: string; link_version: number }[]>`
        select id, link_version from legacy_object_links
        where migration_source_id = ${repair.sourceId}
          and source_row_key = ${repair.sourceRowKeys[0]!}
        order by link_version desc limit 1
      `;
      await sql`
        insert into legacy_object_links (
          organization_id, business_unit_id, migration_source_id, import_row_id,
          source_object_type, source_row_key, link_version, supersedes_link_id,
          destination_entity_type, destination_entity_id, correction_reason,
          created_by_membership_id
        ) values (
          ${repair.organizationId}, ${repair.businessUnitId}, ${repair.sourceId},
          ${shadowRowId}, 'synthetic.record', ${repair.sourceRowKeys[0]!},
          ${current!.link_version + 1}, ${current!.id}, 'crm.synthetic_record', ${randomUUID()},
          'Concurrent reviewed lineage correction', ${repair.applierMembershipId}
        )
      `;
    });
    await expect(
      applyImportBatch(
        repair.applierActor,
        startInput(repair, randomUUID(), {
          evidenceLoader: loader,
          writer: canonicalWriter(repair, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_LINEAGE_CHANGED", status: 409 });
    expect(writerCalls).toBe(0);
  });
});

describe("evidence, row-version, tenant, and hostile dependency boundaries", () => {
  it("loads and validates protected evidence with no business transaction open", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    let loaderChecked = false;
    let validatorChecked = false;
    const loader = evidenceLoader(fixture, async () => {
      await sql.begin(async (transaction) => {
        await transaction`
          select id from import_batches where id = ${fixture.batchId} for update nowait
        `;
        await transaction`
          select id from migration_domain_authorities where id = ${fixture.headId}
          for update nowait
        `;
      });
      loaderChecked = true;
    });
    const validator = evidenceValidator(fixture);
    await applyImportBatch(
      fixture.applierActor,
      startInput(fixture, randomUUID(), {
        evidenceLoader: loader,
        evidenceValidator: {
          async parseAndValidate(binding, protectedBytes) {
            await sql.begin(async (transaction) => {
              await transaction`
                select id from import_batches where id = ${fixture.batchId}
                for update nowait
              `;
              await transaction`
                select id from migration_domain_authorities where id = ${fixture.headId}
                for update nowait
              `;
            });
            const value = validator.parseAndValidate(binding, protectedBytes);
            validatorChecked = true;
            return value;
          },
        },
      }),
    );
    expect(loaderChecked).toBe(true);
    expect(validatorChecked).toBe(true);
  });

  it("rejects a stale row version changed during protected evidence loading", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: evidenceLoader(fixture, async (row) => {
            await sql`
              update import_rows set updated_at = clock_timestamp() where id = ${row.id}
            `;
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_VERSION_CONFLICT", status: 409 });
  });

  it("conceals a wrong-tenant batch before evidence access", async () => {
    const owner = await seedApplyFixture({ outcomes: ["VALID"] });
    const attacker = await seedApplyFixture({ outcomes: ["VALID"] });
    let loads = 0;
    await expect(
      applyImportBatch(
        attacker.applierActor,
        {
          ...startInput(attacker, randomUUID(), {
            evidenceLoader: evidenceLoader(owner, () => {
              loads += 1;
            }),
          }),
          batchId: owner.batchId,
        },
      ),
    ).rejects.toMatchObject({ code: "IMPORT_BATCH_NOT_FOUND", status: 404 });
    expect(loads).toBe(0);
  });

  it("rejects protected bytes whose digest does not bind the approved row", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    let writerCalls = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return {
                protectedBytes: Buffer.from("wrong-normalized-evidence", "utf8"),
              };
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    expect(writerCalls).toBe(0);
  });

  it("applies the exact approved protected bytes without inventing a canonical JSON digest", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const protectedBytes = Buffer.from(
      `{\n  "nested": { "sequence": 1 },\n  "name": "Canonical row 0"\n}\n`,
      "utf8",
    );
    const protectedDigest = sha256(protectedBytes);
    await sql`
      update import_rows
      set normalized_sha256 = ${protectedDigest}
      where id = ${fixture.rowIds[0]!}
    `;

    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return { protectedBytes };
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ importedRows: 1, noOpRows: 0, rejectedRows: 0 });
  });

  it("lets the bound adapter derive a typed value from non-JSON protected bytes", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const protectedBytes = Buffer.from(
      "synthetic-binary\0Canonical row 0\0sequence=1",
      "utf8",
    );
    await sql`
      update import_rows
      set normalized_sha256 = ${sha256(protectedBytes)}
      where id = ${fixture.rowIds[0]!}
    `;
    let writerValue: Readonly<EvidenceValue> | null = null;

    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return { protectedBytes };
            },
          },
          evidenceValidator: {
            parseAndValidate(binding, bytes) {
              expect(binding).toEqual({
                migrationSourceId: fixture.sourceId,
                schemaVersion: "sales.v1",
                sourceObjectType: "synthetic.record",
              });
              expect(Buffer.from(bytes).equals(protectedBytes)).toBe(true);
              return { name: "Canonical row 0", nested: { sequence: 1 } };
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn(_transaction, _row, value) {
              writerValue = value;
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({ importedRows: 1, noOpRows: 0, rejectedRows: 0 });
    expect(writerValue).toEqual({ name: "Canonical row 0", nested: { sequence: 1 } });
    expect(Object.isFrozen(writerValue)).toBe(true);
  });

  it("rejects an exact-byte digest mismatch before invoking adapter schema validation", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const tamperedBytes = evidenceBytes({
      name: "Digest-mismatched and schema-invalid",
      nested: { sequence: "not-an-integer" },
    });
    let validatorCalls = 0;
    let writerCalls = 0;

    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return { protectedBytes: tamperedBytes };
            },
          },
          evidenceValidator: {
            parseAndValidate() {
              validatorCalls += 1;
              throw new Error("SYNTHETIC_ADAPTER_SCHEMA_REJECTED");
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    expect(validatorCalls).toBe(0);
    expect(writerCalls).toBe(0);
  });

  it("rejects an adapter that mutates the digest-bound bytes before returning a value", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    let writerCalls = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceValidator: {
            parseAndValidate(_binding, protectedBytes) {
              const mutableBytes = protectedBytes as Uint8Array;
              mutableBytes[0] = mutableBytes[0]! ^ 0xff;
              return { name: "Canonical row 0", nested: { sequence: 1 } };
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    expect(writerCalls).toBe(0);
  });

  it("rejects oversized protected bytes before copying them or opening writer access", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const oversizedBytes = new Uint8Array(1_048_577);
    const originalConstructor = Uint8Array;
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array")!;
    let oversizedCopyAttempted = false;
    let writerCalls = 0;
    const trackingConstructor = new Proxy(originalConstructor, {
      construct(target, argumentsList, newTarget) {
        if (argumentsList[0] === oversizedBytes) oversizedCopyAttempted = true;
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(globalThis, "Uint8Array", {
      ...originalDescriptor,
      value: trackingConstructor,
    });
    try {
      await expect(
        applyImportBatch(
          fixture.applierActor,
          startInput(fixture, randomUUID(), {
            evidenceLoader: {
              async load() {
                return { protectedBytes: oversizedBytes };
              },
            },
            writer: canonicalWriter(fixture, {
              beforeReturn() {
                writerCalls += 1;
              },
            }),
          }),
        ),
      ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    } finally {
      Object.defineProperty(globalThis, "Uint8Array", originalDescriptor);
    }
    expect(oversizedCopyAttempted).toBe(false);
    expect(writerCalls).toBe(0);
    const [stored] = await sql<{
      valid_count: string;
      imported_count: string;
      outcome: string;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             row_record.outcome,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox
      from import_batches batch
      join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      valid_count: "1",
      imported_count: "0",
      outcome: "VALID",
      row_audits: 0,
      row_outbox: 0,
    });
  });

  it("rejects tampered protected bytes even when they decode to valid adapter data", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const entry = fixture.evidenceByRowId.get(fixture.rowIds[0]!)!;
    let writerCalls = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return {
                protectedBytes: evidenceBytes({
                  name: "Tampered after digest verification",
                  nested: { sequence: entry.value.nested.sequence + 1 },
                }),
              };
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    expect(writerCalls).toBe(0);
    const [stored] = await sql<{
      status: string;
      valid_count: string;
      imported_count: string;
      no_op_count: string;
      outcome: string;
      resolved_link_id: string | null;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select batch.status,
             batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             batch.no_op_row_count as no_op_count,
             row_record.outcome,
             row_record.resolved_link_id,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox
      from import_batches batch
      join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      status: "APPLYING",
      valid_count: "1",
      imported_count: "0",
      no_op_count: "0",
      outcome: "VALID",
      resolved_link_id: null,
      row_audits: 0,
      row_outbox: 0,
    });
  });

  it("rejects an accessor-bearing typed value returned by the adapter", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const entry = fixture.evidenceByRowId.get(fixture.rowIds[0]!)!;
    const invalid = Object.defineProperties({}, {
      name: { value: entry.value.name, enumerable: true },
      nested: { get: () => entry.value.nested, enumerable: true },
    }) as EvidenceValue;
    let writerCalls = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceValidator: {
            parseAndValidate() {
              return invalid;
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    expect(writerCalls).toBe(0);
    const [stored] = await sql<{
      valid_count: string;
      imported_count: string;
      outcome: string;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             row_record.outcome,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox
      from import_batches batch
      join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      valid_count: "1",
      imported_count: "0",
      outcome: "VALID",
      row_audits: 0,
      row_outbox: 0,
    });
  });

  it("requires the source adapter schema verifier to reject digest-matching business-invalid evidence", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const invalidValue = {
      name: "Digest-bound but adapter-invalid",
      nested: { sequence: "not-an-integer" },
    };
    const invalidBytes = evidenceBytes(invalidValue);
    const invalidDigest = sha256(invalidBytes);
    await sql`
      update import_rows
      set normalized_sha256 = ${invalidDigest}
      where id = ${fixture.rowIds[0]!}
    `;
    let validatorCalls = 0;
    let writerCalls = 0;
    const input = {
      ...startInput(fixture, randomUUID(), {
        evidenceLoader: {
          async load() {
            return { protectedBytes: invalidBytes };
          },
        },
        writer: canonicalWriter(fixture, {
          beforeReturn() {
            writerCalls += 1;
          },
        }),
      }),
      evidenceValidator: {
        parseAndValidate(
          binding: {
            migrationSourceId: string;
            schemaVersion: string;
            sourceObjectType: string;
          },
          protectedBytes: Readonly<Uint8Array>,
        ) {
          validatorCalls += 1;
          expect(binding).toEqual({
            migrationSourceId: fixture.sourceId,
            schemaVersion: "sales.v1",
            sourceObjectType: "synthetic.record",
          });
          expect(Buffer.from(protectedBytes).equals(invalidBytes)).toBe(true);
          throw new Error("SYNTHETIC_ADAPTER_SCHEMA_REJECTED");
        },
      },
    };
    await expect(
      applyImportBatch(fixture.applierActor, input),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_SCHEMA_INVALID", status: 422 });
    expect(validatorCalls).toBe(1);
    expect(writerCalls).toBe(0);
    const [stored] = await sql<{
      valid_count: string;
      imported_count: string;
      outcome: string;
      row_audits: number;
      row_outbox: number;
    }[]>`
      select batch.valid_row_count as valid_count,
             batch.imported_row_count as imported_count,
             row_record.outcome,
             (select count(*)::int from audit_events where correlation_id = batch.id
               and action = 'MIGRATION_IMPORT_ROW_APPLIED') as row_audits,
             (select count(*)::int from outbox_events where correlation_id = batch.id
               and event_type = 'crm.migration.import_row_applied') as row_outbox
      from import_batches batch
      join import_rows row_record on row_record.batch_id = batch.id
      where batch.id = ${fixture.batchId} and row_record.id = ${fixture.rowIds[0]!}
    `;
    expect(stored).toEqual({
      valid_count: "1",
      imported_count: "0",
      outcome: "VALID",
      row_audits: 0,
      row_outbox: 0,
    });
  });

  it("preserves an own __proto__ field safely before the bound adapter schema rejects it", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const entry = fixture.evidenceByRowId.get(fixture.rowIds[0]!)!;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      name: { value: entry.value.name, enumerable: true },
      nested: { value: entry.value.nested, enumerable: true },
    });
    Object.defineProperty(hostile, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });
    const hostileBytes = evidenceBytes(hostile);
    const hostileDigest = sha256(hostileBytes);
    await sql`
      update import_rows
      set normalized_sha256 = ${hostileDigest}
      where id = ${fixture.rowIds[0]!}
    `;
    let inspected = false;
    let writerCalls = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return { protectedBytes: hostileBytes };
            },
          },
          evidenceValidator: {
            parseAndValidate(_binding, protectedBytes) {
              const record = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(protectedBytes),
              ) as Record<string, unknown>;
              expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
              expect(Object.hasOwn(record, "__proto__")).toBe(true);
              expect(record.__proto__).toEqual({ polluted: true });
              expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
              inspected = true;
              throw new Error("SYNTHETIC_UNKNOWN_ADAPTER_FIELD");
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_SCHEMA_INVALID", status: 422 });
    expect(inspected).toBe(true);
    expect(writerCalls).toBe(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    {
      label: "property count",
      buildValue() {
        return Object.fromEntries(
          Array.from({ length: 10_001 }, (_, index) => [`p${index}`, index]),
        );
      },
    },
    {
      label: "key bytes",
      buildValue() {
        return { [`k${"x".repeat(262_144)}`]: true };
      },
    },
    {
      label: "aggregate artifact bytes",
      buildValue() {
        return Object.fromEntries(
          Array.from({ length: 8_000 }, (_, index) => [
            `artifact_${index.toString().padStart(6, "0")}`,
            "v".repeat(105),
          ]),
        );
      },
    },
  ])("rejects approved evidence exceeding the bounded $label before writer access", async ({ buildValue }) => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const protectedBytes = evidenceBytes(buildValue());
    const digest = sha256(protectedBytes);
    await sql`
      update import_rows
      set normalized_sha256 = ${digest}
      where id = ${fixture.rowIds[0]!}
    `;
    let writerCalls = 0;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceLoader: {
            async load() {
              return { protectedBytes };
            },
          },
          evidenceValidator: {
            parseAndValidate(_binding, bytes) {
              return JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              ) as EvidenceValue;
            },
          },
          writer: canonicalWriter(fixture, {
            beforeReturn() {
              writerCalls += 1;
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
    expect(writerCalls).toBe(0);
  });

  it.each([
    {
      label: "proxy result",
      loader(fixture: ApplyFixture): ApprovedEvidenceLoader {
        return {
          async load(row) {
            return new Proxy(
              {
                protectedBytes: fixture.evidenceByRowId.get(row.id)!.protectedBytes,
              },
              {},
            );
          },
        };
      },
    },
    {
      label: "accessor result",
      loader(fixture: ApplyFixture): ApprovedEvidenceLoader {
        return {
          async load(row) {
            const entry = fixture.evidenceByRowId.get(row.id)!;
            return Object.defineProperties({}, {
              protectedBytes: {
                get() { return entry.protectedBytes; },
                enumerable: true,
              },
            }) as { protectedBytes: Uint8Array };
          },
        };
      },
    },
  ])("rejects hostile approved evidence: $label", async ({ loader }) => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), { evidenceLoader: loader(fixture) }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
  });

  it("rejects a cyclic typed value returned by the adapter", async () => {
    const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    await expect(
      applyImportBatch(
        fixture.applierActor,
        startInput(fixture, randomUUID(), {
          evidenceValidator: {
            parseAndValidate() {
              return cyclic as unknown as EvidenceValue;
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "APPROVED_EVIDENCE_BINDING_INVALID", status: 422 });
  });

  it.each(["proxy", "accessor"] as const)(
    "rejects a hostile %s writer result and rolls back its transaction",
    async (kind) => {
      const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
      const writer: CanonicalImportWriter<MigrationDatabaseTransaction, EvidenceValue> = {
        async apply(transaction) {
          await transaction
            .update(businessUnits)
            .set({ name: "HOSTILE_WRITER_RESULT" })
            .where(eq(businessUnits.id, fixture.businessUnitId));
          const result = {
            outcome: "IMPORTED" as const,
            destinationEntityType: "crm.synthetic_record",
            destinationEntityId: randomUUID(),
          };
          if (kind === "proxy") return new Proxy(result, {});
          return Object.defineProperties({}, {
            outcome: { get() { return result.outcome; }, enumerable: true },
            destinationEntityType: {
              value: result.destinationEntityType,
              enumerable: true,
            },
            destinationEntityId: { value: result.destinationEntityId, enumerable: true },
          }) as typeof result;
        },
      };
      await expect(
        applyImportBatch(
          fixture.applierActor,
          startInput(fixture, randomUUID(), { writer }),
        ),
      ).rejects.toMatchObject({ code: "CANONICAL_IMPORT_WRITER_RESULT_INVALID", status: 500 });
      const [stored] = await sql<{ name: string; outcome: string }[]>`
        select unit.name, row_record.outcome
        from business_units unit cross join import_rows row_record
        where unit.id = ${fixture.businessUnitId} and row_record.id = ${fixture.rowIds[0]!}
      `;
      expect(stored).toEqual({ name: fixture.originalBusinessUnitName, outcome: "VALID" });
    },
  );

  it("validates bounded lease and chunk inputs before claiming a batch", async () => {
    for (const overrides of [
      { leaseSeconds: 0 },
      { leaseSeconds: 3_601 },
      { chunkSize: 0 },
      { chunkSize: 101 },
    ]) {
      const fixture = await seedApplyFixture({ outcomes: ["VALID"] });
      await expect(
        applyImportBatch(
          fixture.applierActor,
          startInput(fixture, randomUUID(), overrides),
        ),
      ).rejects.toMatchObject({ code: "MIGRATION_INPUT_INVALID", status: 422 });
      const [stored] = await sql<{ status: string; run_id: string | null }[]>`
        select status, apply_run_id as run_id from import_batches where id = ${fixture.batchId}
      `;
      expect(stored).toEqual({ status: "APPROVED", run_id: null });
    }
  });
});
