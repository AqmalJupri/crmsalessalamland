import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  migrationDomainAuthorities,
  migrationSourceScopes,
  migrationSources,
  transformVersions,
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
  computeSha256,
  digestsEqual,
} from "./artifact-checksum";
import type { MigrationActor, SourceArtifactStore } from "./contracts";

const SOURCE_CAPABILITY = "migration.source.manage";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

type Database = ReturnType<typeof getDatabase>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

interface CanonicalBatchCommand {
  actor: MigrationActor;
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

interface LockedTransform {
  id: string;
  sourceSchemaVersion: string;
  repairOfTransformId: string | null;
  approvedAt: Date | null;
}

interface LockedBatchEnvelope {
  id: string;
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
  operatorReason: string | null;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a UUID.`);
  }
}

function canonicalUuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value.toLowerCase();
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function datesEqual(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function validateCommand(
  actor: MigrationActor,
  input: RegisterImportBatchInput,
): CanonicalBatchCommand {
  if (!actor || typeof actor !== "object" || !input || typeof input !== "object") {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "The import batch registration command is invalid.",
    );
  }
  const canonicalActor: MigrationActor = {
    userId: canonicalUuid(actor.userId, "actor.userId"),
    organizationId: canonicalUuid(actor.organizationId, "actor.organizationId"),
    activeMembershipId: canonicalUuid(
      actor.activeMembershipId,
      "actor.activeMembershipId",
    ),
    businessUnitId: canonicalUuid(actor.businessUnitId, "actor.businessUnitId"),
    capabilities: [],
  };
  if (
    !Array.isArray(actor.capabilities) ||
    !actor.capabilities.every((capability) => typeof capability === "string")
  ) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "actor.capabilities must be an array of capability keys.",
    );
  }
  canonicalActor.capabilities = [...actor.capabilities];
  if (!canonicalActor.capabilities.includes(SOURCE_CAPABILITY)) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${SOURCE_CAPABILITY} capability is required.`,
    );
  }

  const businessUnitId = canonicalUuid(input.businessUnitId, "businessUnitId");
  const migrationSourceId = canonicalUuid(input.migrationSourceId, "migrationSourceId");
  const transformVersionId = canonicalUuid(
    input.transformVersionId,
    "transformVersionId",
  );
  if (businessUnitId !== canonicalActor.businessUnitId) {
    throw new ApiError(
      403,
      "MIGRATION_SCOPE_FORBIDDEN",
      "Switch the active business-unit context before registering an import batch.",
    );
  }
  assertProtectedArtifactRef(input.protectedArtifactRef, "protectedArtifactRef");
  assertSha256Digest(input.expectedSourceSha256, "expectedSourceSha256");
  if (
    typeof input.expectedSizeBytes !== "bigint" ||
    input.expectedSizeBytes < 0n ||
    input.expectedSizeBytes > MAX_POSTGRES_BIGINT
  ) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "expectedSizeBytes must be a non-negative PostgreSQL bigint.",
    );
  }
  if (!validDate(input.capturedAt) || !validDate(input.cutoffAt)) {
    throw new ApiError(
      422,
      "IMPORT_BATCH_TIME_INVALID",
      "Batch capture and cutoff times must be valid Date values.",
    );
  }
  const capturedAt = new Date(input.capturedAt.getTime());
  const cutoffAt = new Date(input.cutoffAt.getTime());
  if (cutoffAt.getTime() > capturedAt.getTime()) {
    throw new ApiError(
      422,
      "IMPORT_BATCH_TIME_INVALID",
      "The artifact cutoff cannot be later than capture time.",
    );
  }
  if (
    typeof input.schemaVersion !== "string" ||
    !SCHEMA_VERSION_PATTERN.test(input.schemaVersion)
  ) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "schemaVersion is invalid.");
  }
  if (typeof input.dryRun !== "boolean") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "dryRun must be a boolean.");
  }

  let validatedDryRunBatchId: string | null;
  if (input.validatedDryRunBatchId === null) {
    validatedDryRunBatchId = null;
  } else {
    validatedDryRunBatchId = canonicalUuid(
      input.validatedDryRunBatchId,
      "validatedDryRunBatchId",
    );
  }
  if (input.dryRun && validatedDryRunBatchId !== null) {
    throw new ApiError(
      422,
      "IMPORT_BATCH_DRY_RUN_FORBIDDEN",
      "A dry-run batch cannot reference another dry run.",
    );
  }
  if (!input.dryRun && validatedDryRunBatchId === null) {
    throw new ApiError(
      422,
      "IMPORT_BATCH_DRY_RUN_REQUIRED",
      "A live batch requires its completed matching dry run.",
    );
  }

  const repairOfBatchId =
    input.repairOfBatchId === null
      ? null
      : canonicalUuid(input.repairOfBatchId, "repairOfBatchId");
  let operatorReason: string | null = null;
  if (input.operatorReason !== null) {
    operatorReason =
      typeof input.operatorReason === "string" ? input.operatorReason.trim() : "";
    if (operatorReason.length < 1 || operatorReason.length > 2_000) {
      throw new ApiError(
        422,
        "MIGRATION_INPUT_INVALID",
        "operatorReason must be a bounded non-empty string when supplied.",
      );
    }
  }
  if (repairOfBatchId !== null && operatorReason === null) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "A reviewed operator reason is required for repair lineage.",
    );
  }

  return {
    actor: canonicalActor,
    businessUnitId,
    migrationSourceId,
    transformVersionId,
    protectedArtifactRef: input.protectedArtifactRef,
    expectedSourceSha256: new Uint8Array(input.expectedSourceSha256),
    expectedSizeBytes: input.expectedSizeBytes,
    capturedAt,
    cutoffAt,
    schemaVersion: input.schemaVersion,
    dryRun: input.dryRun,
    validatedDryRunBatchId,
    repairOfBatchId,
    operatorReason,
  };
}

