import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  importRows,
  migrationDomainAuthorities,
  migrationSourceScopes,
  migrationSources,
} from "@/server/db/migration-schema";
import {
  auditEvents,
  businessUnits,
  membershipRoles,
  memberships,
  organizations,
  outboxEvents,
  roleCapabilities,
  roles,
  users,
} from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import {
  assertProtectedArtifactRef,
  assertSha256Digest,
  digestsEqual,
} from "./artifact-checksum";
import type { MigrationActor } from "./contracts";

const STAGE_CAPABILITY = "migration.source.manage";
const STAGING_CHUNK_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ROW_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const SOURCE_OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,126}$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

type Database = ReturnType<typeof getDatabase>;
export type MigrationDatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

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

interface CanonicalStagedRow {
  sourceRowKey: string;
  rowNumber: bigint | null;
  sourceObjectType: string;
  sourceRecordId: string | null;
  sourceLocator: string;
  expectedRowSha256: Uint8Array;
  rawEvidenceRef: string;
}

interface VerifiedStagedRow extends CanonicalStagedRow {
  verifiedRowSha256: Uint8Array;
  verifiedRawEvidenceRef: string;
  verifiedSourceLocator: string;
}

export interface MigrationBatchLockContext {
  id: string;
  organizationId: string;
  businessUnitId: string;
  migrationSourceId: string;
  transformVersionId: string;
  validatedDryRunBatchId: string | null;
  repairOfBatchId: string | null;
  protectedArtifactRef: string;
  sourceSha256: Uint8Array;
  sizeBytes: bigint;
  capturedAt: Date;
  cutoffAt: Date;
  schemaVersion: string;
  status: string;
  dryRun: boolean;
  validatedByMembershipId: string | null;
  validatedAt: Date | null;
  approvedByMembershipId: string | null;
  approvedAt: Date | null;
  approvalMode: "FULL" | "PARTIAL" | null;
  approvalReason: string | null;
  approvedRowCount: number;
  appliedByMembershipId: string | null;
  applyRunId: string | null;
  applyLeaseExpiresAt: Date | null;
  applyStartedAt: Date | null;
  appliedAt: Date | null;
  operatorReason: string | null;
  failureCode: string | null;
  totalRowCount: number;
  stagedRowCount: number;
  validRowCount: number;
  rejectedRowCount: number;
  quarantinedRowCount: number;
  hiddenRowCount: number;
  importedRowCount: number;
  noOpRowCount: number;
  version: number;
}

interface ActorEvidence {
  userType: "HUMAN" | "SERVICE";
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function validateMigrationActor(
  actor: MigrationActor,
  capability: string,
): MigrationActor {
  if (!actor || typeof actor !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The migration actor is invalid.");
  }
  if (
    !Array.isArray(actor.capabilities) ||
    !actor.capabilities.every((value) => typeof value === "string")
  ) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "actor.capabilities must be an array of capability keys.",
    );
  }
  if (!actor.capabilities.includes(capability)) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${capability} capability is required.`,
    );
  }
  return {
    userId: canonicalUuid(actor.userId, "actor.userId"),
    organizationId: canonicalUuid(actor.organizationId, "actor.organizationId"),
    activeMembershipId: canonicalUuid(
      actor.activeMembershipId,
      "actor.activeMembershipId",
    ),
    businessUnitId: canonicalUuid(actor.businessUnitId, "actor.businessUnitId"),
    capabilities: [...actor.capabilities],
  };
}

export async function requireActiveMigrationTenant(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
): Promise<void> {
  const [organization] = await transaction
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, actor.organizationId),
        eq(organizations.status, "ACTIVE"),
      ),
    )
    .for("share")
    .limit(1);
  if (!organization) {
    throw new ApiError(404, "MIGRATION_ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  const [businessUnit] = await transaction
    .select({ id: businessUnits.id })
    .from(businessUnits)
    .where(
      and(
        eq(businessUnits.organizationId, actor.organizationId),
        eq(businessUnits.id, actor.businessUnitId),
        eq(businessUnits.status, "ACTIVE"),
      ),
    )
    .for("share")
    .limit(1);
  if (!businessUnit) {
    throw new ApiError(
      404,
      "MIGRATION_BUSINESS_UNIT_NOT_FOUND",
      "Business unit not found.",
    );
  }
}

export async function requireMigrationActorCapability(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  capability: string,
): Promise<ActorEvidence> {
  const [actorEvidence] = await transaction
    .select({
      membershipBusinessUnitId: memberships.businessUnitId,
      userType: users.userType,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, actor.organizationId),
        eq(memberships.id, actor.activeMembershipId),
        eq(memberships.userId, actor.userId),
        eq(memberships.status, "ACTIVE"),
        eq(users.status, "ACTIVE"),
        sql`${memberships.validFrom} <= clock_timestamp()`,
        sql`(${memberships.validUntil} is null or ${memberships.validUntil} >= clock_timestamp())`,
      ),
    )
    .for("share", { of: [memberships, users] })
    .limit(1);
  if (!actorEvidence) {
    throw new ApiError(
      403,
      "MIGRATION_MEMBERSHIP_INVALID",
      "The active migration membership is no longer valid.",
    );
  }
  if (
    actorEvidence.membershipBusinessUnitId !== null &&
    actorEvidence.membershipBusinessUnitId !== actor.businessUnitId
  ) {
    throw new ApiError(
      403,
      "MIGRATION_SCOPE_FORBIDDEN",
      "The active membership cannot manage this business unit.",
    );
  }
  const [grant] = await transaction
    .select({ membershipId: membershipRoles.membershipId })
    .from(membershipRoles)
    .innerJoin(
      roles,
      and(
        eq(roles.organizationId, membershipRoles.organizationId),
        eq(roles.id, membershipRoles.roleId),
      ),
    )
    .innerJoin(
      roleCapabilities,
      and(
        eq(roleCapabilities.organizationId, membershipRoles.organizationId),
        eq(roleCapabilities.roleId, membershipRoles.roleId),
      ),
    )
    .where(
      and(
        eq(membershipRoles.organizationId, actor.organizationId),
        eq(membershipRoles.membershipId, actor.activeMembershipId),
        eq(roles.status, "ACTIVE"),
        eq(roleCapabilities.capabilityKey, capability),
        sql`${membershipRoles.validFrom} <= clock_timestamp()`,
        sql`(${membershipRoles.validUntil} is null or ${membershipRoles.validUntil} >= clock_timestamp())`,
      ),
    )
    .for("share", { of: [membershipRoles, roles, roleCapabilities] })
    .limit(1);
  if (!grant) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${capability} capability is required.`,
    );
  }
  return { userType: actorEvidence.userType };
}

