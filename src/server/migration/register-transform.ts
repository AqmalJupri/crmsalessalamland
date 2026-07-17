import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import { migrationSources, transformVersions } from "@/server/db/migration-schema";
import {
  businessUnits,
  membershipRoles,
  memberships,
  organizations,
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
import type {
  MigrationActor,
  RegisterTransformVersionInput,
  ReviewedTransformRelease,
  ReviewedTransformReleaseRegistry,
  SourceArtifactStore,
} from "./contracts";

const SOURCE_CAPABILITY = "migration.source.manage";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SIGNING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLACEHOLDER_KEY_PATTERN = /(?:^|[._:-])(?:todo|tbd|placeholder|changeme|example)(?:$|[._:-])/i;

type Database = ReturnType<typeof getDatabase>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a UUID.`);
  }
}

function databaseConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ("constraint_name" in current && typeof current.constraint_name === "string") {
      return current.constraint_name;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function requireActor(
  transaction: DatabaseTransaction,
  actor: MigrationActor,
  businessUnitId: string,
): Promise<void> {
  const [evidence] = await transaction
    .select({ businessUnitId: memberships.businessUnitId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.id, actor.activeMembershipId),
        eq(memberships.organizationId, actor.organizationId),
        eq(memberships.userId, actor.userId),
        eq(memberships.status, "ACTIVE"),
        eq(users.status, "ACTIVE"),
        sql`${memberships.validFrom} <= clock_timestamp()`,
        sql`(${memberships.validUntil} is null or ${memberships.validUntil} >= clock_timestamp())`,
      ),
    )
    .limit(1)
    .for("share", { of: [memberships, users] });
  if (!evidence) {
    throw new ApiError(
      403,
      "MIGRATION_MEMBERSHIP_INVALID",
      "The active migration membership is no longer valid.",
    );
  }
  if (evidence.businessUnitId !== null && evidence.businessUnitId !== businessUnitId) {
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
        eq(roleCapabilities.capabilityKey, SOURCE_CAPABILITY),
        sql`${membershipRoles.validFrom} <= clock_timestamp()`,
        sql`(${membershipRoles.validUntil} is null or ${membershipRoles.validUntil} >= clock_timestamp())`,
      ),
    )
    .limit(1)
    .for("share", { of: [membershipRoles, roles, roleCapabilities] });
  if (!grant) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${SOURCE_CAPABILITY} capability is required.`,
    );
  }
}

async function requireSourceOwner(
  transaction: DatabaseTransaction,
  organizationId: string,
  businessUnitId: string,
  ownerMembershipId: string,
): Promise<void> {
  const [owner] = await transaction
    .select({ membershipId: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.id, ownerMembershipId),
        eq(memberships.organizationId, organizationId),
        eq(memberships.status, "ACTIVE"),
        eq(users.status, "ACTIVE"),
        sql`${memberships.validFrom} <= clock_timestamp()`,
        sql`(${memberships.validUntil} is null or ${memberships.validUntil} >= clock_timestamp())`,
        sql`(${memberships.businessUnitId} is null or ${memberships.businessUnitId} = ${businessUnitId})`,
      ),
    )
    .limit(1)
    .for("share", { of: [memberships, users] });
  if (!owner) {
    throw new ApiError(
      404,
      "MIGRATION_OWNER_NOT_FOUND",
      "The migration source no longer has an active owner.",
    );
  }
}