async function requireActiveTenant(
  transaction: DatabaseTransaction,
  command: CanonicalBatchCommand,
): Promise<void> {
  const [organization] = await transaction
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, command.actor.organizationId),
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
        eq(businessUnits.organizationId, command.actor.organizationId),
        eq(businessUnits.id, command.businessUnitId),
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

async function requireActor(
  transaction: DatabaseTransaction,
  command: CanonicalBatchCommand,
): Promise<{ userType: "HUMAN" | "SERVICE" }> {
  const [actorEvidence] = await transaction
    .select({
      membershipBusinessUnitId: memberships.businessUnitId,
      userType: users.userType,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, command.actor.organizationId),
        eq(memberships.id, command.actor.activeMembershipId),
        eq(memberships.userId, command.actor.userId),
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
    actorEvidence.membershipBusinessUnitId !== command.businessUnitId
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
        eq(membershipRoles.organizationId, command.actor.organizationId),
        eq(membershipRoles.membershipId, command.actor.activeMembershipId),
        eq(roles.status, "ACTIVE"),
        eq(roleCapabilities.capabilityKey, SOURCE_CAPABILITY),
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
      `The ${SOURCE_CAPABILITY} capability is required.`,
    );
  }
  return { userType: actorEvidence.userType };
}

async function lockAndValidateSourceAuthority(
  transaction: DatabaseTransaction,
  command: CanonicalBatchCommand,
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
        eq(migrationDomainAuthorities.organizationId, command.actor.organizationId),
        eq(migrationDomainAuthorities.businessUnitId, command.businessUnitId),
        eq(migrationSourceScopes.migrationSourceId, command.migrationSourceId),
      ),
    )
    .orderBy(
      asc(migrationDomainAuthorities.businessUnitId),
      asc(migrationDomainAuthorities.domainKey),
      asc(migrationDomainAuthorities.id),
    )
    .for("share", { of: [migrationDomainAuthorities] });

  const [source] = await transaction
    .select({
      id: migrationSources.id,
      status: migrationSources.status,
    })
    .from(migrationSources)
    .where(
      and(
        eq(migrationSources.organizationId, command.actor.organizationId),
        eq(migrationSources.businessUnitId, command.businessUnitId),
        eq(migrationSources.id, command.migrationSourceId),
      ),
    )
    .for("update")
    .limit(1);
  if (!source) {
    throw new ApiError(404, "MIGRATION_SOURCE_NOT_FOUND", "Migration source not found.");
  }
  if (source.status !== "ACTIVE") {
    throw new ApiError(
      409,
      "MIGRATION_SOURCE_NOT_ACTIVE",
      "Only an active authority source can receive import batches.",
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
        eq(migrationSourceScopes.organizationId, command.actor.organizationId),
        eq(migrationSourceScopes.businessUnitId, command.businessUnitId),
        eq(migrationSourceScopes.migrationSourceId, command.migrationSourceId),
      ),
    )
    .orderBy(asc(migrationSourceScopes.domainKey), asc(migrationSourceScopes.id))
    .for("share");

  if (sourceScopes.length === 0) {
    throw new ApiError(
      409,
      "MIGRATION_SOURCE_NOT_ACTIVE",
      "The migration source has no active authority scopes.",
    );
  }
  if (sourceScopes.some((scope) => scope.scopeStatus !== "ACTIVE_AUTHORITY")) {
    throw new ApiError(
      409,
      "MIGRATION_SOURCE_NOT_ACTIVE",
      "Every source scope must remain active authority before batch registration.",
    );
  }
  if (lockedHeads.length !== sourceScopes.length) {
    throw new ApiError(
      409,
      "MIGRATION_SOURCE_NOT_ACTIVE",
      "The source no longer owns its complete authority-head inventory.",
    );
  }
  const headByScope = new Map(lockedHeads.map((head) => [head.scopeId, head] as const));
  for (const scope of sourceScopes) {
    const head = headByScope.get(scope.scopeId);
    if (
      !head ||
      head.businessUnitId !== command.businessUnitId ||
      head.authoritySourceScopeId !== scope.scopeId ||
      head.domainKey !== scope.domainKey ||
      head.canonicalTarget !== scope.canonicalTarget ||
      head.authorityState === "CANONICAL_WRITABLE"
    ) {
      throw new ApiError(
        409,
        "MIGRATION_SOURCE_NOT_ACTIVE",
        "The source authority-head lineage changed before batch registration.",
      );
    }
  }
}

