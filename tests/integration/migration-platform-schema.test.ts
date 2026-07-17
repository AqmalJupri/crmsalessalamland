import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@/server/db/migrate";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for migration platform tests.");

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Migration platform tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
type TestSql = Sql | TransactionSql;

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  organizationTwo: "10000000-0000-4000-8000-000000000002",
  businessUnit: "20000000-0000-4000-8000-000000000001",
  businessUnitTwo: "20000000-0000-4000-8000-000000000002",
  businessUnitOtherOrg: "20000000-0000-4000-8000-000000000003",
  userOrgWide: "30000000-0000-4000-8000-000000000001",
  userBusinessUnit: "30000000-0000-4000-8000-000000000002",
  userOtherBusinessUnit: "30000000-0000-4000-8000-000000000003",
  userReassignable: "30000000-0000-4000-8000-000000000004",
  membershipOrgWide: "40000000-0000-4000-8000-000000000001",
  membershipBusinessUnit: "40000000-0000-4000-8000-000000000002",
  membershipOtherBusinessUnit: "40000000-0000-4000-8000-000000000003",
  membershipReassignable: "40000000-0000-4000-8000-000000000004",
} as const;

let sequence = 1;
function syntheticId(prefix: number): string {
  const suffix = String(sequence++).padStart(12, "0");
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${suffix}`;
}

const sha = (byte: string) => Buffer.from(byte.repeat(32), "hex");

async function seedIdentityFixtures(db: TestSql): Promise<void> {
  await db`
    insert into organizations (id, code, name)
    values
      (${ids.organization}, 'synthetic-org', 'Synthetic Organisation'),
      (${ids.organizationTwo}, 'synthetic-org-two', 'Synthetic Organisation Two')
  `;
  await db`
    insert into business_units (id, organization_id, code, name)
    values
      (${ids.businessUnit}, ${ids.organization}, 'synthetic-one', 'Synthetic One'),
      (${ids.businessUnitTwo}, ${ids.organization}, 'synthetic-two', 'Synthetic Two'),
      (${ids.businessUnitOtherOrg}, ${ids.organizationTwo}, 'synthetic-three', 'Synthetic Three')
  `;
  await db`
    insert into users (id, auth_subject, display_name, status)
    values
      (${ids.userOrgWide}, 'synthetic-org-wide', 'Synthetic Org Wide', 'ACTIVE'),
      (${ids.userBusinessUnit}, 'synthetic-bu', 'Synthetic BU', 'ACTIVE'),
      (${ids.userOtherBusinessUnit}, 'synthetic-other-bu', 'Synthetic Other BU', 'ACTIVE'),
      (${ids.userReassignable}, 'synthetic-reassignable', 'Synthetic Reassignable', 'ACTIVE')
  `;
  await db`
    insert into memberships (id, organization_id, business_unit_id, user_id, status)
    values
      (${ids.membershipOrgWide}, ${ids.organization}, null, ${ids.userOrgWide}, 'ACTIVE'),
      (${ids.membershipBusinessUnit}, ${ids.organization}, ${ids.businessUnit}, ${ids.userBusinessUnit}, 'ACTIVE'),
      (${ids.membershipOtherBusinessUnit}, ${ids.organization}, ${ids.businessUnitTwo}, ${ids.userOtherBusinessUnit}, 'ACTIVE'),
      (${ids.membershipReassignable}, ${ids.organization}, ${ids.businessUnit}, ${ids.userReassignable}, 'ACTIVE')
  `;
}

interface SourceFixture {
  sourceId: string;
  scopeId: string;
  authorityId: string;
  domainKey: string;
}

async function insertSourceAuthority(
  db: TestSql,
  options: {
    ownerMembershipId?: string;
    authorityState?: "EXTERNAL_SYSTEM_AUTHORITY" | "CANONICAL_WRITABLE";
    canonicalTarget?: string;
    domainKey?: string;
  } = {},
): Promise<SourceFixture> {
  const sourceId = syntheticId(51);
  const scopeId = syntheticId(52);
  const authorityId = syntheticId(53);
  const domainKey = options.domainKey ?? `synthetic.domain_${sequence}`;
  const canonicalTarget = options.canonicalTarget ?? "crm.synthetic";
  const authorityState = options.authorityState ?? "EXTERNAL_SYSTEM_AUTHORITY";

  await db`
    insert into migration_sources (
      id, organization_id, business_unit_id, source_key, source_kind, source_mode,
      owner_membership_id, status
    ) values (
      ${sourceId}, ${ids.organization}, ${ids.businessUnit}, ${`source-${sequence}`},
      'NIAGAWAN_CSV', 'ONE_TIME_MIGRATION',
      ${options.ownerMembershipId ?? ids.membershipBusinessUnit}, 'ACTIVE'
    )
  `;
  await db`
    insert into migration_source_scopes (
      id, organization_id, business_unit_id, migration_source_id, domain_key,
      canonical_target, transition_mode, source_status
    ) values (
      ${scopeId}, ${ids.organization}, ${ids.businessUnit}, ${sourceId}, ${domainKey},
      ${canonicalTarget}, 'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
    )
  `;
  await db`
    insert into migration_domain_authorities (
      id, organization_id, business_unit_id, domain_key, canonical_target,
      authority_state, authority_source_scope_id
    ) values (
      ${authorityId}, ${ids.organization}, ${ids.businessUnit}, ${domainKey}, ${canonicalTarget},
      ${authorityState}, ${authorityState === "CANONICAL_WRITABLE" ? null : scopeId}
    )
  `;
  return { sourceId, scopeId, authorityId, domainKey };
}

async function insertTransform(db: TestSql, sourceId: string): Promise<string> {
  const transformId = syntheticId(54);
  await db`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, approved_by_membership_id, approved_at
    ) values (
      ${transformId}, ${ids.organization}, ${ids.businessUnit}, ${sourceId}, 1,
      'synthetic.v1', 'protected://synthetic/mapping', ${sha("11")},
      'protected://synthetic/release', ${sha("12")}, ${sha("13")},
      'Synthetic approved transform', ${ids.membershipBusinessUnit}, clock_timestamp()
    )
  `;
  return transformId;
}

interface BatchFixture {
  dryRunId: string;
  liveBatchId: string;
  checksum: Buffer;
}

async function insertDryRunAndLiveBatch(
  db: TestSql,
  sourceId: string,
  transformId: string,
): Promise<BatchFixture> {
  const dryRunId = syntheticId(55);
  const liveBatchId = syntheticId(56);
  const checksum = sha("21");

  await db`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, total_row_count, valid_row_count,
      validated_by_membership_id, validated_at
    ) values (
      ${dryRunId}, ${ids.organization}, ${ids.businessUnit}, ${sourceId}, ${transformId},
      'protected://synthetic/dry-run', ${checksum}, 1, transaction_timestamp(), transaction_timestamp(),
      'synthetic.v1', 'DRY_RUN_COMPLETE', true, 1, 1,
      ${ids.membershipBusinessUnit}, clock_timestamp()
    )
  `;
  await db`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
      captured_at, cutoff_at, schema_version, status, dry_run
    ) values (
      ${liveBatchId}, ${ids.organization}, ${ids.businessUnit}, ${sourceId}, ${transformId},
      ${dryRunId}, 'protected://synthetic/live', ${checksum}, 1,
      transaction_timestamp(), transaction_timestamp(), 'synthetic.v1', 'REGISTERED', false
    )
  `;
  return { dryRunId, liveBatchId, checksum };
}

async function insertImportRow(
  db: TestSql,
  batchId: string,
  options: {
    sourceRowKey?: string;
    outcome?: "STAGED" | "REJECTED";
    errorCode?: string | null;
    normalizedEvidenceRef?: string | null;
    normalizedSha256?: Buffer | null;
  } = {},
): Promise<string> {
  const rowId = syntheticId(61);
  await db`
    insert into import_rows (
      id, organization_id, business_unit_id, batch_id, source_row_key,
      source_object_type, source_locator, row_sha256, raw_evidence_ref,
      normalized_evidence_ref, normalized_sha256, outcome, error_code
    ) values (
      ${rowId}, ${ids.organization}, ${ids.businessUnit}, ${batchId},
      ${options.sourceRowKey ?? `row-${sequence}`}, 'synthetic.record',
      'synthetic://row', ${sha("61")}, 'protected://synthetic/raw-row',
      ${options.normalizedEvidenceRef ?? null}, ${options.normalizedSha256 ?? null},
      ${options.outcome ?? "STAGED"}, ${options.errorCode ?? null}
    )
  `;
  return rowId;
}

async function insertPendingCountReconciliation(
  db: TestSql,
  batchId: string,
): Promise<string> {
  const runId = syntheticId(59);
  const requiredChecks = [
    {
      check_kind: "COUNT",
      check_key: "records.total",
      scope_key: "all",
      measure_unit: null,
      decimal_scale: null,
    },
  ];
  await db`
    insert into reconciliation_runs (
      id, organization_id, business_unit_id, batch_id, run_no, status,
      plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
      required_check_count
    ) values (
      ${runId}, ${ids.organization}, ${ids.businessUnit}, ${batchId}, 1, 'PENDING',
      'protected://synthetic/reconciliation-plan', ${sha("62")}, ${db.json(requiredChecks)},
      digest(convert_to(${db.json(requiredChecks)}::jsonb::text, 'UTF8'), 'sha256'), 1
    )
  `;
  return runId;
}

async function promoteLiveBatch(
  db: TestSql,
  batchId: string,
  terminalStatus: "APPLIED" | "RECONCILED" = "RECONCILED",
): Promise<void> {
  await db`
    update import_batches
    set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
        validated_by_membership_id = ${ids.membershipBusinessUnit},
        validated_at = clock_timestamp(), approval_mode = 'FULL',
        approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
        approved_at = clock_timestamp(), approval_reason = 'Synthetic final approval'
    where id = ${batchId}
  `;
  await db`
    update import_batches
    set status = 'APPLYING', applied_by_membership_id = ${ids.membershipBusinessUnit},
        apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
        apply_lease_expires_at = transaction_timestamp() + interval '1 minute'
    where id = ${batchId}
  `;
  await db`
    update import_batches
    set status = 'APPLIED', valid_row_count = 0, imported_row_count = 1,
        applied_at = clock_timestamp()
    where id = ${batchId}
  `;
  if (terminalStatus === "RECONCILED") {
    await db`update import_batches set status = 'RECONCILED' where id = ${batchId}`;
  }
}

async function recordCanonicalTransition(
  fixture: SourceFixture,
  finalBatchId: string,
  options: {
    updateHead?: boolean;
    writeFrozenOffsetSeconds?: number;
  } = {},
): Promise<void> {
  await sql.begin(async (transaction) => {
    const groupId = syntheticId(57);
    await transaction`
      insert into source_authority_transition_groups (
        id, organization_id, idempotency_key, group_size, group_sha256,
        plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
      ) values (
        ${groupId}, ${ids.organization}, ${`canonical-${sequence}`}, 1, ${sha("72")},
        'protected://synthetic/canonical-plan', ${sha("73")},
        ${ids.membershipOrgWide}, 'Synthetic canonical transition'
      )
    `;
    if (options.updateHead !== false) {
      await transaction`
        update migration_domain_authorities
        set authority_state = 'CANONICAL_WRITABLE', authority_source_scope_id = null
        where id = ${fixture.authorityId}
      `;
    }
    await transaction`
      insert into source_authority_transitions (
        id, organization_id, business_unit_id, transition_group_id,
        domain_authority_id, from_source_scope_id, to_source_scope_id,
        from_state, to_state, write_frozen_at, final_batch_id, final_cutoff_at
      ) values (
        ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${groupId},
        ${fixture.authorityId}, ${fixture.scopeId}, null,
        'EXTERNAL_SYSTEM_AUTHORITY', 'CANONICAL_WRITABLE',
        (select cutoff_at + ${options.writeFrozenOffsetSeconds ?? 0} * interval '1 second'
           from import_batches where id = ${finalBatchId}),
        ${finalBatchId}, (select cutoff_at from import_batches where id = ${finalBatchId})
      )
    `;
  });
}

beforeAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await seedIdentityFixtures(sql);
});

afterAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
});

describe("migration control-plane catalog", () => {
  it("creates the complete tenant-scoped catalog", async () => {
    const expectedTables = [
      "import_batches",
      "import_rows",
      "legacy_object_links",
      "migration_domain_authorities",
      "migration_source_scopes",
      "migration_sources",
      "quarantine_items",
      "reconciliation_results",
      "reconciliation_runs",
      "source_authority_transition_groups",
      "source_authority_transitions",
      "transform_versions",
    ];
    const tables = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${expectedTables})
      order by table_name
    `;
    expect(tables.map(({ table_name }) => table_name)).toEqual(expectedTables);

    const columns = await sql<{
      table_name: string;
      column_name: string;
      is_nullable: "YES" | "NO";
    }[]>`
      select table_name, column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = any(${expectedTables})
    `;
    const columnSet = new Set(columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`));
    const requiredColumns: Record<string, readonly string[]> = {
      migration_sources: ["id", "organization_id", "business_unit_id", "source_key", "source_kind", "source_mode", "owner_membership_id", "status", "version", "created_at", "updated_at"],
      migration_source_scopes: ["id", "organization_id", "business_unit_id", "migration_source_id", "domain_key", "canonical_target", "transition_mode", "source_status", "version", "created_at", "updated_at"],
      migration_domain_authorities: ["id", "organization_id", "business_unit_id", "domain_key", "canonical_target", "authority_state", "authority_source_scope_id", "version", "created_at", "updated_at"],
      source_authority_transition_groups: ["id", "organization_id", "idempotency_key", "group_size", "group_sha256", "plan_artifact_ref", "plan_sha256", "effective_at", "approved_by_membership_id", "approval_reason", "created_at"],
      source_authority_transitions: ["id", "organization_id", "business_unit_id", "transition_group_id", "domain_authority_id", "from_source_scope_id", "to_source_scope_id", "from_state", "to_state", "write_frozen_at", "final_batch_id", "final_cutoff_at", "created_at"],
      transform_versions: ["id", "organization_id", "business_unit_id", "migration_source_id", "version_no", "source_schema_version", "mapping_artifact_ref", "mapping_sha256", "release_manifest_ref", "release_manifest_sha256", "transform_release_sha256", "rationale", "repair_of_transform_id", "approved_by_membership_id", "approved_at", "created_at"],
      import_batches: ["id", "organization_id", "business_unit_id", "migration_source_id", "transform_version_id", "validated_dry_run_batch_id", "repair_of_batch_id", "protected_artifact_ref", "source_sha256", "size_bytes", "captured_at", "cutoff_at", "schema_version", "status", "dry_run", "total_row_count", "staged_row_count", "valid_row_count", "rejected_row_count", "quarantined_row_count", "hidden_row_count", "approved_row_count", "imported_row_count", "no_op_row_count", "validated_by_membership_id", "validated_at", "approved_by_membership_id", "approved_at", "approval_mode", "approval_reason", "applied_by_membership_id", "apply_run_id", "apply_lease_expires_at", "apply_started_at", "applied_at", "operator_reason", "failure_code", "version", "created_at", "updated_at"],
      import_rows: ["id", "organization_id", "business_unit_id", "batch_id", "source_row_key", "row_number", "source_object_type", "source_record_id", "source_locator", "row_sha256", "raw_evidence_ref", "normalized_evidence_ref", "normalized_sha256", "outcome", "error_code", "error_metadata", "resolved_link_id", "version", "created_at", "updated_at"],
      legacy_object_links: ["id", "organization_id", "business_unit_id", "migration_source_id", "import_row_id", "source_object_type", "source_row_key", "link_version", "supersedes_link_id", "destination_entity_type", "destination_entity_id", "correction_reason", "created_by_membership_id", "created_at"],
      quarantine_items: ["id", "organization_id", "business_unit_id", "import_row_id", "reason_code", "reason_metadata", "status", "resolution", "resolved_by_membership_id", "resolved_at", "resolution_reason", "version", "created_at", "updated_at"],
      reconciliation_runs: ["id", "organization_id", "business_unit_id", "batch_id", "run_no", "status", "plan_artifact_ref", "plan_sha256", "required_checks", "required_checks_sha256", "required_check_count", "passed_check_count", "failed_check_count", "signed_by_membership_id", "signed_at", "version", "created_at", "updated_at"],
      reconciliation_results: ["id", "organization_id", "business_unit_id", "run_id", "check_kind", "check_key", "scope_key", "source_count", "target_count", "source_amount", "target_amount", "measure_unit", "decimal_scale", "source_checksum", "target_checksum", "passed", "evidence_metadata", "created_at"],
    };
    for (const [tableName, names] of Object.entries(requiredColumns)) {
      for (const name of names) expect(columnSet).toContain(`${tableName}.${name}`);
    }

    for (const tableName of expectedTables) {
      expect(columns.find((column) => column.table_name === tableName && column.column_name === "organization_id")?.is_nullable).toBe("NO");
      if (tableName !== "source_authority_transition_groups") {
        expect(columns.find((column) => column.table_name === tableName && column.column_name === "business_unit_id")?.is_nullable).toBe("NO");
      }
    }
  });

  it("installs named constraints, queue indexes, and invariant triggers", async () => {
    const constraints = await sql<{ conname: string; definition: string }[]>`
      select conname, pg_get_constraintdef(oid, true) as definition
      from pg_constraint
      where connamespace = 'public'::regnamespace
    `;
    const constraintByName = new Map(
      constraints.map(({ conname, definition }) => [conname, definition]),
    );
    for (const name of [
      "migration_sources_source_unique",
      "migration_source_scopes_domain_unique",
      "migration_domain_authorities_domain_unique",
      "source_authority_transition_groups_idempotency_unique",
      "source_authority_transitions_member_unique",
      "transform_versions_version_unique",
      "import_batches_source_snapshot_unique",
      "import_rows_source_key_unique",
      "legacy_object_links_version_unique",
      "reconciliation_runs_run_unique",
      "reconciliation_results_identity_unique",
      "reconciliation_results_derived_pass_truth",
      "import_batches_counters_consistent",
      "import_batches_lifecycle_consistent",
      "import_rows_resolution_link_consistent",
      "reconciliation_results_kind_values_consistent",
    ]) {
      expect(constraintByName.has(name), `missing constraint ${name}`).toBe(true);
    }

    const vocabulary = (constraintName: string) =>
      [...(constraintByName.get(constraintName) ?? "").matchAll(/'([A-Z][A-Z0-9_]*)'::text/g)]
        .map((match) => match[1]);
    const lockedVocabularies: Record<string, readonly string[]> = {
      migration_sources_kind_valid: [
        "SALAM_CRM_JSON", "TASHA_SQLITE", "NIAGAWAN_CSV", "BARAKAH_SHEET",
      ],
      migration_sources_mode_valid: ["ONE_TIME_MIGRATION", "RECURRING_READ_ONLY_SNAPSHOT"],
      migration_sources_status_valid: ["REGISTERED", "ACTIVE", "ARCHIVED_READ_ONLY"],
      migration_source_scopes_mode_valid: ["ONE_TIME_CUTOVER", "RECURRING_EXTERNAL_SNAPSHOT"],
      migration_source_scopes_status_valid: [
        "REGISTERED", "ACTIVE_AUTHORITY", "ARCHIVED_READ_ONLY",
      ],
      migration_domain_authorities_state_valid: [
        "LEGACY_WRITABLE", "EXTERNAL_SYSTEM_AUTHORITY", "SHADOW_READ", "CANONICAL_WRITABLE",
      ],
      authority_transitions_from_state_valid: [
        "LEGACY_WRITABLE", "EXTERNAL_SYSTEM_AUTHORITY", "SHADOW_READ", "CANONICAL_WRITABLE",
      ],
      authority_transitions_to_state_valid: [
        "LEGACY_WRITABLE", "EXTERNAL_SYSTEM_AUTHORITY", "SHADOW_READ", "CANONICAL_WRITABLE",
      ],
      import_batches_status_valid: [
        "REGISTERED", "STAGED", "VALIDATED", "DRY_RUN_COMPLETE", "APPROVED",
        "APPLYING", "APPLIED", "RECONCILED", "REJECTED", "FAILED",
      ],
      import_batches_approval_mode_valid: ["FULL", "PARTIAL"],
      import_rows_outcome_valid: [
        "STAGED", "VALID", "IMPORTED", "NO_OP_REPLAY", "REJECTED", "QUARANTINED", "HIDDEN",
      ],
      quarantine_items_status_valid: ["OPEN", "RESOLVED"],
      quarantine_items_resolution_valid: ["APPROVE_ROW", "REJECT_ROW"],
      reconciliation_runs_status_valid: ["PENDING", "PASSED", "FAILED", "SIGNED"],
      reconciliation_results_kind_valid: [
        "COUNT", "AMOUNT", "CHECKSUM", "UNIQUENESS", "REFERENCE", "TIMELINE",
        "LOT_ALLOCATION", "FINANCE_BALANCE", "FILE", "SAMPLE",
      ],
    };
    for (const [constraintName, values] of Object.entries(lockedVocabularies)) {
      expect(vocabulary(constraintName), `${constraintName} vocabulary drifted`).toEqual(values);
    }
    expect(constraintByName.get("import_batches_source_sha256_valid")).toMatch(
      /octet_length\(source_sha256\) = 32/,
    );
    expect(constraintByName.get("import_rows_source_key_format")).toContain(
      "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
    );
    expect(constraintByName.get("legacy_object_links_source_key_format")).toContain(
      "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
    );
    expect(constraintByName.get("reconciliation_results_scope_key_format")).toContain(
      "^[a-z][a-z0-9_.:-]*$",
    );
    expect(constraintByName.get("import_batches_dry_run_fk")).toContain(
      "FOREIGN KEY (organization_id, business_unit_id, migration_source_id, source_sha256, transform_version_id, validated_dry_run_batch_id)",
    );
    expect(constraintByName.get("import_rows_resolved_link_fk")).toContain(
      "FOREIGN KEY (organization_id, business_unit_id, resolved_link_id)",
    );

    const indexes = await sql<{
      indexname: string;
      table_name: string;
      columns: string[];
      is_unique: boolean;
      definition: string;
      predicate: string | null;
    }[]>`
      select index_table.relname as indexname,
             owner_table.relname as table_name,
             array(
               select pg_get_indexdef(index_row.indexrelid, position, true)
               from generate_series(1, index_row.indnkeyatts) position
               order by position
             ) as columns,
             index_row.indisunique as is_unique,
             pg_get_indexdef(index_row.indexrelid) as definition,
             pg_get_expr(index_row.indpred, index_row.indrelid) as predicate
      from pg_index index_row
      join pg_class index_table on index_table.oid = index_row.indexrelid
      join pg_class owner_table on owner_table.oid = index_row.indrelid
      where owner_table.relnamespace = 'public'::regnamespace
    `;
    const indexByName = new Map(indexes.map((index) => [index.indexname, index]));
    for (const name of [
      "import_batches_pending_idx",
      "import_rows_pending_idx",
      "quarantine_items_open_idx",
      "reconciliation_runs_pending_idx",
      "import_rows_row_number_unique",
      "quarantine_items_open_unique",
    ]) {
      expect(indexByName.has(name), `missing index ${name}`).toBe(true);
    }

    const reverseIndexes: Record<
      string,
      { table: string; column: string; predicate: string | null }
    > = {
      migration_domain_authorities_scope_lookup_idx: {
        table: "migration_domain_authorities", column: "authority_source_scope_id",
        predicate: "(authority_source_scope_id IS NOT NULL)",
      },
      source_authority_transitions_authority_lookup_idx: {
        table: "source_authority_transitions", column: "domain_authority_id", predicate: null,
      },
      source_authority_transitions_from_scope_lookup_idx: {
        table: "source_authority_transitions", column: "from_source_scope_id",
        predicate: "(from_source_scope_id IS NOT NULL)",
      },
      source_authority_transitions_to_scope_lookup_idx: {
        table: "source_authority_transitions", column: "to_source_scope_id",
        predicate: "(to_source_scope_id IS NOT NULL)",
      },
      source_authority_transitions_final_batch_lookup_idx: {
        table: "source_authority_transitions", column: "final_batch_id",
        predicate: "(final_batch_id IS NOT NULL)",
      },
      import_batches_dry_run_lookup_idx: {
        table: "import_batches", column: "validated_dry_run_batch_id",
        predicate: "(validated_dry_run_batch_id IS NOT NULL)",
      },
      migration_sources_owner_lookup_idx: {
        table: "migration_sources", column: "owner_membership_id", predicate: null,
      },
      transition_groups_approver_lookup_idx: {
        table: "source_authority_transition_groups", column: "approved_by_membership_id",
        predicate: null,
      },
      transform_versions_approver_lookup_idx: {
        table: "transform_versions", column: "approved_by_membership_id",
        predicate: "(approved_by_membership_id IS NOT NULL)",
      },
      import_batches_validator_lookup_idx: {
        table: "import_batches", column: "validated_by_membership_id",
        predicate: "(validated_by_membership_id IS NOT NULL)",
      },
      import_batches_approver_lookup_idx: {
        table: "import_batches", column: "approved_by_membership_id",
        predicate: "(approved_by_membership_id IS NOT NULL)",
      },
      import_batches_applier_lookup_idx: {
        table: "import_batches", column: "applied_by_membership_id",
        predicate: "(applied_by_membership_id IS NOT NULL)",
      },
      legacy_object_links_creator_lookup_idx: {
        table: "legacy_object_links", column: "created_by_membership_id", predicate: null,
      },
      quarantine_items_resolver_lookup_idx: {
        table: "quarantine_items", column: "resolved_by_membership_id",
        predicate: "(resolved_by_membership_id IS NOT NULL)",
      },
      reconciliation_runs_signer_lookup_idx: {
        table: "reconciliation_runs", column: "signed_by_membership_id",
        predicate: "(signed_by_membership_id IS NOT NULL)",
      },
    };
    for (const [indexName, expectedIndex] of Object.entries(reverseIndexes)) {
      const actualIndex = indexByName.get(indexName);
      expect(actualIndex, `missing reverse lookup index ${indexName}`).toBeDefined();
      expect({
        table: actualIndex?.table_name,
        columns: actualIndex?.columns,
        unique: actualIndex?.is_unique,
        predicate: actualIndex?.predicate,
      }).toEqual({
        table: expectedIndex.table,
        columns: [expectedIndex.column],
        unique: false,
        predicate: expectedIndex.predicate,
      });
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe("set local enable_seqscan = off");
      for (const [indexName, { table, column }] of Object.entries(reverseIndexes)) {
        const plan = await transaction.unsafe(
          `explain (format json) select 1 from public.${table} where ${column} = $1::uuid`,
          [ids.membershipBusinessUnit],
        );
        expect(JSON.stringify(plan), `${indexName} is not usable by its scoped lookup`).toContain(
          indexName,
        );
      }
    });

    const predicateStates = (indexName: string) =>
      [...(indexByName.get(indexName)?.predicate ?? "").matchAll(/'([A-Z_]+)'::text/g)].map(
        (match) => match[1],
      );
    expect(predicateStates("import_batches_pending_idx")).toEqual([
      "REGISTERED",
      "STAGED",
      "VALIDATED",
      "APPROVED",
      "APPLYING",
      "APPLIED",
    ]);
    expect(predicateStates("import_rows_pending_idx")).toEqual([
      "STAGED",
      "VALID",
      "QUARANTINED",
    ]);
    expect(predicateStates("reconciliation_runs_pending_idx")).toEqual([
      "PENDING",
      "PASSED",
      "FAILED",
    ]);
    expect(indexByName.get("quarantine_items_open_idx")?.predicate).toBe(
      "(status = 'OPEN'::text)",
    );
    expect(indexByName.get("quarantine_items_open_unique")?.predicate).toBe(
      "(status = 'OPEN'::text)",
    );
    expect(indexByName.get("import_rows_row_number_unique")?.predicate).toBe(
      "(row_number IS NOT NULL)",
    );
    expect(indexByName.get("import_rows_source_key_unique")?.definition).toContain(
      "(organization_id, batch_id, source_row_key)",
    );
    expect(indexByName.get("reconciliation_results_identity_unique")?.definition).toContain(
      "(organization_id, run_id, check_kind, check_key, scope_key, measure_unit, decimal_scale)",
    );
    expect(indexByName.get("reconciliation_results_identity_unique")?.definition).toMatch(
      /NULLS NOT DISTINCT$/,
    );

    const [nullIdentity] = await sql<{ indnullsnotdistinct: boolean }[]>`
      select index.indnullsnotdistinct
      from pg_constraint constraint_row
      join pg_index index on index.indexrelid = constraint_row.conindid
      where constraint_row.conname = 'reconciliation_results_identity_unique'
    `;
    expect(nullIdentity?.indnullsnotdistinct).toBe(true);

    const triggers = await sql<{
      tgname: string;
      definition: string;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      table_name: string;
      tgtype: number;
      function_name: string;
    }[]>`
      select trigger_row.tgname, pg_get_triggerdef(trigger_row.oid) as definition,
             trigger_row.tgdeferrable, trigger_row.tginitdeferred,
             trigger_row.tgrelid::regclass::text as table_name,
             trigger_row.tgtype::integer as tgtype,
             function_row.proname as function_name
      from pg_trigger trigger_row
      join pg_proc function_row on function_row.oid = trigger_row.tgfoid
      where not trigger_row.tgisinternal
        and trigger_row.tgrelid in (
          select table_name.oid
          from pg_class table_name
          where table_name.relnamespace = 'public'::regnamespace
        )
    `;
    const deferredTriggers: Array<{
      name: string;
      table: string;
      type: number;
      fn: string;
    }> = [
      { name: "migration_authority_scope_from_authority_guard", table: "migration_domain_authorities", type: 29, fn: "crm_validate_migration_authority_scope" },
      { name: "migration_authority_scope_from_scope_guard", table: "migration_source_scopes", type: 29, fn: "crm_validate_migration_authority_scope" },
      { name: "migration_transition_group_from_group_guard", table: "source_authority_transition_groups", type: 29, fn: "crm_validate_transition_group_completeness" },
      { name: "migration_transition_group_from_transition_guard", table: "source_authority_transitions", type: 29, fn: "crm_validate_transition_group_completeness" },
      { name: "migration_transition_evidence_from_transition_guard", table: "source_authority_transitions", type: 29, fn: "crm_validate_authority_transition_evidence" },
      { name: "migration_transition_evidence_from_batch_guard", table: "import_batches", type: 29, fn: "crm_validate_authority_transition_evidence" },
      { name: "migration_transition_evidence_from_authority_guard", table: "migration_domain_authorities", type: 29, fn: "crm_validate_authority_transition_evidence" },
      { name: "migration_transition_evidence_from_scope_guard", table: "migration_source_scopes", type: 29, fn: "crm_validate_authority_transition_evidence" },
      { name: "migration_live_batch_from_live_guard", table: "import_batches", type: 29, fn: "crm_validate_live_batch_dry_run_lineage" },
      { name: "migration_live_batch_from_dry_guard", table: "import_batches", type: 29, fn: "crm_validate_live_batch_dry_run_lineage" },
      { name: "migration_membership_from_evidence_guard", table: "migration_sources", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_evidence_guard", table: "source_authority_transition_groups", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_evidence_guard", table: "transform_versions", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_evidence_guard", table: "import_batches", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_evidence_guard", table: "legacy_object_links", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_evidence_guard", table: "quarantine_items", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_evidence_guard", table: "reconciliation_runs", type: 21, fn: "crm_validate_migration_actor_scope" },
      { name: "migration_membership_from_membership_guard", table: "memberships", type: 25, fn: "crm_revalidate_migration_membership_evidence" },
      { name: "migration_reconciliation_from_run_guard", table: "reconciliation_runs", type: 29, fn: "crm_validate_reconciliation_signoff" },
      { name: "migration_reconciliation_from_result_guard", table: "reconciliation_results", type: 29, fn: "crm_validate_reconciliation_signoff" },
    ];
    for (const expectedTrigger of deferredTriggers) {
      const matches = triggers.filter(({ tgname, table_name }) =>
        tgname === expectedTrigger.name && table_name === expectedTrigger.table);
      expect(matches, `missing deferred trigger ${expectedTrigger.name} on ${expectedTrigger.table}`)
        .toHaveLength(1);
      expect({
        deferred: matches[0]?.tgdeferrable,
        initiallyDeferred: matches[0]?.tginitdeferred,
        type: matches[0]?.tgtype,
        fn: matches[0]?.function_name,
      }).toEqual({
        deferred: true,
        initiallyDeferred: true,
        type: expectedTrigger.type,
        fn: expectedTrigger.fn,
      });
      expect(matches[0]?.definition).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    }

    const membershipArguments: Record<string, string> = {
      migration_sources: "crm_validate_migration_actor_scope('owner_membership_id', 'BU')",
      source_authority_transition_groups:
        "crm_validate_migration_actor_scope('approved_by_membership_id', 'ORG')",
      transform_versions:
        "crm_validate_migration_actor_scope('approved_by_membership_id', 'BU')",
      import_batches:
        "crm_validate_migration_actor_scope('validated_by_membership_id', 'BU', 'approved_by_membership_id', 'BU', 'applied_by_membership_id', 'BU')",
      legacy_object_links:
        "crm_validate_migration_actor_scope('created_by_membership_id', 'BU')",
      quarantine_items:
        "crm_validate_migration_actor_scope('resolved_by_membership_id', 'BU')",
      reconciliation_runs:
        "crm_validate_migration_actor_scope('signed_by_membership_id', 'BU')",
    };
    for (const [table, argumentSignature] of Object.entries(membershipArguments)) {
      const [trigger] = triggers.filter(({ tgname, table_name }) =>
        tgname === "migration_membership_from_evidence_guard" && table_name === table);
      expect(trigger?.definition).toContain(argumentSignature);
    }
    expect(
      triggers.find(({ tgname }) => tgname === "migration_live_batch_from_live_guard")?.definition,
    ).toContain("crm_validate_live_batch_dry_run_lineage('LIVE')");
    expect(
      triggers.find(({ tgname }) => tgname === "migration_live_batch_from_dry_guard")?.definition,
    ).toContain("crm_validate_live_batch_dry_run_lineage('DRY')");

    expect(
      triggers
        .filter(({ tgname }) => tgname === "migration_membership_from_evidence_guard")
        .map(({ table_name }) => table_name)
        .sort(),
    ).toEqual([
      "import_batches", "legacy_object_links", "migration_sources", "quarantine_items",
      "reconciliation_runs", "source_authority_transition_groups", "transform_versions",
    ]);
    expect(
      triggers
        .filter(({ tgname }) => tgname.startsWith("migration_transition_evidence_from_"))
        .map(({ tgname, table_name }) => `${tgname}:${table_name}`)
        .sort(),
    ).toEqual([
      "migration_transition_evidence_from_authority_guard:migration_domain_authorities",
      "migration_transition_evidence_from_batch_guard:import_batches",
      "migration_transition_evidence_from_scope_guard:migration_source_scopes",
      "migration_transition_evidence_from_transition_guard:source_authority_transitions",
    ]);

    const exactTrigger = (name: string, table: string, type: number, fn: string) => {
      const matches = triggers.filter((trigger) =>
        trigger.tgname === name && trigger.table_name === table);
      expect(matches, `missing trigger ${name} on ${table}`).toHaveLength(1);
      expect({ type: matches[0]?.tgtype, fn: matches[0]?.function_name }).toEqual({ type, fn });
    };
    for (const table of [
      "migration_sources", "migration_source_scopes", "migration_domain_authorities",
      "import_batches", "import_rows", "quarantine_items", "reconciliation_runs",
    ]) {
      exactTrigger(`${table}_touch_version`, table, 19, "crm_touch_version");
    }
    for (const table of [
      "source_authority_transition_groups", "source_authority_transitions", "legacy_object_links",
    ]) {
      exactTrigger(`${table}_append_only`, table, 58, "crm_block_mutation");
    }
    exactTrigger(
      "source_authority_transition_groups_effective_at",
      "source_authority_transition_groups",
      7,
      "crm_set_transition_group_effective_at",
    );
    exactTrigger("import_rows_evidence_guard", "import_rows", 27, "crm_guard_import_row_evidence");
    exactTrigger(
      "migration_domain_authorities_terminal_guard",
      "migration_domain_authorities",
      27,
      "crm_guard_terminal_migration_authority",
    );
    exactTrigger(
      "transform_versions_approved_guard",
      "transform_versions",
      27,
      "crm_guard_approved_transform",
    );
    exactTrigger("import_batches_claim_guard", "import_batches", 27, "crm_guard_import_batch_claim");
    exactTrigger(
      "import_rows_resolved_link_guard",
      "import_rows",
      23,
      "crm_validate_import_row_resolved_link",
    );
    exactTrigger(
      "legacy_object_links_lineage_guard",
      "legacy_object_links",
      7,
      "crm_validate_legacy_link_lineage",
    );
    exactTrigger(
      "reconciliation_runs_requirements_guard",
      "reconciliation_runs",
      23,
      "crm_validate_reconciliation_requirements",
    );
    exactTrigger(
      "reconciliation_runs_mutation_guard",
      "reconciliation_runs",
      27,
      "crm_guard_reconciliation_run",
    );
    exactTrigger(
      "reconciliation_results_signed_guard",
      "reconciliation_results",
      31,
      "crm_guard_signed_reconciliation_result",
    );
    exactTrigger(
      "memberships_guard_user_identity",
      "memberships",
      19,
      "crm_guard_membership_user_identity",
    );

    expect(
      triggers
        .filter(({ tgname }) => tgname === "migration_control_plane_no_truncate")
        .map(({ table_name }) => table_name)
        .sort(),
    ).toEqual([
      "import_batches",
      "import_rows",
      "legacy_object_links",
      "migration_domain_authorities",
      "migration_source_scopes",
      "migration_sources",
      "quarantine_items",
      "reconciliation_results",
      "reconciliation_runs",
      "source_authority_transition_groups",
      "source_authority_transitions",
      "transform_versions",
    ]);
    for (const trigger of triggers.filter(
      ({ tgname }) => tgname === "migration_control_plane_no_truncate",
    )) {
      expect({ type: trigger.tgtype, fn: trigger.function_name }).toEqual({
        type: 34,
        fn: "crm_block_mutation",
      });
    }
  });
});

describe("migration control-plane deferred invariants", () => {
  it("overwrites caller-authored transition effective time with the transaction timestamp", async () => {
    const fixture = await insertSourceAuthority(sql);
    const result = await sql.begin(async (transaction) => {
      const groupId = syntheticId(57);
      await transaction`
        insert into source_authority_transition_groups (
          id, organization_id, idempotency_key, group_size, group_sha256,
          plan_artifact_ref, plan_sha256, effective_at,
          approved_by_membership_id, approval_reason
        ) values (
          ${groupId}, ${ids.organization}, ${`effective-${sequence}`}, 1, ${sha("30")},
          'protected://synthetic/effective-plan', ${sha("31")}, '2000-01-01T00:00:00Z',
          ${ids.membershipOrgWide}, 'Synthetic effective-time proof'
        )
      `;
      await transaction`
        insert into source_authority_transitions (
          id, organization_id, business_unit_id, transition_group_id,
          domain_authority_id, from_source_scope_id, to_source_scope_id,
          from_state, to_state
        ) values (
          ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${groupId},
          ${fixture.authorityId}, ${fixture.scopeId}, ${fixture.scopeId},
          'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
        )
      `;
      const [stored] = await transaction<{
        matches_transaction: boolean;
        ignored_caller_value: boolean;
      }[]>`
        select effective_at = transaction_timestamp() as matches_transaction,
               effective_at <> '2000-01-01T00:00:00Z'::timestamptz as ignored_caller_value
        from source_authority_transition_groups
        where id = ${groupId}
      `;
      return stored;
    });
    expect(result).toEqual({ matches_transaction: true, ignored_caller_value: true });
  });

  it("validates authority/scope coherence and permits atomic canonical archive", async () => {
    await expect(
      sql.begin(async (transaction) => {
        const fixture = await insertSourceAuthority(transaction);
        await transaction`
          update migration_source_scopes
          set canonical_target = 'crm.mismatched'
          where id = ${fixture.scopeId}
        `;
      }),
    ).rejects.toThrow(/authority scope/i);

    const fixture = await insertSourceAuthority(sql);
    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          update migration_source_scopes
          set source_status = 'ARCHIVED_READ_ONLY'
          where id = ${fixture.scopeId}
        `;
      }),
    ).rejects.toThrow(/authority scope/i);

    await sql.begin(async (transaction) => {
      await transaction`
        update migration_domain_authorities
        set authority_state = 'CANONICAL_WRITABLE', authority_source_scope_id = null
        where id = ${fixture.authorityId}
      `;
      await transaction`
        update migration_source_scopes
        set source_status = 'ARCHIVED_READ_ONLY'
        where id = ${fixture.scopeId}
      `;
    });
  });

  it("rejects zero and partial authority transition groups at commit", async () => {
    await expect(
      sql`
        insert into source_authority_transition_groups (
          id, organization_id, idempotency_key, group_size, group_sha256,
          plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
        ) values (
          ${syntheticId(57)}, ${ids.organization}, ${`zero-${sequence}`}, 0, ${sha("31")},
          'protected://synthetic/plan', ${sha("32")}, ${ids.membershipOrgWide}, 'Synthetic plan'
        )
      `,
    ).rejects.toThrow(/size_positive|group size/i);

    const fixture = await insertSourceAuthority(sql);
    await expect(
      sql.begin(async (transaction) => {
        const groupId = syntheticId(57);
        await transaction`
          insert into source_authority_transition_groups (
            id, organization_id, idempotency_key, group_size, group_sha256,
            plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
          ) values (
            ${groupId}, ${ids.organization}, ${`partial-${sequence}`}, 2, ${sha("33")},
            'protected://synthetic/plan', ${sha("34")}, ${ids.membershipOrgWide}, 'Synthetic plan'
          )
        `;
        await transaction`
          insert into source_authority_transitions (
            id, organization_id, business_unit_id, transition_group_id,
            domain_authority_id, from_source_scope_id, to_source_scope_id,
            from_state, to_state
          ) values (
            ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${groupId},
            ${fixture.authorityId}, ${fixture.scopeId}, ${fixture.scopeId},
            'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
          )
        `;
      }),
    ).rejects.toThrow(/transition group/i);
  });

  it("requires exact canonical transition batch, source, head, and timestamp evidence", async () => {
    const positive = await insertSourceAuthority(sql);
    const positiveTransform = await insertTransform(sql, positive.sourceId);
    const positiveBatch = await insertDryRunAndLiveBatch(sql, positive.sourceId, positiveTransform);
    await promoteLiveBatch(sql, positiveBatch.liveBatchId);
    await expect(
      recordCanonicalTransition(positive, positiveBatch.liveBatchId),
    ).resolves.not.toThrow();

    const reversed = await insertSourceAuthority(sql);
    const reversedTransform = await insertTransform(sql, reversed.sourceId);
    const reversedBatch = await insertDryRunAndLiveBatch(sql, reversed.sourceId, reversedTransform);
    await promoteLiveBatch(sql, reversedBatch.liveBatchId);
    await expect(
      recordCanonicalTransition(reversed, reversedBatch.liveBatchId, {
        writeFrozenOffsetSeconds: 1,
      }),
    ).rejects.toThrow(/authority transition evidence/i);

    const appliedOnly = await insertSourceAuthority(sql);
    const appliedTransform = await insertTransform(sql, appliedOnly.sourceId);
    const appliedBatch = await insertDryRunAndLiveBatch(sql, appliedOnly.sourceId, appliedTransform);
    await promoteLiveBatch(sql, appliedBatch.liveBatchId, "APPLIED");
    await expect(
      recordCanonicalTransition(appliedOnly, appliedBatch.liveBatchId),
    ).rejects.toThrow(/authority transition evidence/i);

    const sourceAuthority = await insertSourceAuthority(sql);
    const otherSource = await insertSourceAuthority(sql);
    const otherTransform = await insertTransform(sql, otherSource.sourceId);
    const otherBatch = await insertDryRunAndLiveBatch(sql, otherSource.sourceId, otherTransform);
    await promoteLiveBatch(sql, otherBatch.liveBatchId);
    await expect(
      recordCanonicalTransition(sourceAuthority, otherBatch.liveBatchId),
    ).rejects.toThrow(/authority transition evidence/i);

    const futureCutoff = await insertSourceAuthority(sql);
    const futureTransform = await insertTransform(sql, futureCutoff.sourceId);
    const futureBatch = await insertDryRunAndLiveBatch(sql, futureCutoff.sourceId, futureTransform);
    await sql`
      update import_batches
      set cutoff_at = transaction_timestamp() + interval '1 day',
          captured_at = transaction_timestamp() + interval '1 day'
      where id = ${futureBatch.liveBatchId}
    `;
    await promoteLiveBatch(sql, futureBatch.liveBatchId);
    await expect(
      recordCanonicalTransition(futureCutoff, futureBatch.liveBatchId),
    ).rejects.toThrow(/authority transition evidence/i);

    const unchangedHead = await insertSourceAuthority(sql);
    const unchangedTransform = await insertTransform(sql, unchangedHead.sourceId);
    const unchangedBatch = await insertDryRunAndLiveBatch(sql, unchangedHead.sourceId, unchangedTransform);
    await promoteLiveBatch(sql, unchangedBatch.liveBatchId);
    await expect(
      recordCanonicalTransition(unchangedHead, unchangedBatch.liveBatchId, { updateHead: false }),
    ).rejects.toThrow(/authority transition evidence/i);
  });

  it("enforces BU actor scope, organisation-wide approval, and membership revalidation", async () => {
    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          insert into migration_sources (
            id, organization_id, business_unit_id, source_key, source_kind, source_mode,
            owner_membership_id, status
          ) values (
            ${syntheticId(51)}, ${ids.organization}, ${ids.businessUnit}, ${`wrong-owner-${sequence}`},
            'NIAGAWAN_CSV', 'ONE_TIME_MIGRATION', ${ids.membershipOtherBusinessUnit}, 'ACTIVE'
          )
        `;
      }),
    ).rejects.toThrow(/membership scope/i);

    const fixture = await insertSourceAuthority(sql);
    await expect(
      sql.begin(async (transaction) => {
        const groupId = syntheticId(57);
        await transaction`
          insert into source_authority_transition_groups (
            id, organization_id, idempotency_key, group_size, group_sha256,
            plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
          ) values (
            ${groupId}, ${ids.organization}, ${`bu-approver-${sequence}`}, 1, ${sha("35")},
            'protected://synthetic/plan', ${sha("36")}, ${ids.membershipBusinessUnit}, 'Synthetic plan'
          )
        `;
        await transaction`
          insert into source_authority_transitions (
            id, organization_id, business_unit_id, transition_group_id,
            domain_authority_id, from_source_scope_id, to_source_scope_id,
            from_state, to_state
          ) values (
            ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${groupId},
            ${fixture.authorityId}, ${fixture.scopeId}, ${fixture.scopeId},
            'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
          )
        `;
      }),
    ).rejects.toThrow(/organisation-wide membership/i);

    await insertSourceAuthority(sql, { ownerMembershipId: ids.membershipReassignable });
    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          update memberships
          set business_unit_id = ${ids.businessUnitTwo}
          where id = ${ids.membershipReassignable}
        `;
      }),
    ).rejects.toThrow(/membership scope/i);
  });

  it("keeps the person behind every membership identity immutable", async () => {
    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          update memberships
          set user_id = ${ids.userOrgWide}
          where id = ${ids.membershipReassignable}
        `;
        throw new Error("membership identity guard did not reject reassignment");
      }),
    ).rejects.toThrow(/membership user identity.*immutable/i);
  });

  it("enforces final live-to-dry-run lineage from both sides", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const batch = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);

    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          update import_batches
          set status = 'FAILED', failure_code = 'SYNTHETIC_FAILURE'
          where id = ${batch.dryRunId}
        `;
      }),
    ).rejects.toThrow(/dry-run lineage/i);

    const otherTransformId = syntheticId(54);
    await sql`
      insert into transform_versions (
        id, organization_id, business_unit_id, migration_source_id, version_no,
        source_schema_version, mapping_artifact_ref, mapping_sha256,
        release_manifest_ref, release_manifest_sha256, transform_release_sha256,
        rationale, approved_by_membership_id, approved_at
      ) values (
        ${otherTransformId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, 2,
        'synthetic.v2', 'protected://synthetic/mapping-two', ${sha("41")},
        'protected://synthetic/release-two', ${sha("42")}, ${sha("43")},
        'Synthetic second transform', ${ids.membershipBusinessUnit}, clock_timestamp()
      )
    `;
    await expect(
      sql`
        insert into import_batches (
          id, organization_id, business_unit_id, migration_source_id, transform_version_id,
          validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
          captured_at, cutoff_at, schema_version, status, dry_run
        ) values (
          ${syntheticId(56)}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${otherTransformId},
          ${batch.dryRunId}, 'protected://synthetic/mismatch', ${batch.checksum}, 1,
          transaction_timestamp(), transaction_timestamp(), 'synthetic.v2', 'REGISTERED', false
        )
      `,
    ).rejects.toThrow();
  });

  it("makes canonical authority terminal and approved transforms immutable", async () => {
    const fixture = await insertSourceAuthority(sql, { authorityState: "CANONICAL_WRITABLE" });
    await expect(
      sql`
        update migration_domain_authorities
        set authority_state = 'EXTERNAL_SYSTEM_AUTHORITY', authority_source_scope_id = ${fixture.scopeId}
        where id = ${fixture.authorityId}
      `,
    ).rejects.toThrow(/canonical.*terminal/i);

    const transformId = await insertTransform(sql, fixture.sourceId);
    await expect(
      sql`
        update transform_versions
        set mapping_artifact_ref = 'protected://synthetic/changed'
        where id = ${transformId}
      `,
    ).rejects.toThrow(/approved transform/i);
  });

  it("keeps every authority head durable and freezes its domain identity", async () => {
    const fixture = await insertSourceAuthority(sql);
    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          update migration_domain_authorities
          set domain_key = 'synthetic.renamed'
          where id = ${fixture.authorityId}
        `;
        await transaction`
          update migration_source_scopes
          set domain_key = 'synthetic.renamed'
          where id = ${fixture.scopeId}
        `;
      }),
    ).rejects.toThrow(/durable|identity/i);
    await expect(
      sql`delete from migration_domain_authorities where id = ${fixture.authorityId}`,
    ).rejects.toThrow(/durable/i);
  });

  it("requires exact reconciliation tuples before sign-off and freezes signed evidence", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const runId = syntheticId(59);
    const requiredChecks = [
      {
        check_kind: "COUNT",
        check_key: "records.total",
        scope_key: "all",
        measure_unit: null,
        decimal_scale: null,
      },
    ];

    await sql`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) values (
        ${runId}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 1, 'PENDING',
        'protected://synthetic/reconciliation-plan', ${sha("51")}, ${sql.json(requiredChecks)},
        digest(convert_to(${sql.json(requiredChecks)}::jsonb::text, 'UTF8'), 'sha256'), 1
      )
    `;

    await expect(
      sql.begin(async (transaction) => {
        await transaction`
          update reconciliation_runs
          set status = 'SIGNED', signed_by_membership_id = ${ids.membershipOrgWide},
              signed_at = clock_timestamp(), passed_check_count = 1
          where id = ${runId}
        `;
      }),
    ).rejects.toThrow(/reconciliation sign-off/i);

    await sql.begin(async (transaction) => {
      await transaction`
        insert into reconciliation_results (
          id, organization_id, business_unit_id, run_id, check_kind, check_key,
          scope_key, source_count, target_count, passed, evidence_metadata
        ) values (
          ${syntheticId(60)}, ${ids.organization}, ${ids.businessUnit}, ${runId}, 'COUNT',
          'records.total', 'all', 1, 1, true, '{}'::jsonb
        )
      `;
      await transaction`
        update reconciliation_runs
        set status = 'SIGNED', signed_by_membership_id = ${ids.membershipOrgWide},
            signed_at = clock_timestamp(), passed_check_count = 1
        where id = ${runId}
      `;
    });

    await expect(
      sql`update reconciliation_results set target_count = 2 where run_id = ${runId}`,
    ).rejects.toThrow(/signed reconciliation/i);
    await expect(
      sql`update reconciliation_runs set plan_artifact_ref = 'protected://changed' where id = ${runId}`,
    ).rejects.toThrow(/reconciliation plan/i);
  });

  it.each([
    { sourceCount: 1, targetCount: 2, passed: true },
    { sourceCount: 1, targetCount: 1, passed: false },
  ])(
    "derives COUNT truth in the database for $sourceCount versus $targetCount",
    async ({ sourceCount, targetCount, passed }) => {
      const fixture = await insertSourceAuthority(sql);
      const transformId = await insertTransform(sql, fixture.sourceId);
      const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
      const runId = await insertPendingCountReconciliation(sql, liveBatchId);

      await expect(sql`
        insert into reconciliation_results (
          id, organization_id, business_unit_id, run_id, check_kind, check_key,
          scope_key, source_count, target_count, passed, evidence_metadata
        ) values (
          ${syntheticId(60)}, ${ids.organization}, ${ids.businessUnit}, ${runId}, 'COUNT',
          'records.total', 'all', ${sourceCount}, ${targetCount}, ${passed}, '{}'::jsonb
        )
      `).rejects.toThrow(/derived.pass.truth/i);
    },
  );

  it("enforces reconciliation requirement order by UTF-8 bytes instead of database locale", async () => {
    const [guard] = await sql<{ definition: string }[]>`
      select pg_get_functiondef(
        'crm_validate_reconciliation_requirements()'::regprocedure
      ) as definition
    `;
    expect(guard?.definition.match(/COLLATE "C"/g)).toHaveLength(4);

    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const bytewiseRequirements = [
      {
        check_kind: "COUNT",
        check_key: "a.a",
        scope_key: "all",
        measure_unit: null,
        decimal_scale: null,
      },
      {
        check_kind: "COUNT",
        check_key: "a_",
        scope_key: "all",
        measure_unit: null,
        decimal_scale: null,
      },
    ];

    await expect(sql`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) values (
        ${syntheticId(59)}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 1, 'PENDING',
        'protected://synthetic/bytewise-plan', ${sha("79")}, ${sql.json(bytewiseRequirements)},
        digest(convert_to(${sql.json(bytewiseRequirements)}::jsonb::text, 'UTF8'), 'sha256'), 2
      )
    `).resolves.toHaveLength(0);

    const localeOrderedRequirements = [...bytewiseRequirements].reverse();
    await expect(sql`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) values (
        ${syntheticId(59)}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 2, 'PENDING',
        'protected://synthetic/locale-plan', ${sha("80")}, ${sql.json(localeOrderedRequirements)},
        digest(convert_to(${sql.json(localeOrderedRequirements)}::jsonb::text, 'UTF8'), 'sha256'), 2
      )
    `).rejects.toThrow(/canonical bytewise order/i);
  });

  it("keeps reconciliation results bound to their original parent run", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const firstRunId = await insertPendingCountReconciliation(sql, liveBatchId);
    const secondRunId = syntheticId(59);
    const requiredChecks = [
      {
        check_kind: "COUNT",
        check_key: "records.total",
        scope_key: "all",
        measure_unit: null,
        decimal_scale: null,
      },
    ];
    await sql`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) values (
        ${secondRunId}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 2, 'PENDING',
        'protected://synthetic/second-plan', ${sha("76")}, ${sql.json(requiredChecks)},
        digest(convert_to(${sql.json(requiredChecks)}::jsonb::text, 'UTF8'), 'sha256'), 1
      )
    `;
    const resultId = syntheticId(60);
    await sql`
      insert into reconciliation_results (
        id, organization_id, business_unit_id, run_id, check_kind, check_key,
        scope_key, source_count, target_count, passed, evidence_metadata
      ) values (
        ${resultId}, ${ids.organization}, ${ids.businessUnit}, ${firstRunId}, 'COUNT',
        'records.total', 'all', 1, 1, true, '{}'::jsonb
      )
    `;
    await expect(
      sql`update reconciliation_results set run_id = ${secondRunId} where id = ${resultId}`,
    ).rejects.toThrow(/parent.*immutable|parent run/i);
  });

  it("rejects non-string reconciliation identity scalars", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const malformedRequirements = [
      {
        check_kind: "COUNT",
        check_key: true,
        scope_key: "all",
        measure_unit: null,
        decimal_scale: null,
      },
    ];
    await expect(sql`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) values (
        ${syntheticId(59)}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 1, 'PENDING',
        'protected://synthetic/malformed-plan', ${sha("71")}, ${sql.json(malformedRequirements)},
        digest(convert_to(${sql.json(malformedRequirements)}::jsonb::text, 'UTF8'), 'sha256'), 1
      )
    `).rejects.toThrow(/scalar|string|canonical fields/i);
  });

  it("normalizes decimal scales when rejecting duplicate reconciliation tuples", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(sql`
      with protected_set as (
        select jsonb_build_array(
          jsonb_build_object(
            'check_kind', 'AMOUNT', 'check_key', 'records.amount', 'scope_key', 'all',
            'measure_unit', 'MYR', 'decimal_scale', 1::numeric
          ),
          jsonb_build_object(
            'check_kind', 'AMOUNT', 'check_key', 'records.amount', 'scope_key', 'all',
            'measure_unit', 'MYR', 'decimal_scale', 1.0::numeric
          )
        ) as checks
      )
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) select
        ${syntheticId(59)}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 1, 'PENDING',
        'protected://synthetic/duplicate-plan', ${sha("74")}, checks,
        digest(convert_to(checks::text, 'UTF8'), 'sha256'), 2
      from protected_set
    `).rejects.toThrow(/duplicate tuple/i);
  });

  it.each(["AMOUNT", "FINANCE_BALANCE"])(
    "rejects a %s requirement with a null measure unit",
    async (checkKind) => {
      const fixture = await insertSourceAuthority(sql);
      const transformId = await insertTransform(sql, fixture.sourceId);
      const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
      const invalidRequirements = [
        {
          check_kind: checkKind,
          check_key: "records.amount",
          scope_key: "all",
          measure_unit: null,
          decimal_scale: 2,
        },
      ];
      await expect(sql`
        insert into reconciliation_runs (
          id, organization_id, business_unit_id, batch_id, run_no, status,
          plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
          required_check_count
        ) values (
          ${syntheticId(59)}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 1, 'PENDING',
          'protected://synthetic/null-unit-plan', ${sha("77")}, ${sql.json(invalidRequirements)},
          digest(convert_to(${sql.json(invalidRequirements)}::jsonb::text, 'UTF8'), 'sha256'), 1
        )
      `).rejects.toThrow(/unit and decimal scale/i);
    },
  );

  it("uses the result scope-key grammar for protected reconciliation requirements", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const invalidRequirements = [
      {
        check_kind: "COUNT",
        check_key: "records.total",
        scope_key: "invalid scope key",
        measure_unit: null,
        decimal_scale: null,
      },
    ];
    await expect(sql`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count
      ) values (
        ${syntheticId(59)}, ${ids.organization}, ${ids.businessUnit}, ${liveBatchId}, 1, 'PENDING',
        'protected://synthetic/invalid-scope-plan', ${sha("75")}, ${sql.json(invalidRequirements)},
        digest(convert_to(${sql.json(invalidRequirements)}::jsonb::text, 'UTF8'), 'sha256'), 1
      )
    `).rejects.toThrow(/requirement identity/i);
  });

  it("rejects approval evidence with a missing reason", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);

    await expect(sql`
      update import_batches
      set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp(), approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = clock_timestamp(), approval_reason = null
      where id = ${liveBatchId}
    `).rejects.toThrow(/approval/i);
  });

  it("rejects repair batches with a missing operator reason", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const repairDryRunId = syntheticId(55);
    const repairChecksum = sha("22");
    await sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
        schema_version, status, dry_run, validated_by_membership_id, validated_at
      ) values (
        ${repairDryRunId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${transformId},
        'protected://synthetic/repair-dry', ${repairChecksum}, 1,
        transaction_timestamp(), transaction_timestamp(), 'synthetic.v1',
        'DRY_RUN_COMPLETE', true, ${ids.membershipBusinessUnit}, clock_timestamp()
      )
    `;

    await expect(sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        validated_dry_run_batch_id, repair_of_batch_id, protected_artifact_ref,
        source_sha256, size_bytes, captured_at, cutoff_at, schema_version, status, dry_run,
        operator_reason
      ) values (
        ${syntheticId(56)}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${transformId},
        ${repairDryRunId}, ${liveBatchId}, 'protected://synthetic/repair-live',
        ${repairChecksum}, 1, transaction_timestamp(), transaction_timestamp(),
        'synthetic.v1', 'REGISTERED', false, null
      )
    `).rejects.toThrow(/repair.*reason|repair_reason/i);
  });

  it("rejects hidden or quarantined rows in a completed dry run", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    await expect(sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
        schema_version, status, dry_run, total_row_count, hidden_row_count,
        validated_by_membership_id, validated_at
      ) values (
        ${syntheticId(55)}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${transformId},
        'protected://synthetic/unsafe-dry', ${sha("23")}, 1,
        transaction_timestamp(), transaction_timestamp(), 'synthetic.v1',
        'DRY_RUN_COMPLETE', true, 1, 1, ${ids.membershipBusinessUnit}, clock_timestamp()
      )
    `).rejects.toThrow(/lifecycle/i);
  });

  it("forbids live batches from using the dry-run terminal state", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(sql`
      update import_batches
      set status = 'DRY_RUN_COMPLETE',
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp()
      where id = ${liveBatchId}
    `).rejects.toThrow(/lifecycle/i);
  });

  it("requires validation to precede approval", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(sql`
      update import_batches
      set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = '2026-01-02T00:00:00Z', approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = '2026-01-01T00:00:00Z', approval_reason = 'Synthetic approval'
      where id = ${liveBatchId}
    `).rejects.toThrow(/approval|validation/i);
  });

  it("allows an owned apply chunk to move valid rows into imported rows", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await sql`
      update import_batches
      set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp(), approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = clock_timestamp(), approval_reason = 'Synthetic approval'
      where id = ${liveBatchId}
    `;
    await sql`
      update import_batches
      set status = 'APPLYING', applied_by_membership_id = ${ids.membershipBusinessUnit},
          apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
          apply_lease_expires_at = transaction_timestamp() - interval '1 minute'
      where id = ${liveBatchId}
    `;
    await expect(sql`
      update import_batches
      set status = 'APPLIED', valid_row_count = 0, imported_row_count = 1,
          applied_at = clock_timestamp()
      where id = ${liveBatchId}
    `).resolves.not.toThrow();
  });

  it("rejects post-claim counter inflation and lifecycle skips", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await sql`
      update import_batches
      set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp(), approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = clock_timestamp(), approval_reason = 'Synthetic approval'
      where id = ${liveBatchId}
    `;
    await sql`
      update import_batches
      set status = 'APPLYING', applied_by_membership_id = ${ids.membershipBusinessUnit},
          apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
          apply_lease_expires_at = transaction_timestamp() + interval '1 minute'
      where id = ${liveBatchId}
    `;

    await expect(sql`
      update import_batches
      set total_row_count = 2, valid_row_count = 0,
          imported_row_count = 2, approved_row_count = 2
      where id = ${liveBatchId}
    `).rejects.toThrow(/claimed import batch|counter/i);

    await expect(sql`
      update import_batches
      set status = 'RECONCILED', valid_row_count = 0, imported_row_count = 1,
          applied_at = clock_timestamp()
      where id = ${liveBatchId}
    `).rejects.toThrow(/status transition|claimed import batch/i);
  });

  it("freezes the approved envelope at first claim and prevents lease regression", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await sql`
      update import_batches
      set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp(), approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = clock_timestamp(), approval_reason = 'Synthetic approval'
      where id = ${liveBatchId}
    `;

    await expect(sql`
      update import_batches
      set status = 'APPLYING', valid_row_count = 0, imported_row_count = 1,
          applied_by_membership_id = ${ids.membershipBusinessUnit},
          apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
          apply_lease_expires_at = transaction_timestamp() + interval '1 minute'
      where id = ${liveBatchId}
    `).rejects.toThrow(/initial claim.*envelope|initial claim.*counter/i);

    await sql`
      update import_batches
      set status = 'APPLYING', applied_by_membership_id = ${ids.membershipBusinessUnit},
          apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
          apply_lease_expires_at = transaction_timestamp() + interval '1 minute'
      where id = ${liveBatchId}
    `;
    await expect(sql`
      update import_batches
      set apply_lease_expires_at = apply_lease_expires_at - interval '1 second'
      where id = ${liveBatchId}
    `).rejects.toThrow(/lease.*regress/i);
    await expect(sql`
      update import_batches
      set apply_lease_expires_at = apply_lease_expires_at + interval '1 minute'
      where id = ${liveBatchId}
    `).resolves.not.toThrow();

    await sql`
      update import_batches
      set status = 'APPLIED', valid_row_count = 0, imported_row_count = 1,
          applied_at = clock_timestamp()
      where id = ${liveBatchId}
    `;
    await expect(sql`
      update import_batches
      set apply_lease_expires_at = apply_lease_expires_at + interval '1 minute'
      where id = ${liveBatchId}
    `).rejects.toThrow(/lease.*immutable/i);
  });

  it("requires APPROVED to APPLYING for first claim and keeps pre-claim failure terminal", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(sql`
      update import_batches
      set status = 'APPLIED', total_row_count = 1, imported_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp(), approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = clock_timestamp(), approval_reason = 'Synthetic skipped claim',
          applied_by_membership_id = ${ids.membershipBusinessUnit},
          apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
          apply_lease_expires_at = transaction_timestamp() + interval '1 minute',
          applied_at = clock_timestamp()
      where id = ${liveBatchId}
    `).rejects.toThrow(/initial claim|APPROVED.*APPLYING/i);

    await sql`
      update import_batches set status = 'FAILED', failure_code = 'SYNTHETIC_FAILURE'
      where id = ${liveBatchId}
    `;
    await expect(sql`
      update import_batches set failure_code = 'CHANGED_FAILURE' where id = ${liveBatchId}
    `).rejects.toThrow(/terminal.*batch/i);
  });

  it("retains claimed batches and pre-claim failure evidence", async () => {
    const claimedFixture = await insertSourceAuthority(sql);
    const claimedTransformId = await insertTransform(sql, claimedFixture.sourceId);
    const claimedBatch = await insertDryRunAndLiveBatch(
      sql,
      claimedFixture.sourceId,
      claimedTransformId,
    );
    await sql`
      update import_batches
      set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
          validated_by_membership_id = ${ids.membershipBusinessUnit},
          validated_at = clock_timestamp(), approval_mode = 'FULL',
          approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
          approved_at = clock_timestamp(), approval_reason = 'Synthetic retained claim'
      where id = ${claimedBatch.liveBatchId}
    `;
    await sql`
      update import_batches
      set status = 'APPLYING', applied_by_membership_id = ${ids.membershipBusinessUnit},
          apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
          apply_lease_expires_at = transaction_timestamp() + interval '1 minute'
      where id = ${claimedBatch.liveBatchId}
    `;
    await expect(
      sql`delete from import_batches where id = ${claimedBatch.liveBatchId}`,
    ).rejects.toThrow(/claimed import batch.*deleted|retained/i);

    const failedFixture = await insertSourceAuthority(sql);
    const failedTransformId = await insertTransform(sql, failedFixture.sourceId);
    const failedBatch = await insertDryRunAndLiveBatch(
      sql,
      failedFixture.sourceId,
      failedTransformId,
    );
    await sql`
      update import_batches
      set status = 'FAILED', failure_code = 'SYNTHETIC_PRECLAIM_FAILURE'
      where id = ${failedBatch.liveBatchId}
    `;
    await expect(
      sql`delete from import_batches where id = ${failedBatch.liveBatchId}`,
    ).rejects.toThrow(/terminal failed.*immutable|failure evidence/i);
  });

  it.each([31, 33])("rejects a %s-byte source SHA-256", async (byteLength) => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    await expect(sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
        schema_version, status, dry_run
      ) values (
        ${syntheticId(55)}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${transformId},
        'protected://synthetic/bad-sha', ${Buffer.alloc(byteLength)}, 1,
        transaction_timestamp(), transaction_timestamp(), 'synthetic.v1', 'REGISTERED', true
      )
    `).rejects.toThrow(/source_sha256_valid|source sha/i);
  });

  it("requires normalized evidence reference and digest as an exact pair", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(
      insertImportRow(sql, liveBatchId, {
        normalizedEvidenceRef: "protected://synthetic/normalized-only",
      }),
    ).rejects.toThrow(/normalized/i);
  });

  it("requires explicit error codes for rejected rows", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(
      insertImportRow(sql, liveBatchId, { outcome: "REJECTED", errorCode: null }),
    ).rejects.toThrow(/error/i);
  });

  it("requires an explicit correction reason for legacy link repairs", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const rowId = await insertImportRow(sql, liveBatchId, { sourceRowKey: `row-${sequence}` });
    const sourceRowKey = `row-${sequence - 1}`;
    const firstLinkId = syntheticId(63);
    await sql`
      insert into legacy_object_links (
        id, organization_id, business_unit_id, migration_source_id, import_row_id,
        source_object_type, source_row_key, link_version, destination_entity_type,
        destination_entity_id, created_by_membership_id
      ) values (
        ${firstLinkId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${rowId},
        'synthetic.record', ${sourceRowKey}, 1, 'crm.synthetic', ${syntheticId(64)},
        ${ids.membershipBusinessUnit}
      )
    `;
    await expect(sql`
      insert into legacy_object_links (
        id, organization_id, business_unit_id, migration_source_id, import_row_id,
        source_object_type, source_row_key, link_version, supersedes_link_id,
        destination_entity_type, destination_entity_id, correction_reason,
        created_by_membership_id
      ) values (
        ${syntheticId(63)}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${rowId},
        'synthetic.record', ${sourceRowKey}, 2, ${firstLinkId},
        'crm.synthetic', ${syntheticId(64)}, null, ${ids.membershipBusinessUnit}
      )
    `).rejects.toThrow(/correction|lineage_shape/i);
  });

  it("binds every legacy link to its import row source identity", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const rowId = await insertImportRow(sql, liveBatchId, { sourceRowKey: `row-${sequence}` });
    await expect(sql`
      insert into legacy_object_links (
        id, organization_id, business_unit_id, migration_source_id, import_row_id,
        source_object_type, source_row_key, link_version, destination_entity_type,
        destination_entity_id, created_by_membership_id
      ) values (
        ${syntheticId(63)}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${rowId},
        'synthetic.record', ${`different-${sequence}`}, 1, 'crm.synthetic', ${syntheticId(64)},
        ${ids.membershipBusinessUnit}
      )
    `).rejects.toThrow(/import row source identity/i);
  });

  it("retains linked import-row source evidence and keeps the link identity consistent", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const sourceRowKey = `row-${sequence}`;
    const rowId = await insertImportRow(sql, liveBatchId, { sourceRowKey });
    const linkId = syntheticId(63);
    await sql`
      insert into legacy_object_links (
        id, organization_id, business_unit_id, migration_source_id, import_row_id,
        source_object_type, source_row_key, link_version, destination_entity_type,
        destination_entity_id, created_by_membership_id
      ) values (
        ${linkId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${rowId},
        'synthetic.record', ${sourceRowKey}, 1, 'crm.synthetic', ${syntheticId(64)},
        ${ids.membershipBusinessUnit}
      )
    `;

    await expect(sql`
      update import_rows
      set source_row_key = ${`mutated-${sequence}`},
          raw_evidence_ref = 'protected://synthetic/mutated-raw'
      where id = ${rowId}
    `).rejects.toThrow(/import row.*evidence|source identity/i);
    await expect(sql`delete from import_rows where id = ${rowId}`).rejects.toThrow(
      /import row.*retained|durable/i,
    );

    const [identity] = await sql<{
      row_key: string;
      link_key: string;
      row_type: string;
      link_type: string;
    }[]>`
      select import_row.source_row_key as row_key, link.source_row_key as link_key,
             import_row.source_object_type as row_type, link.source_object_type as link_type
      from import_rows import_row
      join legacy_object_links link on link.import_row_id = import_row.id
      where import_row.id = ${rowId} and link.id = ${linkId}
    `;
    expect(identity).toEqual({
      row_key: sourceRowKey,
      link_key: sourceRowKey,
      row_type: "synthetic.record",
      link_type: "synthetic.record",
    });
  });

  it("allows a distinct replay row to resolve to the prior link for the same source identity", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const firstBatch = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const sourceRowKey = `replay-${sequence}`;
    const originalRowId = await insertImportRow(sql, firstBatch.liveBatchId, { sourceRowKey });
    const linkId = syntheticId(63);
    await sql`
      insert into legacy_object_links (
        id, organization_id, business_unit_id, migration_source_id, import_row_id,
        source_object_type, source_row_key, link_version, destination_entity_type,
        destination_entity_id, created_by_membership_id
      ) values (
        ${linkId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${originalRowId},
        'synthetic.record', ${sourceRowKey}, 1, 'crm.synthetic', ${syntheticId(64)},
        ${ids.membershipBusinessUnit}
      )
    `;
    await sql`
      update import_rows
      set outcome = 'IMPORTED', resolved_link_id = ${linkId}
      where id = ${originalRowId}
    `;

    const repairDryRunId = syntheticId(55);
    const repairBatchId = syntheticId(56);
    const repairChecksum = sha("22");
    await sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
        schema_version, status, dry_run, total_row_count, valid_row_count,
        validated_by_membership_id, validated_at
      ) values (
        ${repairDryRunId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${transformId},
        'protected://synthetic/repair-dry-run', ${repairChecksum}, 1,
        transaction_timestamp(), transaction_timestamp(), 'synthetic.v1',
        'DRY_RUN_COMPLETE', true, 1, 1, ${ids.membershipBusinessUnit}, clock_timestamp()
      )
    `;
    await sql`
      insert into import_batches (
        id, organization_id, business_unit_id, migration_source_id, transform_version_id,
        validated_dry_run_batch_id, repair_of_batch_id, protected_artifact_ref, source_sha256,
        size_bytes, captured_at, cutoff_at, schema_version, status, dry_run, operator_reason
      ) values (
        ${repairBatchId}, ${ids.organization}, ${ids.businessUnit}, ${fixture.sourceId}, ${transformId},
        ${repairDryRunId}, ${firstBatch.liveBatchId}, 'protected://synthetic/repair-live',
        ${repairChecksum}, 1, transaction_timestamp(), transaction_timestamp(),
        'synthetic.v1', 'REGISTERED', false, 'Synthetic replay verification'
      )
    `;
    const mismatchedReplayRowId = await insertImportRow(sql, repairBatchId, {
      sourceRowKey: `different-${sequence}`,
    });
    await expect(sql`
      update import_rows
      set outcome = 'NO_OP_REPLAY', resolved_link_id = ${linkId}
      where id = ${mismatchedReplayRowId}
    `).rejects.toThrow(/resolved link.*source identity/i);
    const replayRowId = await insertImportRow(sql, repairBatchId, { sourceRowKey });

    await expect(sql`
      update import_rows set outcome = 'NO_OP_REPLAY' where id = ${replayRowId}
    `).rejects.toThrow(/resolution_link_consistent|resolved link/i);
    await expect(sql`
      update import_rows
      set outcome = 'NO_OP_REPLAY', resolved_link_id = ${linkId}
      where id = ${replayRowId}
    `).resolves.not.toThrow();
    const [resolution] = await sql<{ resolved_link_id: string; link_count: string }[]>`
      select import_row.resolved_link_id,
             (select count(*)::text from legacy_object_links link
               where link.migration_source_id = ${fixture.sourceId}
                 and link.source_object_type = 'synthetic.record'
                 and link.source_row_key = ${sourceRowKey}) as link_count
      from import_rows import_row
      where import_row.id = ${replayRowId}
    `;
    expect(resolution).toEqual({ resolved_link_id: linkId, link_count: "1" });
  });

  it("requires an explicit quarantine resolution reason", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const rowId = await insertImportRow(sql, liveBatchId);
    await expect(sql`
      insert into quarantine_items (
        id, organization_id, business_unit_id, import_row_id, reason_code,
        status, resolution, resolved_by_membership_id, resolved_at, resolution_reason
      ) values (
        ${syntheticId(65)}, ${ids.organization}, ${ids.businessUnit}, ${rowId}, 'SYNTHETIC_REVIEW',
        'RESOLVED', 'APPROVE_ROW', ${ids.membershipBusinessUnit}, clock_timestamp(), null
      )
    `).rejects.toThrow(/resolution/i);
  });

  it("requires measure units for amount reconciliation results", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    const runId = await insertPendingCountReconciliation(sql, liveBatchId);
    await expect(sql`
      insert into reconciliation_results (
        id, organization_id, business_unit_id, run_id, check_kind, check_key,
        scope_key, source_amount, target_amount, measure_unit, decimal_scale,
        passed, evidence_metadata
      ) values (
        ${syntheticId(60)}, ${ids.organization}, ${ids.businessUnit}, ${runId}, 'AMOUNT',
        'records.amount', 'all', 1, 1, null, 2, true, '{}'::jsonb
      )
    `).rejects.toThrow(/kind_values|measure/i);
  });

  it("rejects malformed source-row and reconciliation scope keys", async () => {
    const fixture = await insertSourceAuthority(sql);
    const transformId = await insertTransform(sql, fixture.sourceId);
    const { liveBatchId } = await insertDryRunAndLiveBatch(sql, fixture.sourceId, transformId);
    await expect(
      insertImportRow(sql, liveBatchId, { sourceRowKey: "invalid row key" }),
    ).rejects.toThrow(/source_key.*format|source row key/i);

    const runId = await insertPendingCountReconciliation(sql, liveBatchId);
    await expect(sql`
      insert into reconciliation_results (
        id, organization_id, business_unit_id, run_id, check_kind, check_key,
        scope_key, source_count, target_count, passed, evidence_metadata
      ) values (
        ${syntheticId(60)}, ${ids.organization}, ${ids.businessUnit}, ${runId}, 'COUNT',
        'records.total', 'invalid scope key', 1, 1, true, '{}'::jsonb
      )
    `).rejects.toThrow(/scope_key.*format|scope key/i);
  });

  it("blocks truncate and cascade bypasses across the control plane", async () => {
    await expect(
      sql.begin(async (transaction) => {
        await transaction.unsafe(
          "truncate reconciliation_runs, reconciliation_results",
        );
        throw new Error("truncate bypassed control-plane guards");
      }),
    ).rejects.toThrow(/append-only|cannot be truncated/i);
  });

  it("serializes every mutable parent against concurrent migration evidence", async () => {
    const parent = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
    const evidence = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });

    const startLockCase = async (statement: string, value: string) => {
      await parent.unsafe("begin");
      await parent.unsafe(statement, [value]);
      await evidence.unsafe("begin");
      await evidence.unsafe("set local lock_timeout = '200ms'");
    };
    const rollbackCase = async () => {
      await evidence.unsafe("rollback").catch(() => undefined);
      await parent.unsafe("rollback").catch(() => undefined);
    };
    const expectDeferredLockTimeout = async () => {
      await expect(evidence.unsafe("set constraints all immediate")).rejects.toMatchObject({
        code: "55P03",
      });
      await rollbackCase();
    };

    try {
      const authorityFixture = await insertSourceAuthority(sql);
      await startLockCase(
        "select id from migration_source_scopes where id = $1 for no key update",
        authorityFixture.scopeId,
      );
      await evidence`
        update migration_domain_authorities
        set authority_state = 'SHADOW_READ'
        where id = ${authorityFixture.authorityId}
      `;
      await expectDeferredLockTimeout();

      const membershipSourceId = syntheticId(51);
      await startLockCase(
        "select id from memberships where id = $1 for no key update",
        ids.membershipBusinessUnit,
      );
      await evidence`
        insert into migration_sources (
          id, organization_id, business_unit_id, source_key, source_kind, source_mode,
          owner_membership_id, status
        ) values (
          ${membershipSourceId}, ${ids.organization}, ${ids.businessUnit},
          ${`locked-membership-${sequence}`}, 'NIAGAWAN_CSV', 'ONE_TIME_MIGRATION',
          ${ids.membershipBusinessUnit}, 'ACTIVE'
        )
      `;
      await expectDeferredLockTimeout();

      const dryFixture = await insertSourceAuthority(sql);
      const dryTransformId = await insertTransform(sql, dryFixture.sourceId);
      const dryRunId = syntheticId(55);
      const dryChecksum = sha("24");
      await sql`
        insert into import_batches (
          id, organization_id, business_unit_id, migration_source_id, transform_version_id,
          protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
          schema_version, status, dry_run, validated_by_membership_id, validated_at
        ) values (
          ${dryRunId}, ${ids.organization}, ${ids.businessUnit}, ${dryFixture.sourceId},
          ${dryTransformId}, 'protected://synthetic/locked-dry', ${dryChecksum}, 0,
          transaction_timestamp(), transaction_timestamp(), 'synthetic.v1',
          'DRY_RUN_COMPLETE', true, ${ids.membershipBusinessUnit}, clock_timestamp()
        )
      `;
      await startLockCase(
        "select id from import_batches where id = $1 for no key update",
        dryRunId,
      );
      await evidence`
        insert into import_batches (
          id, organization_id, business_unit_id, migration_source_id, transform_version_id,
          validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
          captured_at, cutoff_at, schema_version, status, dry_run
        ) values (
          ${syntheticId(56)}, ${ids.organization}, ${ids.businessUnit}, ${dryFixture.sourceId},
          ${dryTransformId}, ${dryRunId}, 'protected://synthetic/locked-live', ${dryChecksum}, 0,
          transaction_timestamp(), transaction_timestamp(), 'synthetic.v1', 'REGISTERED', false
        )
      `;
      await expectDeferredLockTimeout();

      const transitionFixture = await insertSourceAuthority(sql);
      await startLockCase(
        "select id from migration_domain_authorities where id = $1 for no key update",
        transitionFixture.authorityId,
      );
      const groupId = syntheticId(57);
      await evidence`
        insert into source_authority_transition_groups (
          id, organization_id, idempotency_key, group_size, group_sha256,
          plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
        ) values (
          ${groupId}, ${ids.organization}, ${`locked-transition-${sequence}`}, 1, ${sha("32")},
          'protected://synthetic/locked-transition', ${sha("33")},
          ${ids.membershipOrgWide}, 'Synthetic lock proof'
        )
      `;
      await evidence`
        insert into source_authority_transitions (
          id, organization_id, business_unit_id, transition_group_id,
          domain_authority_id, from_source_scope_id, to_source_scope_id,
          from_state, to_state
        ) values (
          ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${groupId},
          ${transitionFixture.authorityId}, ${transitionFixture.scopeId},
          ${transitionFixture.scopeId}, 'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
        )
      `;
      await expectDeferredLockTimeout();

      await startLockCase(
        "select id from migration_source_scopes where id = $1 for no key update",
        transitionFixture.scopeId,
      );
      const scopeLockedGroupId = syntheticId(57);
      await evidence`
        insert into source_authority_transition_groups (
          id, organization_id, idempotency_key, group_size, group_sha256,
          plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
        ) values (
          ${scopeLockedGroupId}, ${ids.organization}, ${`locked-scope-${sequence}`}, 1, ${sha("34")},
          'protected://synthetic/locked-scope', ${sha("35")},
          ${ids.membershipOrgWide}, 'Synthetic scope lock proof'
        )
      `;
      await evidence`
        insert into source_authority_transitions (
          id, organization_id, business_unit_id, transition_group_id,
          domain_authority_id, from_source_scope_id, to_source_scope_id,
          from_state, to_state
        ) values (
          ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${scopeLockedGroupId},
          ${transitionFixture.authorityId}, ${transitionFixture.scopeId},
          ${transitionFixture.scopeId}, 'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
        )
      `;
      await expectDeferredLockTimeout();

      const batchLockedFixture = await insertSourceAuthority(sql);
      const batchLockedTransformId = await insertTransform(sql, batchLockedFixture.sourceId);
      const batchLockedBatch = await insertDryRunAndLiveBatch(
        sql,
        batchLockedFixture.sourceId,
        batchLockedTransformId,
      );
      await promoteLiveBatch(sql, batchLockedBatch.liveBatchId);
      await startLockCase(
        "select id from import_batches where id = $1 for no key update",
        batchLockedBatch.liveBatchId,
      );
      const batchLockedGroupId = syntheticId(57);
      await evidence`
        insert into source_authority_transition_groups (
          id, organization_id, idempotency_key, group_size, group_sha256,
          plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
        ) values (
          ${batchLockedGroupId}, ${ids.organization}, ${`locked-final-batch-${sequence}`}, 1,
          ${sha("36")}, 'protected://synthetic/locked-final-batch', ${sha("37")},
          ${ids.membershipOrgWide}, 'Synthetic final-batch lock proof'
        )
      `;
      await evidence`
        update migration_domain_authorities
        set authority_state = 'CANONICAL_WRITABLE', authority_source_scope_id = null
        where id = ${batchLockedFixture.authorityId}
      `;
      await evidence`
        insert into source_authority_transitions (
          id, organization_id, business_unit_id, transition_group_id,
          domain_authority_id, from_source_scope_id, to_source_scope_id,
          from_state, to_state, write_frozen_at, final_batch_id, final_cutoff_at
        ) values (
          ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${batchLockedGroupId},
          ${batchLockedFixture.authorityId}, ${batchLockedFixture.scopeId}, null,
          'EXTERNAL_SYSTEM_AUTHORITY', 'CANONICAL_WRITABLE',
          (select cutoff_at from import_batches where id = ${batchLockedBatch.liveBatchId}),
          ${batchLockedBatch.liveBatchId},
          (select cutoff_at from import_batches where id = ${batchLockedBatch.liveBatchId})
        )
      `;
      await expectDeferredLockTimeout();

      const resultFixture = await insertSourceAuthority(sql);
      const resultTransformId = await insertTransform(sql, resultFixture.sourceId);
      const resultBatch = await insertDryRunAndLiveBatch(
        sql,
        resultFixture.sourceId,
        resultTransformId,
      );
      const resultRunId = await insertPendingCountReconciliation(sql, resultBatch.liveBatchId);
      await startLockCase(
        "select id from reconciliation_runs where id = $1 for no key update",
        resultRunId,
      );
      await expect(evidence`
        insert into reconciliation_results (
          id, organization_id, business_unit_id, run_id, check_kind, check_key,
          scope_key, source_count, target_count, passed, evidence_metadata
        ) values (
          ${syntheticId(60)}, ${ids.organization}, ${ids.businessUnit}, ${resultRunId},
          'COUNT', 'records.total', 'all', 1, 1, true, '{}'::jsonb
        )
      `).rejects.toMatchObject({ code: "55P03" });
      await rollbackCase();

      const chunkFixture = await insertSourceAuthority(sql);
      const chunkTransformId = await insertTransform(sql, chunkFixture.sourceId);
      const chunkBatch = await insertDryRunAndLiveBatch(
        sql,
        chunkFixture.sourceId,
        chunkTransformId,
      );
      await sql`
        update import_batches
        set status = 'APPROVED', total_row_count = 1, valid_row_count = 1,
            validated_by_membership_id = ${ids.membershipBusinessUnit},
            validated_at = clock_timestamp(), approval_mode = 'FULL',
            approved_row_count = 1, approved_by_membership_id = ${ids.membershipBusinessUnit},
            approved_at = clock_timestamp(), approval_reason = 'Synthetic chunk approval'
        where id = ${chunkBatch.liveBatchId}
      `;
      await sql`
        update import_batches
        set status = 'APPLYING', applied_by_membership_id = ${ids.membershipBusinessUnit},
            apply_run_id = ${syntheticId(66)}, apply_started_at = clock_timestamp(),
            apply_lease_expires_at = transaction_timestamp() + interval '1 minute'
        where id = ${chunkBatch.liveBatchId}
      `;
      await startLockCase(
        "select id from import_batches where id = $1 for no key update",
        chunkBatch.dryRunId,
      );
      await evidence`
        update import_batches
        set apply_lease_expires_at = apply_lease_expires_at + interval '1 minute'
        where id = ${chunkBatch.liveBatchId}
      `;
      await expect(evidence.unsafe("commit")).resolves.not.toThrow();
      await parent.unsafe("rollback");
    } finally {
      await rollbackCase();
      await Promise.all([parent.end({ timeout: 1 }), evidence.end({ timeout: 1 })]);
    }
  });

  it("does not let unrelated historical corruption block a scoped transition-parent check", async () => {
    const healthy = await insertSourceAuthority(sql);
    const healthyGroupId = syntheticId(57);
    await sql.begin(async (transaction) => {
      await transaction`
        insert into source_authority_transition_groups (
          id, organization_id, idempotency_key, group_size, group_sha256,
          plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
        ) values (
          ${healthyGroupId}, ${ids.organization}, ${`healthy-scope-${sequence}`}, 1, ${sha("38")},
          'protected://synthetic/healthy-scope', ${sha("39")},
          ${ids.membershipOrgWide}, 'Synthetic healthy scoped transition'
        )
      `;
      await transaction`
        insert into source_authority_transitions (
          id, organization_id, business_unit_id, transition_group_id,
          domain_authority_id, from_source_scope_id, to_source_scope_id,
          from_state, to_state
        ) values (
          ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${healthyGroupId},
          ${healthy.authorityId}, ${healthy.scopeId}, ${healthy.scopeId},
          'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
        )
      `;
    });

    const corrupted = await insertSourceAuthority(sql);
    const unrelatedScope = await insertSourceAuthority(sql);
    const corruptedGroupId = syntheticId(57);
    await sql.unsafe(
      "alter table source_authority_transitions disable trigger migration_transition_evidence_from_transition_guard",
    );
    try {
      await sql.begin(async (transaction) => {
        await transaction`
          insert into source_authority_transition_groups (
            id, organization_id, idempotency_key, group_size, group_sha256,
            plan_artifact_ref, plan_sha256, approved_by_membership_id, approval_reason
          ) values (
            ${corruptedGroupId}, ${ids.organization}, ${`corrupted-scope-${sequence}`}, 1,
            ${sha("40")}, 'protected://synthetic/corrupted-scope', ${sha("41")},
            ${ids.membershipOrgWide}, 'Synthetic historical corruption fixture'
          )
        `;
        await transaction`
          insert into source_authority_transitions (
            id, organization_id, business_unit_id, transition_group_id,
            domain_authority_id, from_source_scope_id, to_source_scope_id,
            from_state, to_state
          ) values (
            ${syntheticId(58)}, ${ids.organization}, ${ids.businessUnit}, ${corruptedGroupId},
            ${corrupted.authorityId}, ${corrupted.scopeId}, ${unrelatedScope.scopeId},
            'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ'
          )
        `;
      });
    } finally {
      await sql.unsafe(
        "alter table source_authority_transitions enable trigger migration_transition_evidence_from_transition_guard",
      );
    }

    const [corruption] = await sql<{ count: string }[]>`
      select count(*)::text as count
      from source_authority_transitions transition
      join migration_domain_authorities authority on authority.id = transition.domain_authority_id
      join migration_source_scopes target_scope on target_scope.id = transition.to_source_scope_id
      where transition.transition_group_id = ${corruptedGroupId}
        and target_scope.domain_key <> authority.domain_key
    `;
    expect(corruption?.count).toBe("1");
    await expect(sql`
      update migration_domain_authorities
      set authority_state = 'SHADOW_READ'
      where id = ${healthy.authorityId}
    `).resolves.not.toThrow();
  });
});