export async function lockAndValidateMigrationSourceAuthority(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  migrationSourceId: string,
): Promise<void> {
  const lockedHeads = await transaction
    .select({
      id: migrationDomainAuthorities.id,
      businessUnitId: migrationDomainAuthorities.businessUnitId,
      domainKey: migrationDomainAuthorities.domainKey,
      canonicalTarget: migrationDomainAuthorities.canonicalTarget,
      authorityState: migrationDomainAuthorities.authorityState,
      authoritySourceScopeId: migrationDomainAuthorities.authoritySourceScopeId,
      scopeId: migrationSourceScopes.id,
    })
    .from(migrationDomainAuthorities)
    .innerJoin(
      migrationSourceScopes,
      and(
        eq(migrationSourceScopes.organizationId, migrationDomainAuthorities.organizationId),
        eq(migrationSourceScopes.businessUnitId, migrationDomainAuthorities.businessUnitId),
        eq(migrationSourceScopes.id, migrationDomainAuthorities.authoritySourceScopeId),
      ),
    )
    .where(
      and(
        eq(migrationDomainAuthorities.organizationId, actor.organizationId),
        eq(migrationDomainAuthorities.businessUnitId, actor.businessUnitId),
        eq(migrationSourceScopes.migrationSourceId, migrationSourceId),
      ),
    )
    .orderBy(
      asc(migrationDomainAuthorities.businessUnitId),
      asc(migrationDomainAuthorities.domainKey),
      asc(migrationDomainAuthorities.id),
    )
    .for("share", { of: [migrationDomainAuthorities] });

  const [source] = await transaction
    .select({ id: migrationSources.id, status: migrationSources.status })
    .from(migrationSources)
    .where(
      and(
        eq(migrationSources.organizationId, actor.organizationId),
        eq(migrationSources.businessUnitId, actor.businessUnitId),
        eq(migrationSources.id, migrationSourceId),
      ),
    )
    .for("share")
    .limit(1);
  if (!source) {
    throw new ApiError(404, "MIGRATION_SOURCE_NOT_FOUND", "Migration source not found.");
  }
  if (source.status !== "ACTIVE") {
    throw new ApiError(
      409,
      "MIGRATION_SOURCE_NOT_ACTIVE",
      "Only an active authority source can receive staged rows.",
    );
  }

  const sourceScopes = await transaction
    .select({
      scopeId: migrationSourceScopes.id,
      scopeStatus: migrationSourceScopes.sourceStatus,
      domainKey: migrationSourceScopes.domainKey,
      canonicalTarget: migrationSourceScopes.canonicalTarget,
    })
    .from(migrationSourceScopes)
    .where(
      and(
        eq(migrationSourceScopes.organizationId, actor.organizationId),
        eq(migrationSourceScopes.businessUnitId, actor.businessUnitId),
        eq(migrationSourceScopes.migrationSourceId, migrationSourceId),
      ),
    )
    .orderBy(asc(migrationSourceScopes.domainKey), asc(migrationSourceScopes.id))
    .for("share");

  if (
    sourceScopes.length === 0 ||
    sourceScopes.some((scope) => scope.scopeStatus !== "ACTIVE_AUTHORITY") ||
    lockedHeads.length !== sourceScopes.length
  ) {
    throw new ApiError(
      409,
      "MIGRATION_SOURCE_NOT_ACTIVE",
      "The migration source no longer owns its complete active authority inventory.",
    );
  }
  const headByScope = new Map(lockedHeads.map((head) => [head.scopeId, head] as const));
  for (const scope of sourceScopes) {
    const head = headByScope.get(scope.scopeId);
    if (
      !head ||
      head.businessUnitId !== actor.businessUnitId ||
      head.authoritySourceScopeId !== scope.scopeId ||
      head.domainKey !== scope.domainKey ||
      head.canonicalTarget !== scope.canonicalTarget ||
      head.authorityState === "CANONICAL_WRITABLE"
    ) {
      throw new ApiError(
        409,
        "MIGRATION_SOURCE_NOT_ACTIVE",
        "The source authority-head lineage changed before the row mutation.",
      );
    }
  }
}