async function requireTransform(
  transaction: DatabaseTransaction,
  command: CanonicalBatchCommand,
): Promise<LockedTransform> {
  const [transform] = await transaction
    .select({
      id: transformVersions.id,
      sourceSchemaVersion: transformVersions.sourceSchemaVersion,
      repairOfTransformId: transformVersions.repairOfTransformId,
      approvedAt: transformVersions.approvedAt,
    })
    .from(transformVersions)
    .where(
      and(
        eq(transformVersions.organizationId, command.actor.organizationId),
        eq(transformVersions.businessUnitId, command.businessUnitId),
        eq(transformVersions.migrationSourceId, command.migrationSourceId),
        eq(transformVersions.id, command.transformVersionId),
      ),
    )
    .for("share")
    .limit(1);
  if (!transform) {
    throw new ApiError(404, "MIGRATION_TRANSFORM_NOT_FOUND", "Transform version not found.");
  }
  if (
    transform.approvedAt === null ||
    transform.sourceSchemaVersion !== command.schemaVersion
  ) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_TRANSFORM_MISMATCH",
      "The approved transform does not match this artifact schema.",
    );
  }
  return transform;
}

function envelopeMatches(
  batch: LockedBatchEnvelope,
  command: CanonicalBatchCommand,
): boolean {
  return (
    batch.transformVersionId === command.transformVersionId &&
    batch.validatedDryRunBatchId === command.validatedDryRunBatchId &&
    batch.repairOfBatchId === command.repairOfBatchId &&
    batch.protectedArtifactRef === command.protectedArtifactRef &&
    digestsEqual(batch.sourceSha256, command.expectedSourceSha256) &&
    batch.sizeBytes === command.expectedSizeBytes &&
    datesEqual(batch.capturedAt, command.capturedAt) &&
    datesEqual(batch.cutoffAt, command.cutoffAt) &&
    batch.schemaVersion === command.schemaVersion &&
    batch.dryRun === command.dryRun &&
    batch.operatorReason === command.operatorReason
  );
}