function validateCommand(actor: MigrationActor, input: RegisterTransformVersionInput): {
  sourceSchemaVersion: string;
  rationale: string;
} {
  if (!actor || typeof actor !== "object" || !input || typeof input !== "object") {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "The transform registration command is invalid.",
    );
  }
  assertUuid(actor.userId, "actor.userId");
  assertUuid(actor.organizationId, "actor.organizationId");
  assertUuid(actor.activeMembershipId, "actor.activeMembershipId");
  assertUuid(actor.businessUnitId, "actor.businessUnitId");
  assertUuid(input.businessUnitId, "businessUnitId");
  assertUuid(input.migrationSourceId, "migrationSourceId");
  if (input.repairOfTransformId !== null) {
    assertUuid(input.repairOfTransformId, "repairOfTransformId");
  }
  if (input.businessUnitId !== actor.businessUnitId) {
    throw new ApiError(
      403,
      "MIGRATION_SCOPE_FORBIDDEN",
      "Switch the active business-unit context before registering a transform.",
    );
  }
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
  if (!actor.capabilities.includes(SOURCE_CAPABILITY)) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${SOURCE_CAPABILITY} capability is required.`,
    );
  }
  if (!Number.isSafeInteger(input.versionNo) || input.versionNo < 1 || input.versionNo > 2_147_483_647) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "versionNo must be a positive integer.");
  }
  if (
    typeof input.sourceSchemaVersion !== "string" ||
    !SCHEMA_VERSION_PATTERN.test(input.sourceSchemaVersion)
  ) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "sourceSchemaVersion is invalid.");
  }
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale.length < 1 || rationale.length > 2_000) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "A bounded transform rationale is required.");
  }
  assertProtectedArtifactRef(input.mappingArtifactRef, "mappingArtifactRef");
  assertProtectedArtifactRef(input.releaseManifestRef, "releaseManifestRef");
  assertSha256Digest(input.expectedMappingSha256, "expectedMappingSha256");
  assertSha256Digest(input.expectedReleaseManifestSha256, "expectedReleaseManifestSha256");
  assertSha256Digest(input.expectedReleaseSha256, "expectedReleaseSha256");
  return { sourceSchemaVersion: input.sourceSchemaVersion, rationale };
}

function validateReviewedRelease(value: unknown): asserts value is ReviewedTransformRelease {
  if (!value || typeof value !== "object") {
    throw new ApiError(422, "TRANSFORM_RELEASE_INVALID", "Reviewed release is invalid.");
  }
  const release = value as Partial<ReviewedTransformRelease>;
  assertProtectedArtifactRef(release.manifestRef, "reviewedRelease.manifestRef");
  assertProtectedArtifactRef(release.mappingArtifactRef, "reviewedRelease.mappingArtifactRef");
  assertSha256Digest(release.manifestSha256, "reviewedRelease.manifestSha256");
  assertSha256Digest(release.mappingSha256, "reviewedRelease.mappingSha256");
  assertSha256Digest(release.releaseSha256, "reviewedRelease.releaseSha256");
  if (
    typeof release.sourceSchemaVersion !== "string" ||
    !SCHEMA_VERSION_PATTERN.test(release.sourceSchemaVersion) ||
    typeof release.gitCommitSha !== "string" ||
    !GIT_COMMIT_PATTERN.test(release.gitCommitSha) ||
    typeof release.signatureKeyId !== "string" ||
    !SIGNING_KEY_PATTERN.test(release.signatureKeyId) ||
    PLACEHOLDER_KEY_PATTERN.test(release.signatureKeyId)
  ) {
    throw new ApiError(
      422,
      "TRANSFORM_RELEASE_INVALID",
      "Reviewed release provenance is incomplete or invalid.",
    );
  }
}

export async function registerTransformVersion(
  actor: MigrationActor,
  input: RegisterTransformVersionInput,
  artifactStore: SourceArtifactStore,
  releaseRegistry: ReviewedTransformReleaseRegistry,
): Promise<string> {
  const canonical = validateCommand(actor, input);
  let artifactSource: AsyncIterable<Uint8Array>;
  try {
    if (!artifactStore || typeof artifactStore.open !== "function") throw new Error();
    artifactSource = artifactStore.open(input.mappingArtifactRef);
  } catch {
    throw new ApiError(
      422,
      "ARTIFACT_READ_FAILED",
      "Protected mapping artifact could not be read.",
    );
  }
  let streamed: Awaited<ReturnType<typeof computeSha256>>;
  try {
    streamed = await computeSha256(artifactSource);
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "ARTIFACT_READ_FAILED", "Protected mapping artifact could not be read.");
  }
  if (streamed.sizeBytes === 0n) {
    throw new ApiError(422, "MAPPING_ARTIFACT_EMPTY", "Reviewed mapping artifact is empty.");
  }
  if (!digestsEqual(streamed.sha256, input.expectedMappingSha256)) {
    throw new ApiError(
      422,
      "ARTIFACT_CHECKSUM_MISMATCH",
      "Streamed mapping checksum does not match the reviewed request.",
    );
  }

  let reviewed: unknown;
  try {
    reviewed = await releaseRegistry.getReviewedRelease(input.releaseManifestRef);
  } catch {
    throw new ApiError(
      422,
      "TRANSFORM_RELEASE_LOOKUP_FAILED",
      "Reviewed transform release could not be resolved.",
    );
  }
  validateReviewedRelease(reviewed);
  if (
    reviewed.manifestRef !== input.releaseManifestRef ||
    !digestsEqual(reviewed.manifestSha256, input.expectedReleaseManifestSha256) ||
    reviewed.mappingArtifactRef !== input.mappingArtifactRef ||
    !digestsEqual(reviewed.mappingSha256, streamed.sha256) ||
    reviewed.sourceSchemaVersion !== canonical.sourceSchemaVersion ||
    !digestsEqual(reviewed.releaseSha256, input.expectedReleaseSha256)
  ) {
    throw new ApiError(
      422,
      "TRANSFORM_RELEASE_MISMATCH",
      "The reviewed release does not bind this exact mapping envelope.",
    );
  }

  const database = getDatabase();
  try {
    return await database.transaction(async (transaction) => {
      const [organization] = await transaction
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, actor.organizationId), eq(organizations.status, "ACTIVE")))
        .limit(1)
        .for("share");
      if (!organization) {
        throw new ApiError(404, "MIGRATION_ORGANIZATION_NOT_FOUND", "Organization not found.");
      }
      const [businessUnit] = await transaction
        .select({ id: businessUnits.id })
        .from(businessUnits)
        .where(
          and(
            eq(businessUnits.id, input.businessUnitId),
            eq(businessUnits.organizationId, actor.organizationId),
            eq(businessUnits.status, "ACTIVE"),
          ),
        )
        .limit(1)
        .for("share");
      if (!businessUnit) {
        throw new ApiError(404, "MIGRATION_BUSINESS_UNIT_NOT_FOUND", "Business unit not found.");
      }
      await requireActor(transaction, actor, input.businessUnitId);

      const [source] = await transaction
        .select({
          id: migrationSources.id,
          ownerMembershipId: migrationSources.ownerMembershipId,
          status: migrationSources.status,
        })
        .from(migrationSources)
        .where(
          and(
            eq(migrationSources.id, input.migrationSourceId),
            eq(migrationSources.organizationId, actor.organizationId),
            eq(migrationSources.businessUnitId, input.businessUnitId),
          ),
        )
        .limit(1)
        .for("share");
      if (!source) {
        throw new ApiError(404, "MIGRATION_SOURCE_NOT_FOUND", "Migration source not found.");
      }
      if (source.status === "ARCHIVED_READ_ONLY") {
        throw new ApiError(
          409,
          "MIGRATION_SOURCE_ARCHIVED",
          "Archived migration sources cannot receive transform releases.",
        );
      }
      await requireSourceOwner(
        transaction,
        actor.organizationId,
        input.businessUnitId,
        source.ownerMembershipId,
      );

      if (input.repairOfTransformId) {
        const [repairOf] = await transaction
          .select({ versionNo: transformVersions.versionNo })
          .from(transformVersions)
          .where(
            and(
              eq(transformVersions.id, input.repairOfTransformId),
              eq(transformVersions.organizationId, actor.organizationId),
              eq(transformVersions.businessUnitId, input.businessUnitId),
              eq(transformVersions.migrationSourceId, input.migrationSourceId),
              sql`${transformVersions.approvedAt} is not null`,
            ),
          )
          .limit(1)
          .for("share");
        if (!repairOf) {
          throw new ApiError(404, "TRANSFORM_REPAIR_NOT_FOUND", "Approved repair target not found.");
        }
        if (input.versionNo <= repairOf.versionNo) {
          throw new ApiError(
            409,
            "TRANSFORM_REPAIR_VERSION_INVALID",
            "A repair release must advance the transform version.",
          );
        }
      }

      await requireActor(transaction, actor, input.businessUnitId);
      await requireSourceOwner(
        transaction,
        actor.organizationId,
        input.businessUnitId,
        source.ownerMembershipId,
      );

      const [transform] = await transaction
        .insert(transformVersions)
        .values({
          organizationId: actor.organizationId,
          businessUnitId: input.businessUnitId,
          migrationSourceId: input.migrationSourceId,
          versionNo: input.versionNo,
          sourceSchemaVersion: canonical.sourceSchemaVersion,
          mappingArtifactRef: input.mappingArtifactRef,
          mappingSha256: streamed.sha256,
          releaseManifestRef: input.releaseManifestRef,
          releaseManifestSha256: reviewed.manifestSha256,
          transformReleaseSha256: reviewed.releaseSha256,
          rationale: canonical.rationale,
          repairOfTransformId: input.repairOfTransformId,
          approvedByMembershipId: actor.activeMembershipId,
          approvedAt: sql`clock_timestamp()`,
        })
        .returning({ id: transformVersions.id });
      if (!transform) {
        throw new ApiError(500, "TRANSFORM_CREATE_FAILED", "Transform version was not stored.");
      }
      return transform.id;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    if (databaseConstraint(error) === "transform_versions_version_unique") {
      throw new ApiError(
        409,
        "TRANSFORM_VERSION_CONFLICT",
        "This source already has the requested transform version.",
      );
    }
    throw new ApiError(
      500,
      "TRANSFORM_REGISTRATION_FAILED",
      "The reviewed transform could not be registered.",
    );
  }
}