function selectedBatchColumns() {
  return {
    id: importBatches.id,
    organizationId: importBatches.organizationId,
    businessUnitId: importBatches.businessUnitId,
    migrationSourceId: importBatches.migrationSourceId,
    transformVersionId: importBatches.transformVersionId,
    validatedDryRunBatchId: importBatches.validatedDryRunBatchId,
    repairOfBatchId: importBatches.repairOfBatchId,
    protectedArtifactRef: importBatches.protectedArtifactRef,
    sourceSha256: importBatches.sourceSha256,
    sizeBytes: importBatches.sizeBytes,
    capturedAt: importBatches.capturedAt,
    cutoffAt: importBatches.cutoffAt,
    schemaVersion: importBatches.schemaVersion,
    status: importBatches.status,
    dryRun: importBatches.dryRun,
    validatedByMembershipId: importBatches.validatedByMembershipId,
    validatedAt: importBatches.validatedAt,
    approvedByMembershipId: importBatches.approvedByMembershipId,
    approvedAt: importBatches.approvedAt,
    approvalMode: importBatches.approvalMode,
    approvalReason: importBatches.approvalReason,
    approvedRowCount: importBatches.approvedRowCount,
    appliedByMembershipId: importBatches.appliedByMembershipId,
    applyRunId: importBatches.applyRunId,
    applyLeaseExpiresAt: importBatches.applyLeaseExpiresAt,
    applyStartedAt: importBatches.applyStartedAt,
    appliedAt: importBatches.appliedAt,
    operatorReason: importBatches.operatorReason,
    failureCode: importBatches.failureCode,
    totalRowCount: importBatches.totalRowCount,
    stagedRowCount: importBatches.stagedRowCount,
    validRowCount: importBatches.validRowCount,
    rejectedRowCount: importBatches.rejectedRowCount,
    quarantinedRowCount: importBatches.quarantinedRowCount,
    hiddenRowCount: importBatches.hiddenRowCount,
    importedRowCount: importBatches.importedRowCount,
    noOpRowCount: importBatches.noOpRowCount,
    version: importBatches.version,
  };
}

function cloneBatchContext(batch: MigrationBatchLockContext): MigrationBatchLockContext {
  return {
    ...batch,
    sourceSha256: new Uint8Array(batch.sourceSha256),
    capturedAt: new Date(batch.capturedAt.getTime()),
    cutoffAt: new Date(batch.cutoffAt.getTime()),
    validatedAt: batch.validatedAt === null ? null : new Date(batch.validatedAt.getTime()),
    approvedAt: batch.approvedAt === null ? null : new Date(batch.approvedAt.getTime()),
    applyLeaseExpiresAt:
      batch.applyLeaseExpiresAt === null
        ? null
        : new Date(batch.applyLeaseExpiresAt.getTime()),
    applyStartedAt:
      batch.applyStartedAt === null ? null : new Date(batch.applyStartedAt.getTime()),
    appliedAt: batch.appliedAt === null ? null : new Date(batch.appliedAt.getTime()),
  };
}

function assertStageableBatch(batch: MigrationBatchLockContext): void {
  if (batch.status !== "REGISTERED" && batch.status !== "STAGED") {
    throw new ApiError(
      409,
      "IMPORT_BATCH_TERMINAL",
      "Rows can be staged only while the batch is registered or staging.",
    );
  }
}

