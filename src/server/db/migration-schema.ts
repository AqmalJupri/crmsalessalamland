import { sql, type BuildColumns } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableWithColumns,
} from "drizzle-orm/pg-core";
import { businessUnits, memberships, organizations } from "./schema";

type JsonObject = Record<string, unknown>;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).default(sql`clock_timestamp()`).notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).default(sql`clock_timestamp()`).notNull();
const version = () => bigint("version", { mode: "number" }).default(1).notNull();
const rowCounter = (name: string) => bigint(name, { mode: "number" }).default(0).notNull();
const emptyJsonObject = sql`'{}'::jsonb`;

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

type MigrationSourceStatus = "REGISTERED" | "ACTIVE" | "ARCHIVED_READ_ONLY";
type SourceTransitionMode = "ONE_TIME_CUTOVER" | "RECURRING_EXTERNAL_SNAPSHOT";
type ApprovalMode = "FULL" | "PARTIAL";
type QuarantineStatus = "OPEN" | "RESOLVED";
type QuarantineResolution = "APPROVE_ROW" | "REJECT_ROW";
type ReconciliationRunStatus = "PENDING" | "PASSED" | "FAILED" | "SIGNED";
type ReconciliationCheckKind =
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

export const migrationSources = pgTable(
  "migration_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceKind: text("source_kind").$type<SourceKind>().notNull(),
    sourceMode: text("source_mode").$type<SourceMode>().notNull(),
    ownerMembershipId: uuid("owner_membership_id").notNull(),
    status: text("status").$type<MigrationSourceStatus>().default("REGISTERED").notNull(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "migration_sources_business_unit_fk",
      columns: [table.organizationId, table.businessUnitId],
      foreignColumns: [businessUnits.organizationId, businessUnits.id],
    }),
    foreignKey({
      name: "migration_sources_owner_fk",
      columns: [table.organizationId, table.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique("migration_sources_source_unique").on(
      table.organizationId,
      table.businessUnitId,
      table.sourceKey,
    ),
    unique("migration_sources_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);

export const migrationSourceScopes = pgTable(
  "migration_source_scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    migrationSourceId: uuid("migration_source_id").notNull(),
    domainKey: text("domain_key").notNull(),
    canonicalTarget: text("canonical_target").notNull(),
    transitionMode: text("transition_mode").$type<SourceTransitionMode>().notNull(),
    sourceStatus: text("source_status").$type<SourceScopeStatus>().default("REGISTERED").notNull(),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "migration_source_scopes_source_fk",
      columns: [table.organizationId, table.businessUnitId, table.migrationSourceId],
      foreignColumns: [
        migrationSources.organizationId,
        migrationSources.businessUnitId,
        migrationSources.id,
      ],
    }),
    unique("migration_source_scopes_domain_unique").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.domainKey,
    ),
    unique("migration_source_scopes_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);

export const migrationDomainAuthorities = pgTable(
  "migration_domain_authorities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    domainKey: text("domain_key").notNull(),
    canonicalTarget: text("canonical_target").notNull(),
    authorityState: text("authority_state").$type<AuthorityState>().notNull(),
    authoritySourceScopeId: uuid("authority_source_scope_id"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "migration_domain_authorities_business_unit_fk",
      columns: [table.organizationId, table.businessUnitId],
      foreignColumns: [businessUnits.organizationId, businessUnits.id],
    }),
    foreignKey({
      name: "migration_domain_authorities_scope_fk",
      columns: [table.organizationId, table.businessUnitId, table.authoritySourceScopeId],
      foreignColumns: [
        migrationSourceScopes.organizationId,
        migrationSourceScopes.businessUnitId,
        migrationSourceScopes.id,
      ],
    }),
    unique("migration_domain_authorities_domain_unique").on(
      table.organizationId,
      table.businessUnitId,
      table.domainKey,
    ),
    unique("migration_domain_authorities_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);

export const sourceAuthorityTransitionGroups = pgTable(
  "source_authority_transition_groups",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    groupSize: integer("group_size").notNull(),
    groupSha256: bytea("group_sha256").notNull(),
    planArtifactRef: text("plan_artifact_ref").notNull(),
    planSha256: bytea("plan_sha256").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    approvedByMembershipId: uuid("approved_by_membership_id").notNull(),
    approvalReason: text("approval_reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "transition_groups_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: "transition_groups_approver_fk",
      columns: [table.organizationId, table.approvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique("transition_groups_tenant_id_unique").on(table.organizationId, table.id),
    unique("source_authority_transition_groups_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
  ],
);

export const transformVersions = pgTable(
  "transform_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    migrationSourceId: uuid("migration_source_id").notNull(),
    versionNo: integer("version_no").notNull(),
    sourceSchemaVersion: text("source_schema_version").notNull(),
    mappingArtifactRef: text("mapping_artifact_ref").notNull(),
    mappingSha256: bytea("mapping_sha256").notNull(),
    releaseManifestRef: text("release_manifest_ref").notNull(),
    releaseManifestSha256: bytea("release_manifest_sha256").notNull(),
    transformReleaseSha256: bytea("transform_release_sha256").notNull(),
    rationale: text("rationale").notNull(),
    repairOfTransformId: uuid("repair_of_transform_id"),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "transform_versions_source_fk",
      columns: [table.organizationId, table.businessUnitId, table.migrationSourceId],
      foreignColumns: [
        migrationSources.organizationId,
        migrationSources.businessUnitId,
        migrationSources.id,
      ],
    }),
    foreignKey({
      name: "transform_versions_approver_fk",
      columns: [table.organizationId, table.approvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: "transform_versions_repair_fk",
      columns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.repairOfTransformId,
      ],
      foreignColumns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.id,
      ],
    }),
    unique("transform_versions_version_unique").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.versionNo,
    ),
    unique("transform_versions_tenant_source_key").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.id,
    ),
    unique("transform_versions_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    migrationSourceId: uuid("migration_source_id").notNull(),
    transformVersionId: uuid("transform_version_id").notNull(),
    validatedDryRunBatchId: uuid("validated_dry_run_batch_id"),
    repairOfBatchId: uuid("repair_of_batch_id"),
    protectedArtifactRef: text("protected_artifact_ref").notNull(),
    sourceSha256: bytea("source_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status").$type<ImportBatchStatus>().default("REGISTERED").notNull(),
    dryRun: boolean("dry_run").notNull(),
    totalRowCount: rowCounter("total_row_count"),
    stagedRowCount: rowCounter("staged_row_count"),
    validRowCount: rowCounter("valid_row_count"),
    rejectedRowCount: rowCounter("rejected_row_count"),
    quarantinedRowCount: rowCounter("quarantined_row_count"),
    hiddenRowCount: rowCounter("hidden_row_count"),
    approvedRowCount: rowCounter("approved_row_count"),
    importedRowCount: rowCounter("imported_row_count"),
    noOpRowCount: rowCounter("no_op_row_count"),
    validatedByMembershipId: uuid("validated_by_membership_id"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalMode: text("approval_mode").$type<ApprovalMode>(),
    approvalReason: text("approval_reason"),
    appliedByMembershipId: uuid("applied_by_membership_id"),
    applyRunId: uuid("apply_run_id"),
    applyLeaseExpiresAt: timestamp("apply_lease_expires_at", { withTimezone: true }),
    applyStartedAt: timestamp("apply_started_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    operatorReason: text("operator_reason"),
    failureCode: text("failure_code"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "import_batches_source_fk",
      columns: [table.organizationId, table.businessUnitId, table.migrationSourceId],
      foreignColumns: [
        migrationSources.organizationId,
        migrationSources.businessUnitId,
        migrationSources.id,
      ],
    }),
    foreignKey({
      name: "import_batches_transform_fk",
      columns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.transformVersionId,
      ],
      foreignColumns: [
        transformVersions.organizationId,
        transformVersions.businessUnitId,
        transformVersions.migrationSourceId,
        transformVersions.id,
      ],
    }),
    foreignKey({
      name: "import_batches_validator_fk",
      columns: [table.organizationId, table.validatedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: "import_batches_approver_fk",
      columns: [table.organizationId, table.approvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: "import_batches_applier_fk",
      columns: [table.organizationId, table.appliedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: "import_batches_dry_run_fk",
      columns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.sourceSha256,
        table.transformVersionId,
        table.validatedDryRunBatchId,
      ],
      foreignColumns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.sourceSha256,
        table.transformVersionId,
        table.id,
      ],
    }),
    foreignKey({
      name: "import_batches_repair_fk",
      columns: [table.organizationId, table.businessUnitId, table.repairOfBatchId],
      foreignColumns: [table.organizationId, table.businessUnitId, table.id],
    }),
    unique("import_batches_source_snapshot_unique").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.sourceSha256,
      table.transformVersionId,
      table.dryRun,
    ),
    unique("import_batches_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
    unique("import_batches_lineage_target_key").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.sourceSha256,
      table.transformVersionId,
      table.id,
    ),
  ],
);

export const sourceAuthorityTransitions = pgTable(
  "source_authority_transitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    transitionGroupId: uuid("transition_group_id").notNull(),
    domainAuthorityId: uuid("domain_authority_id").notNull(),
    fromSourceScopeId: uuid("from_source_scope_id"),
    toSourceScopeId: uuid("to_source_scope_id"),
    fromState: text("from_state").$type<AuthorityState>().notNull(),
    toState: text("to_state").$type<AuthorityState>().notNull(),
    writeFrozenAt: timestamp("write_frozen_at", { withTimezone: true }),
    finalBatchId: uuid("final_batch_id"),
    finalCutoffAt: timestamp("final_cutoff_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "authority_transitions_group_fk",
      columns: [table.organizationId, table.transitionGroupId],
      foreignColumns: [
        sourceAuthorityTransitionGroups.organizationId,
        sourceAuthorityTransitionGroups.id,
      ],
    }),
    foreignKey({
      name: "authority_transitions_authority_fk",
      columns: [table.organizationId, table.businessUnitId, table.domainAuthorityId],
      foreignColumns: [
        migrationDomainAuthorities.organizationId,
        migrationDomainAuthorities.businessUnitId,
        migrationDomainAuthorities.id,
      ],
    }),
    foreignKey({
      name: "authority_transitions_from_scope_fk",
      columns: [table.organizationId, table.businessUnitId, table.fromSourceScopeId],
      foreignColumns: [
        migrationSourceScopes.organizationId,
        migrationSourceScopes.businessUnitId,
        migrationSourceScopes.id,
      ],
    }),
    foreignKey({
      name: "authority_transitions_to_scope_fk",
      columns: [table.organizationId, table.businessUnitId, table.toSourceScopeId],
      foreignColumns: [
        migrationSourceScopes.organizationId,
        migrationSourceScopes.businessUnitId,
        migrationSourceScopes.id,
      ],
    }),
    foreignKey({
      name: "authority_transitions_final_batch_fk",
      columns: [table.organizationId, table.businessUnitId, table.finalBatchId],
      foreignColumns: [importBatches.organizationId, importBatches.businessUnitId, importBatches.id],
    }),
    unique("source_authority_transitions_member_unique").on(
      table.organizationId,
      table.transitionGroupId,
      table.domainAuthorityId,
    ),
    unique("authority_transitions_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);

const importRowColumns = {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  batchId: uuid("batch_id").notNull(),
  sourceRowKey: text("source_row_key").notNull(),
  rowNumber: bigint("row_number", { mode: "bigint" }),
  sourceObjectType: text("source_object_type").notNull(),
  sourceRecordId: text("source_record_id"),
  sourceLocator: text("source_locator").notNull(),
  rowSha256: bytea("row_sha256").notNull(),
  rawEvidenceRef: text("raw_evidence_ref").notNull(),
  normalizedEvidenceRef: text("normalized_evidence_ref"),
  normalizedSha256: bytea("normalized_sha256"),
  outcome: text("outcome").$type<ImportRowOutcome>().default("STAGED").notNull(),
  errorCode: text("error_code"),
  errorMetadata: jsonb("error_metadata").$type<JsonObject>().default(emptyJsonObject).notNull(),
  resolvedLinkId: uuid("resolved_link_id"),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};

type ImportRowsTable = PgTableWithColumns<{
  name: "import_rows";
  schema: undefined;
  columns: BuildColumns<"import_rows", typeof importRowColumns, "pg">;
  dialect: "pg";
}>;

export const importRows: ImportRowsTable = pgTable(
  "import_rows",
  importRowColumns,
  (table) => [
    foreignKey({
      name: "import_rows_batch_fk",
      columns: [table.organizationId, table.businessUnitId, table.batchId],
      foreignColumns: [importBatches.organizationId, importBatches.businessUnitId, importBatches.id],
    }),
    foreignKey({
      name: "import_rows_resolved_link_fk",
      columns: [table.organizationId, table.businessUnitId, table.resolvedLinkId],
      foreignColumns: [
        legacyObjectLinks.organizationId,
        legacyObjectLinks.businessUnitId,
        legacyObjectLinks.id,
      ],
    }),
    unique("import_rows_source_key_unique").on(
      table.organizationId,
      table.batchId,
      table.sourceRowKey,
    ),
    unique("import_rows_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
    uniqueIndex("import_rows_row_number_unique")
      .on(table.organizationId, table.batchId, table.rowNumber)
      .where(sql`${table.rowNumber} is not null`),
  ],
);

export const legacyObjectLinks = pgTable(
  "legacy_object_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    migrationSourceId: uuid("migration_source_id").notNull(),
    importRowId: uuid("import_row_id").notNull(),
    sourceObjectType: text("source_object_type").notNull(),
    sourceRowKey: text("source_row_key").notNull(),
    linkVersion: integer("link_version").notNull(),
    supersedesLinkId: uuid("supersedes_link_id"),
    destinationEntityType: text("destination_entity_type").notNull(),
    destinationEntityId: uuid("destination_entity_id").notNull(),
    correctionReason: text("correction_reason"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "legacy_object_links_source_fk",
      columns: [table.organizationId, table.businessUnitId, table.migrationSourceId],
      foreignColumns: [
        migrationSources.organizationId,
        migrationSources.businessUnitId,
        migrationSources.id,
      ],
    }),
    foreignKey({
      name: "legacy_object_links_import_row_fk",
      columns: [table.organizationId, table.businessUnitId, table.importRowId],
      foreignColumns: [importRows.organizationId, importRows.businessUnitId, importRows.id],
    }),
    foreignKey({
      name: "legacy_object_links_actor_fk",
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      name: "legacy_object_links_supersedes_fk",
      columns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.supersedesLinkId,
      ],
      foreignColumns: [
        table.organizationId,
        table.businessUnitId,
        table.migrationSourceId,
        table.id,
      ],
    }),
    unique("legacy_object_links_version_unique").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.sourceObjectType,
      table.sourceRowKey,
      table.linkVersion,
    ),
    unique("legacy_object_links_tenant_source_key").on(
      table.organizationId,
      table.businessUnitId,
      table.migrationSourceId,
      table.id,
    ),
    unique("legacy_object_links_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
    unique("legacy_object_links_row_link_key").on(
      table.organizationId,
      table.businessUnitId,
      table.importRowId,
      table.id,
    ),
    unique("legacy_object_links_supersedes_unique").on(table.supersedesLinkId),
  ],
);