async function requireDryRunLineage(
  transaction: DatabaseTransaction,
  command: CanonicalBatchCommand,
): Promise<void> {
  if (command.dryRun) return;
  const [dryRun] = await transaction
    .select({
      id: importBatches.id,
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
      operatorReason: importBatches.operatorReason,
    })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, command.actor.organizationId),
        eq(importBatches.businessUnitId, command.businessUnitId),
        eq(importBatches.migrationSourceId, command.migrationSourceId),
        eq(importBatches.id, command.validatedDryRunBatchId!),
      ),
    )
    .for("share")
    .limit(1);
  if (!dryRun) {
    throw new ApiError(
      404,
      "IMPORT_BATCH_DRY_RUN_NOT_FOUND",
      "The matching dry-run batch was not found.",
    );
  }
  if (!dryRun.dryRun || dryRun.status !== "DRY_RUN_COMPLETE") {
    throw new ApiError(
      409,
      "IMPORT_BATCH_DRY_RUN_INVALID",
      "The matching dry-run batch is not complete.",
    );
  }
  if (
    dryRun.transformVersionId !== command.transformVersionId ||
    dryRun.protectedArtifactRef !== command.protectedArtifactRef ||
    !digestsEqual(dryRun.sourceSha256, command.expectedSourceSha256) ||
    dryRun.sizeBytes !== command.expectedSizeBytes ||
    !datesEqual(dryRun.capturedAt, command.capturedAt) ||
    !datesEqual(dryRun.cutoffAt, command.cutoffAt) ||
    dryRun.schemaVersion !== command.schemaVersion
  ) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_DRY_RUN_MISMATCH",
      "The completed dry run does not bind this exact acquisition envelope.",
    );
  }
}

async function lockSameArtifactModeBatches(
  transaction: DatabaseTransaction,
  command: CanonicalBatchCommand,
): Promise<LockedBatchEnvelope[]> {
  return transaction
    .select({
      id: importBatches.id,
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
      operatorReason: importBatches.operatorReason,
    })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, command.actor.organizationId),
        eq(importBatches.businessUnitId, command.businessUnitId),
        eq(importBatches.migrationSourceId, command.migrationSourceId),
        eq(importBatches.sourceSha256, command.expectedSourceSha256),
        eq(importBatches.dryRun, command.dryRun),
      ),
    )
    .orderBy(asc(importBatches.createdAt), asc(importBatches.id))
    .for("share");
}

function requireRepairLineage(
  command: CanonicalBatchCommand,
  transform: LockedTransform,
  sameArtifactModeBatches: readonly LockedBatchEnvelope[],
): void {
  if (
    sameArtifactModeBatches.some(
      (batch) => batch.transformVersionId === command.transformVersionId,
    )
  ) {
    return;
  }
  const priorDifferentTransform = sameArtifactModeBatches.filter(
    (batch) => batch.transformVersionId !== command.transformVersionId,
  );
  if (priorDifferentTransform.length === 0 && command.repairOfBatchId === null) return;
  if (command.repairOfBatchId === null) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_REPAIR_REQUIRED",
      "Reprocessing this artifact with another transform requires repair lineage.",
    );
  }
  const repairTarget = priorDifferentTransform.find(
    (batch) => batch.id === command.repairOfBatchId,
  );
  if (!repairTarget) {
    throw new ApiError(
      404,
      "IMPORT_BATCH_REPAIR_TARGET_NOT_FOUND",
      "The requested prior batch repair target was not found.",
    );
  }
  if (
    transform.repairOfTransformId === null ||
    transform.repairOfTransformId !== repairTarget.transformVersionId ||
    repairTarget.protectedArtifactRef !== command.protectedArtifactRef ||
    !digestsEqual(repairTarget.sourceSha256, command.expectedSourceSha256) ||
    repairTarget.sizeBytes !== command.expectedSizeBytes ||
    !datesEqual(repairTarget.capturedAt, command.capturedAt) ||
    !datesEqual(repairTarget.cutoffAt, command.cutoffAt) ||
    repairTarget.schemaVersion !== command.schemaVersion ||
    repairTarget.dryRun !== command.dryRun
  ) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_REPAIR_LINEAGE_INVALID",
      "The transform and prior batch do not form exact repair lineage.",
    );
  }
}

function replayConflict(): never {
  throw new ApiError(
    409,
    "IMPORT_BATCH_IDEMPOTENCY_CONFLICT",
    "The checksum idempotency key already binds another acquisition envelope.",
  );
}