async function locateBatch(
  database: Database,
  actor: MigrationActor,
  batchId: string,
): Promise<{ batchId: string; migrationSourceId: string }> {
  const [locator] = await database
    .select({ id: importBatches.id, migrationSourceId: importBatches.migrationSourceId })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, actor.organizationId),
        eq(importBatches.businessUnitId, actor.businessUnitId),
        eq(importBatches.id, batchId),
      ),
    )
    .limit(1);
  if (!locator) {
    throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
  }
  return { batchId: locator.id, migrationSourceId: locator.migrationSourceId };
}

async function loadBatchContext(
  database: Database,
  actor: MigrationActor,
  locator: { batchId: string; migrationSourceId: string },
): Promise<MigrationBatchLockContext> {
  return database.transaction(async (transaction) => {
    await requireActiveMigrationTenant(transaction, actor);
    await requireMigrationActorCapability(transaction, actor, STAGE_CAPABILITY);
    await lockAndValidateMigrationSourceAuthority(
      transaction,
      actor,
      locator.migrationSourceId,
    );
    const [batch] = await transaction
      .select(selectedBatchColumns())
      .from(importBatches)
      .where(
        and(
          eq(importBatches.organizationId, actor.organizationId),
          eq(importBatches.businessUnitId, actor.businessUnitId),
          eq(importBatches.migrationSourceId, locator.migrationSourceId),
          eq(importBatches.id, locator.batchId),
        ),
      )
      .for("share")
      .limit(1);
    if (!batch) {
      throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
    }
    assertStageableBatch(batch);
    await requireMigrationActorCapability(transaction, actor, STAGE_CAPABILITY);
    return cloneBatchContext(batch);
  });
}

function validateRow(input: unknown): CanonicalStagedRow {
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "IMPORT_ROW_INPUT_INVALID", "The staged row is invalid.");
  }
  const row = input as StagedSourceRow;
  if (typeof row.sourceRowKey !== "string" || !SOURCE_ROW_KEY_PATTERN.test(row.sourceRowKey)) {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "sourceRowKey must be a canonical bounded source key.",
    );
  }
  if (
    row.rowNumber !== null &&
    (typeof row.rowNumber !== "bigint" ||
      row.rowNumber < 1n ||
      row.rowNumber > MAX_POSTGRES_BIGINT)
  ) {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "rowNumber must be a positive PostgreSQL bigint or null.",
    );
  }
  if (
    typeof row.sourceObjectType !== "string" ||
    !SOURCE_OBJECT_TYPE_PATTERN.test(row.sourceObjectType)
  ) {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "sourceObjectType must be a canonical bounded object type.",
    );
  }
  if (
    row.sourceRecordId !== null &&
    (typeof row.sourceRecordId !== "string" ||
      row.sourceRecordId !== row.sourceRecordId.trim() ||
      row.sourceRecordId.length < 1 ||
      row.sourceRecordId.length > 512)
  ) {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "sourceRecordId must be a bounded canonical value or null.",
    );
  }
  if (
    typeof row.sourceLocator !== "string" ||
    row.sourceLocator !== row.sourceLocator.trim() ||
    row.sourceLocator.length < 1 ||
    row.sourceLocator.length > 2_048 ||
    /[\u0000-\u001f\u007f]/.test(row.sourceLocator)
  ) {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "sourceLocator must be a bounded canonical adapter locator.",
    );
  }
  assertSha256Digest(row.expectedRowSha256, "expectedRowSha256");
  assertProtectedArtifactRef(row.rawEvidenceRef, "rawEvidenceRef");
  return {
    sourceRowKey: row.sourceRowKey,
    rowNumber: row.rowNumber,
    sourceObjectType: row.sourceObjectType,
    sourceRecordId: row.sourceRecordId,
    sourceLocator: row.sourceLocator,
    expectedRowSha256: new Uint8Array(row.expectedRowSha256),
    rawEvidenceRef: row.rawEvidenceRef,
  };
}

function validateChunk(rows: readonly unknown[]): CanonicalStagedRow[] {
  const canonical = rows.map(validateRow);
  const sourceKeys = new Set<string>();
  const rowNumbers = new Set<bigint>();
  for (const row of canonical) {
    if (sourceKeys.has(row.sourceRowKey)) {
      throw new ApiError(
        409,
        "IMPORT_ROW_SOURCE_KEY_DUPLICATE",
        "A staging chunk cannot repeat a source row key.",
      );
    }
    sourceKeys.add(row.sourceRowKey);
    if (row.rowNumber !== null) {
      if (rowNumbers.has(row.rowNumber)) {
        throw new ApiError(
          409,
          "IMPORT_ROW_NUMBER_DUPLICATE",
          "A staging chunk cannot repeat a non-null row number.",
        );
      }
      rowNumbers.add(row.rowNumber);
    }
  }
  return canonical;
}