export const quarantineItems = pgTable(
  "quarantine_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    importRowId: uuid("import_row_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonMetadata: jsonb("reason_metadata").$type<JsonObject>().default(emptyJsonObject).notNull(),
    status: text("status").$type<QuarantineStatus>().default("OPEN").notNull(),
    resolution: text("resolution").$type<QuarantineResolution>(),
    resolvedByMembershipId: uuid("resolved_by_membership_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "quarantine_items_import_row_fk",
      columns: [table.organizationId, table.businessUnitId, table.importRowId],
      foreignColumns: [importRows.organizationId, importRows.businessUnitId, importRows.id],
    }),
    foreignKey({
      name: "quarantine_items_resolver_fk",
      columns: [table.organizationId, table.resolvedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique("quarantine_items_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
    uniqueIndex("quarantine_items_open_unique")
      .on(table.organizationId, table.importRowId, table.reasonCode)
      .where(sql`${table.status} = 'OPEN'`),
  ],
);

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    runNo: integer("run_no").notNull(),
    status: text("status").$type<ReconciliationRunStatus>().default("PENDING").notNull(),
    planArtifactRef: text("plan_artifact_ref").notNull(),
    planSha256: bytea("plan_sha256").notNull(),
    requiredChecks: jsonb("required_checks").$type<unknown[]>().notNull(),
    requiredChecksSha256: bytea("required_checks_sha256").notNull(),
    requiredCheckCount: integer("required_check_count").notNull(),
    passedCheckCount: integer("passed_check_count").default(0).notNull(),
    failedCheckCount: integer("failed_check_count").default(0).notNull(),
    signedByMembershipId: uuid("signed_by_membership_id"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "reconciliation_runs_batch_fk",
      columns: [table.organizationId, table.businessUnitId, table.batchId],
      foreignColumns: [importBatches.organizationId, importBatches.businessUnitId, importBatches.id],
    }),
    foreignKey({
      name: "reconciliation_runs_signer_fk",
      columns: [table.organizationId, table.signedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    unique("reconciliation_runs_run_unique").on(
      table.organizationId,
      table.batchId,
      table.runNo,
    ),
    unique("reconciliation_runs_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);

export const reconciliationResults = pgTable(
  "reconciliation_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    businessUnitId: uuid("business_unit_id").notNull(),
    runId: uuid("run_id").notNull(),
    checkKind: text("check_kind").$type<ReconciliationCheckKind>().notNull(),
    checkKey: text("check_key").notNull(),
    scopeKey: text("scope_key").notNull(),
    sourceCount: bigint("source_count", { mode: "bigint" }),
    targetCount: bigint("target_count", { mode: "bigint" }),
    sourceAmount: numeric("source_amount", { precision: 38, scale: 12 }),
    targetAmount: numeric("target_amount", { precision: 38, scale: 12 }),
    measureUnit: text("measure_unit"),
    decimalScale: smallint("decimal_scale"),
    sourceChecksum: bytea("source_checksum"),
    targetChecksum: bytea("target_checksum"),
    passed: boolean("passed").notNull(),
    evidenceMetadata: jsonb("evidence_metadata")
      .$type<JsonObject>()
      .default(emptyJsonObject)
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "reconciliation_results_run_fk",
      columns: [table.organizationId, table.businessUnitId, table.runId],
      foreignColumns: [
        reconciliationRuns.organizationId,
        reconciliationRuns.businessUnitId,
        reconciliationRuns.id,
      ],
    }),
    unique("reconciliation_results_identity_unique")
      .on(
        table.organizationId,
        table.runId,
        table.checkKind,
        table.checkKey,
        table.scopeKey,
        table.measureUnit,
        table.decimalScale,
      )
      .nullsNotDistinct(),
    unique("reconciliation_results_tenant_bu_key").on(
      table.organizationId,
      table.businessUnitId,
      table.id,
    ),
  ],
);