export async function registerImportBatch(
  actor: MigrationActor,
  input: RegisterImportBatchInput,
  artifactStore: SourceArtifactStore,
): Promise<{ batchId: string; replayed: boolean }> {
  const command = validateCommand(actor, input);
  let artifactSource: AsyncIterable<Uint8Array>;
  try {
    if (!artifactStore || typeof artifactStore.open !== "function") throw new Error();
    artifactSource = artifactStore.open(command.protectedArtifactRef);
  } catch {
    throw new ApiError(
      422,
      "ARTIFACT_READ_FAILED",
      "Protected source artifact could not be read.",
    );
  }
  const streamed = await computeSha256(artifactSource);
  if (!digestsEqual(streamed.sha256, command.expectedSourceSha256)) {
    throw new ApiError(
      422,
      "ARTIFACT_CHECKSUM_MISMATCH",
      "Streamed source checksum does not match the reviewed request.",
    );
  }
  if (streamed.sizeBytes !== command.expectedSizeBytes) {
    throw new ApiError(
      422,
      "ARTIFACT_SIZE_MISMATCH",
      "Streamed source size does not match the reviewed request.",
    );
  }

  const database = getDatabase();
  try {
    return await database.transaction(async (transaction) => {
      await requireActiveTenant(transaction, command);
      let actorEvidence = await requireActor(transaction, command);
      await lockAndValidateSourceAuthority(transaction, command);
      const transform = await requireTransform(transaction, command);
      await requireDryRunLineage(transaction, command);
      const sameArtifactModeBatches = await lockSameArtifactModeBatches(
        transaction,
        command,
      );
      requireRepairLineage(command, transform, sameArtifactModeBatches);
      actorEvidence = await requireActor(transaction, command);

      const [created] = await transaction
        .insert(importBatches)
        .values({
          organizationId: command.actor.organizationId,
          businessUnitId: command.businessUnitId,
          migrationSourceId: command.migrationSourceId,
          transformVersionId: command.transformVersionId,
          validatedDryRunBatchId: command.validatedDryRunBatchId,
          repairOfBatchId: command.repairOfBatchId,
          protectedArtifactRef: command.protectedArtifactRef,
          sourceSha256: command.expectedSourceSha256,
          sizeBytes: command.expectedSizeBytes,
          capturedAt: command.capturedAt,
          cutoffAt: command.cutoffAt,
          schemaVersion: command.schemaVersion,
          dryRun: command.dryRun,
          operatorReason: command.operatorReason,
        })
        .onConflictDoNothing({
          target: [
            importBatches.organizationId,
            importBatches.businessUnitId,
            importBatches.migrationSourceId,
            importBatches.sourceSha256,
            importBatches.transformVersionId,
            importBatches.dryRun,
          ],
        })
        .returning({ id: importBatches.id, createdAt: importBatches.createdAt });

      if (!created) {
        await lockAndValidateSourceAuthority(transaction, command);
        await requireActor(transaction, command);
        const [stored] = await transaction
          .select({
            id: importBatches.id,
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
            operatorReason: importBatches.operatorReason,
          })
          .from(importBatches)
          .where(
            and(
              eq(importBatches.organizationId, command.actor.organizationId),
              eq(importBatches.businessUnitId, command.businessUnitId),
              eq(importBatches.migrationSourceId, command.migrationSourceId),
              eq(importBatches.sourceSha256, command.expectedSourceSha256),
              eq(importBatches.transformVersionId, command.transformVersionId),
              eq(importBatches.dryRun, command.dryRun),
            ),
          )
          .for("share")
          .limit(1);
        if (!stored || !envelopeMatches(stored, command)) replayConflict();
        return { batchId: stored.id, replayed: true };
      }

      const sourceSha256Hex = Buffer.from(command.expectedSourceSha256).toString("hex");
      const eventSummary = {
        schemaVersion: 1,
        batchId: created.id,
        migrationSourceId: command.migrationSourceId,
        transformVersionId: command.transformVersionId,
        sourceSha256: sourceSha256Hex,
        dryRun: command.dryRun,
        validatedDryRunBatchId: command.validatedDryRunBatchId,
        repairOfBatchId: command.repairOfBatchId,
      };
      const eventActorType = actorEvidence.userType === "SERVICE" ? "SERVICE" : "USER";
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.businessUnitId,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_BATCH_REGISTERED",
        targetType: "IMPORT_BATCH",
        targetId: created.id,
        outcome: "SUCCESS",
        reason: "CHECKSUM_VERIFIED_SOURCE_ARTIFACT",
        correlationId: created.id,
        changeSummary: eventSummary,
        occurredAt: created.createdAt,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.businessUnitId,
        eventType: "crm.migration.import_batch_registered",
        eventVersion: 1,
        aggregateType: "IMPORT_BATCH",
        aggregateId: created.id,
        aggregateVersion: 1,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        correlationId: created.id,
        payload: eventSummary,
        occurredAt: created.createdAt,
      });
      return { batchId: created.id, replayed: false };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_BATCH_REGISTRATION_FAILED",
      "The import batch could not be registered.",
    );
  }
}