async function verifyRow(
  row: CanonicalStagedRow,
  context: MigrationBatchLockContext,
  verifier: RawEvidenceVerifier,
): Promise<VerifiedStagedRow> {
  let untrusted: unknown;
  try {
    untrusted = await verifier.verify({
      batchArtifactRef: context.protectedArtifactRef,
      batchSourceSha256: new Uint8Array(context.sourceSha256),
      rawEvidenceRef: row.rawEvidenceRef,
      sourceLocator: row.sourceLocator,
      expectedRowSha256: new Uint8Array(row.expectedRowSha256),
    });
  } catch {
    throw new ApiError(
      422,
      "RAW_EVIDENCE_VERIFICATION_FAILED",
      "Protected raw evidence could not be verified.",
    );
  }
  if (!untrusted || typeof untrusted !== "object") {
    throw new ApiError(
      422,
      "RAW_EVIDENCE_BINDING_INVALID",
      "Verified raw evidence did not bind the requested row.",
    );
  }
  const verified = untrusted as VerifiedRawEvidence;
  if (
    typeof verified.ref !== "string" ||
    typeof verified.sourceLocator !== "string" ||
    !(verified.rowSha256 instanceof Uint8Array) ||
    verified.rowSha256.byteLength !== 32 ||
    !(verified.batchSourceSha256 instanceof Uint8Array) ||
    verified.batchSourceSha256.byteLength !== 32 ||
    verified.ref !== row.rawEvidenceRef ||
    verified.sourceLocator !== row.sourceLocator ||
    !digestsEqual(verified.batchSourceSha256, context.sourceSha256)
  ) {
    throw new ApiError(
      422,
      "RAW_EVIDENCE_BINDING_INVALID",
      "Verified raw evidence did not bind the requested row.",
    );
  }
  if (!digestsEqual(verified.rowSha256, row.expectedRowSha256)) {
    throw new ApiError(
      422,
      "IMPORT_ROW_CHECKSUM_MISMATCH",
      "Verified raw evidence does not match the reviewed row checksum.",
    );
  }
  return {
    ...row,
    expectedRowSha256: new Uint8Array(row.expectedRowSha256),
    verifiedRowSha256: new Uint8Array(verified.rowSha256),
    verifiedRawEvidenceRef: verified.ref,
    verifiedSourceLocator: verified.sourceLocator,
  };
}

function batchEnvelopeMatches(
  current: MigrationBatchLockContext,
  expected: MigrationBatchLockContext,
): boolean {
  const nullableDatesEqual = (left: Date | null, right: Date | null) =>
    left === null ? right === null : right !== null && left.getTime() === right.getTime();
  return (
    current.id === expected.id &&
    current.organizationId === expected.organizationId &&
    current.businessUnitId === expected.businessUnitId &&
    current.migrationSourceId === expected.migrationSourceId &&
    current.transformVersionId === expected.transformVersionId &&
    current.validatedDryRunBatchId === expected.validatedDryRunBatchId &&
    current.repairOfBatchId === expected.repairOfBatchId &&
    current.protectedArtifactRef === expected.protectedArtifactRef &&
    digestsEqual(current.sourceSha256, expected.sourceSha256) &&
    current.sizeBytes === expected.sizeBytes &&
    current.capturedAt.getTime() === expected.capturedAt.getTime() &&
    current.cutoffAt.getTime() === expected.cutoffAt.getTime() &&
    current.schemaVersion === expected.schemaVersion &&
    current.dryRun === expected.dryRun &&
    current.validatedByMembershipId === expected.validatedByMembershipId &&
    nullableDatesEqual(current.validatedAt, expected.validatedAt) &&
    current.approvedByMembershipId === expected.approvedByMembershipId &&
    nullableDatesEqual(current.approvedAt, expected.approvedAt) &&
    current.approvalMode === expected.approvalMode &&
    current.approvalReason === expected.approvalReason &&
    current.approvedRowCount === expected.approvedRowCount &&
    current.appliedByMembershipId === expected.appliedByMembershipId &&
    current.applyRunId === expected.applyRunId &&
    nullableDatesEqual(current.applyLeaseExpiresAt, expected.applyLeaseExpiresAt) &&
    nullableDatesEqual(current.applyStartedAt, expected.applyStartedAt) &&
    nullableDatesEqual(current.appliedAt, expected.appliedAt) &&
    current.operatorReason === expected.operatorReason &&
    current.failureCode === expected.failureCode
  );
}

function batchStateSnapshotMatches(
  current: MigrationBatchLockContext,
  expected: MigrationBatchLockContext,
): boolean {
  return (
    current.version === expected.version &&
    current.status === expected.status &&
    current.totalRowCount === expected.totalRowCount &&
    current.stagedRowCount === expected.stagedRowCount &&
    current.validRowCount === expected.validRowCount &&
    current.rejectedRowCount === expected.rejectedRowCount &&
    current.quarantinedRowCount === expected.quarantinedRowCount &&
    current.hiddenRowCount === expected.hiddenRowCount &&
    current.importedRowCount === expected.importedRowCount &&
    current.noOpRowCount === expected.noOpRowCount
  );
}

function safeCounterAdd(value: number, increment: number): number {
  const result = value + increment;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    !Number.isSafeInteger(result)
  ) {
    throw new ApiError(
      500,
      "IMPORT_ROW_SUMMARY_UNSAFE",
      "The import row summary exceeds the safe reporting range.",
    );
  }
  return result;
}

function rowEnvelopeMatches(
  stored: {
    sourceRowKey: string;
    rowNumber: bigint | null;
    sourceObjectType: string;
    sourceRecordId: string | null;
    sourceLocator: string;
    rowSha256: Uint8Array;
    rawEvidenceRef: string;
  },
  incoming: VerifiedStagedRow,
): boolean {
  return (
    stored.sourceRowKey === incoming.sourceRowKey &&
    stored.rowNumber === incoming.rowNumber &&
    stored.sourceObjectType === incoming.sourceObjectType &&
    stored.sourceRecordId === incoming.sourceRecordId &&
    stored.sourceLocator === incoming.verifiedSourceLocator &&
    digestsEqual(stored.rowSha256, incoming.verifiedRowSha256) &&
    stored.rawEvidenceRef === incoming.verifiedRawEvidenceRef
  );
}

function actorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

async function writeVerifiedChunk(
  database: Database,
  actor: MigrationActor,
  expected: MigrationBatchLockContext,
  rows: readonly VerifiedStagedRow[],
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        actor,
        STAGE_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        actor,
        expected.migrationSourceId,
      );
      const [current] = await transaction
        .select(selectedBatchColumns())
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, actor.organizationId),
            eq(importBatches.businessUnitId, actor.businessUnitId),
            eq(importBatches.migrationSourceId, expected.migrationSourceId),
            eq(importBatches.id, expected.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) {
        throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      }
      assertStageableBatch(current);
      if (!batchEnvelopeMatches(current, expected)) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_CHANGED_DURING_VERIFICATION",
          "The import batch changed while protected row evidence was verified.",
        );
      }

      const sortedRows = [...rows].sort((left, right) =>
        left.sourceRowKey < right.sourceRowKey
          ? -1
          : left.sourceRowKey > right.sourceRowKey
            ? 1
            : 0,
      );
      const sourceKeys = sortedRows.map((row) => row.sourceRowKey);
      const existing =
        sourceKeys.length === 0
          ? []
          : await transaction
              .select({
                id: importRows.id,
                sourceRowKey: importRows.sourceRowKey,
                rowNumber: importRows.rowNumber,
                sourceObjectType: importRows.sourceObjectType,
                sourceRecordId: importRows.sourceRecordId,
                sourceLocator: importRows.sourceLocator,
                rowSha256: importRows.rowSha256,
                rawEvidenceRef: importRows.rawEvidenceRef,
              })
              .from(importRows)
              .where(
                and(
                  eq(importRows.organizationId, actor.organizationId),
                  eq(importRows.businessUnitId, actor.businessUnitId),
                  eq(importRows.batchId, current.id),
                  inArray(importRows.sourceRowKey, sourceKeys),
                ),
              )
              .orderBy(asc(importRows.sourceRowKey), asc(importRows.id))
              .for("update");
      const existingByKey = new Map(existing.map((row) => [row.sourceRowKey, row] as const));
      const newRows: VerifiedStagedRow[] = [];
      for (const row of sortedRows) {
        const stored = existingByKey.get(row.sourceRowKey);
        if (!stored) {
          newRows.push(row);
          continue;
        }
        if (!rowEnvelopeMatches(stored, row)) {
          throw new ApiError(
            409,
            "IMPORT_ROW_REPLAY_CONFLICT",
            "The source row key already binds another immutable evidence envelope.",
          );
        }
      }

      const nonNullNumbers = newRows
        .map((row) => row.rowNumber)
        .filter((value): value is bigint => value !== null);
      if (nonNullNumbers.length > 0) {
        const conflictingNumbers = await transaction
          .select({ sourceRowKey: importRows.sourceRowKey })
          .from(importRows)
          .where(
            and(
              eq(importRows.organizationId, actor.organizationId),
              eq(importRows.businessUnitId, actor.businessUnitId),
              eq(importRows.batchId, current.id),
              inArray(importRows.rowNumber, nonNullNumbers),
            ),
          )
          .orderBy(asc(importRows.rowNumber), asc(importRows.id))
          .for("update");
        if (conflictingNumbers.length > 0) {
          throw new ApiError(
            409,
            "IMPORT_ROW_NUMBER_DUPLICATE",
            "A row number already identifies another source row in this batch.",
          );
        }
      }

      const firstStageTransition = current.status === "REGISTERED";
      if (
        !batchStateSnapshotMatches(current, expected) &&
        (newRows.length > 0 || firstStageTransition)
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_CHANGED_DURING_VERIFICATION",
          "The import batch changed while protected row evidence was verified.",
        );
      }

      if (newRows.length > 0) {
        await transaction.insert(importRows).values(
          newRows.map((row) => ({
            organizationId: actor.organizationId,
            businessUnitId: actor.businessUnitId,
            batchId: current.id,
            sourceRowKey: row.sourceRowKey,
            rowNumber: row.rowNumber,
            sourceObjectType: row.sourceObjectType,
            sourceRecordId: row.sourceRecordId,
            sourceLocator: row.verifiedSourceLocator,
            rowSha256: row.verifiedRowSha256,
            rawEvidenceRef: row.verifiedRawEvidenceRef,
          })),
        );
      }

      if (newRows.length > 0 || firstStageTransition) {
        const nextTotalRowCount = safeCounterAdd(current.totalRowCount, newRows.length);
        const nextStagedRowCount = safeCounterAdd(current.stagedRowCount, newRows.length);
        const [updated] = await transaction
          .update(importBatches)
          .set({
            status: "STAGED",
            totalRowCount: nextTotalRowCount,
            stagedRowCount: nextStagedRowCount,
          })
          .where(
            and(
              eq(importBatches.organizationId, actor.organizationId),
              eq(importBatches.businessUnitId, actor.businessUnitId),
              eq(importBatches.id, current.id),
            ),
          )
          .returning({ version: importBatches.version });
        if (!updated) {
          throw new ApiError(409, "IMPORT_BATCH_CHANGED", "The import batch changed.");
        }
        const summary = {
          schemaVersion: 1,
          batchId: current.id,
          insertedRowCount: newRows.length,
          totalRowCount: nextTotalRowCount,
          stagedRowCount: nextStagedRowCount,
        };
        const eventActorType = actorType(actorEvidence.userType);
        await transaction.insert(auditEvents).values({
          organizationId: actor.organizationId,
          businessUnitId: actor.businessUnitId,
          actorType: eventActorType,
          actorUserId: actor.userId,
          action: "MIGRATION_IMPORT_ROWS_STAGED",
          targetType: "IMPORT_BATCH",
          targetId: current.id,
          outcome: "SUCCESS",
          reason: "PROTECTED_RAW_EVIDENCE_VERIFIED",
          correlationId: current.id,
          changeSummary: summary,
        });
        await transaction.insert(outboxEvents).values({
          organizationId: actor.organizationId,
          businessUnitId: actor.businessUnitId,
          eventType: "crm.migration.import_rows_staged",
          eventVersion: 1,
          aggregateType: "IMPORT_BATCH",
          aggregateId: current.id,
          aggregateVersion: updated.version,
          actorType: eventActorType,
          actorUserId: actor.userId,
          correlationId: current.id,
          payload: summary,
        });
      }
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        actor,
        STAGE_CAPABILITY,
      );
      void actorEvidence;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const constraint =
      error && typeof error === "object" && "constraint_name" in error
        ? (error as { constraint_name?: unknown }).constraint_name
        : undefined;
    if (constraint === "import_rows_source_key_unique") {
      throw new ApiError(
        409,
        "IMPORT_ROW_SOURCE_KEY_DUPLICATE",
        "A source row key already exists in this batch.",
      );
    }
    if (constraint === "import_rows_row_number_unique") {
      throw new ApiError(
        409,
        "IMPORT_ROW_NUMBER_DUPLICATE",
        "A row number already exists in this batch.",
      );
    }
    throw new ApiError(
      500,
      "IMPORT_ROW_STAGE_FAILED",
      "Protected import rows could not be staged.",
    );
  }
}

async function pullChunk(
  iterator: AsyncIterator<StagedSourceRow>,
): Promise<{ rows: StagedSourceRow[]; done: boolean }> {
  const rows: StagedSourceRow[] = [];
  try {
    while (rows.length < STAGING_CHUNK_SIZE) {
      const next = await iterator.next();
      if (next.done) return { rows, done: true };
      rows.push(next.value);
    }
    return { rows, done: false };
  } catch {
    throw new ApiError(
      422,
      "IMPORT_ROW_STREAM_FAILED",
      "The protected row stream could not be read.",
    );
  }
}

function safeCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(
      500,
      "IMPORT_ROW_SUMMARY_UNSAFE",
      "The import row summary exceeds the safe reporting range.",
    );
  }
  return value;
}

async function readSummary(
  database: Database,
  actor: MigrationActor,
  batchId: string,
): Promise<RowSummary> {
  const [batch] = await database
    .select({
      total: importBatches.totalRowCount,
      staged: importBatches.stagedRowCount,
      valid: importBatches.validRowCount,
      rejected: importBatches.rejectedRowCount,
      quarantined: importBatches.quarantinedRowCount,
      hidden: importBatches.hiddenRowCount,
      imported: importBatches.importedRowCount,
      noOp: importBatches.noOpRowCount,
    })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, actor.organizationId),
        eq(importBatches.businessUnitId, actor.businessUnitId),
        eq(importBatches.id, batchId),
      ),
    )
    .limit(1);
  if (!batch) {
    throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
  }
  return {
    totalRows: safeCounter(batch.total),
    stagedRows: safeCounter(batch.staged),
    validRows: safeCounter(batch.valid),
    rejectedRows: safeCounter(batch.rejected),
    quarantinedRows: safeCounter(batch.quarantined),
    hiddenRows: safeCounter(batch.hidden),
    importedRows: safeCounter(batch.imported),
    noOpRows: safeCounter(batch.noOp),
  };
}

export async function stageImportRows(
  actorInput: MigrationActor,
  batchIdInput: string,
  rows: AsyncIterable<StagedSourceRow>,
  evidenceVerifier: RawEvidenceVerifier,
): Promise<RowSummary> {
  const actor = validateMigrationActor(actorInput, STAGE_CAPABILITY);
  const batchId = canonicalUuid(batchIdInput, "batchId");
  if (!rows) {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "rows must be an asynchronous protected-row stream.",
    );
  }
  let openStream: () => AsyncIterator<StagedSourceRow>;
  try {
    const candidate = rows[Symbol.asyncIterator];
    if (typeof candidate !== "function") {
      throw new ApiError(
        422,
        "IMPORT_ROW_INPUT_INVALID",
        "rows must be an asynchronous protected-row stream.",
      );
    }
    openStream = candidate.bind(rows);
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "IMPORT_ROW_STREAM_FAILED",
      "The protected row stream could not be opened.",
    );
  }
  let verifyEvidence: RawEvidenceVerifier["verify"];
  try {
    const candidate = evidenceVerifier?.verify;
    if (typeof candidate !== "function") throw new Error();
    verifyEvidence = candidate.bind(evidenceVerifier);
  } catch {
    throw new ApiError(
      422,
      "IMPORT_ROW_INPUT_INVALID",
      "A raw evidence verifier is required.",
    );
  }
  const trustedVerifier: RawEvidenceVerifier = { verify: verifyEvidence };
  const database = getDatabase();
  const locator = await locateBatch(database, actor, batchId);
  let context = await loadBatchContext(database, actor, locator);
  let iterator: AsyncIterator<StagedSourceRow>;
  try {
    iterator = openStream();
    if (!iterator || typeof iterator.next !== "function") throw new Error();
  } catch {
    throw new ApiError(
      422,
      "IMPORT_ROW_STREAM_FAILED",
      "The protected row stream could not be opened.",
    );
  }
  let wroteChunk = false;
  let iteratorCompleted = false;

  try {
    while (true) {
      const pulled = await pullChunk(iterator);
      if (pulled.rows.length === 0) {
        if (!wroteChunk) await writeVerifiedChunk(database, actor, context, []);
        iteratorCompleted = true;
        break;
      }
      const canonicalRows = validateChunk(pulled.rows);
      const verifiedRows: VerifiedStagedRow[] = [];
      for (const row of canonicalRows) {
        verifiedRows.push(await verifyRow(row, context, trustedVerifier));
      }
      await writeVerifiedChunk(database, actor, context, verifiedRows);
      wroteChunk = true;
      if (pulled.done) {
        iteratorCompleted = true;
        break;
      }
      context = await loadBatchContext(database, actor, locator);
    }
  } finally {
    if (!iteratorCompleted) {
      try {
        const closeIterator = iterator.return;
        if (typeof closeIterator === "function") {
          await closeIterator.call(iterator);
        }
      } catch {
        // Preserve the primary validation/verifier/database failure.
      }
    }
  }

  return readSummary(database, actor, batchId);
}
