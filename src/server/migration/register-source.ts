import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { assertAuthorityTransition } from "@/domain/migration/batch-lifecycle";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  migrationDomainAuthorities,
  migrationSourceScopes,
  migrationSources,
  reconciliationRuns,
  sourceAuthorityTransitionGroups,
  sourceAuthorityTransitions,
  type AuthorityState,
  type SourceKind,
  type SourceMode,
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
import { parseAuthorityDatabaseTimestamp } from "./database-timestamp";
import type {
  AuthorityTransitionGroupMemberInput,
  AuthorityTransitionGroupInput,
  AuthorityTransitionPlanVerifier,
  MigrationActor,
  RegisterMigrationSourceInput,
  VerifiedAuthorityTransitionPlan,
} from "./contracts";

const SOURCE_CAPABILITY = "migration.source.manage";
const AUTHORITY_CAPABILITY = "migration.authority_switch";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,126}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const AUTHORITY_STATES = new Set<AuthorityState>([
  "LEGACY_WRITABLE",
  "EXTERNAL_SYSTEM_AUTHORITY",
  "SHADOW_READ",
  "CANONICAL_WRITABLE",
]);
const SOURCE_KINDS = new Set<SourceKind>([
  "SALAM_CRM_JSON",
  "TASHA_SQLITE",
  "NIAGAWAN_CSV",
  "BARAKAH_SHEET",
]);

type Database = ReturnType<typeof getDatabase>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function normalizeKey(
  value: unknown,
  field: string,
  pattern: RegExp,
  maxLength = 127,
): string {
  if (typeof value !== "string") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a string.`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length > maxLength || !pattern.test(normalized)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} has an invalid format.`);
  }
  return normalized;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a UUID.`);
  }
}

function hasClaimedCapability(actor: MigrationActor, capability: string): boolean {
  return (
    Array.isArray(actor.capabilities) &&
    actor.capabilities.every((value) => typeof value === "string") &&
    actor.capabilities.includes(capability)
  );
}

async function requireActorCapability(
  transaction: DatabaseTransaction,
  actor: MigrationActor,
  capability: string,
  businessUnitId: string,
  requireOrganizationWide: boolean,
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
        eq(memberships.id, actor.activeMembershipId),
        eq(memberships.organizationId, actor.organizationId),
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
  if (
    (requireOrganizationWide && actorEvidence.membershipBusinessUnitId !== null) ||
    (!requireOrganizationWide &&
      actorEvidence.membershipBusinessUnitId !== null &&
      actorEvidence.membershipBusinessUnitId !== businessUnitId)
  ) {
    throw new ApiError(
      403,
      "MIGRATION_SCOPE_FORBIDDEN",
      "The active migration membership cannot manage this business-unit scope.",
    );
  }
  return { userType: actorEvidence.userType };
}

async function requireActiveSourceOwner(
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
        or(
          sql`${memberships.businessUnitId} is null`,
          eq(memberships.businessUnitId, businessUnitId),
        ),
      ),
    )
    .for("share", { of: [memberships, users] })
    .limit(1);
  if (!owner) {
    throw new ApiError(404, "MIGRATION_OWNER_NOT_FOUND", "Source owner not found.");
  }
}

function databaseConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ("constraint_name" in current && typeof current.constraint_name === "string") {
      return current.constraint_name;
    }
    if ("constraint" in current && typeof current.constraint === "string") {
      return current.constraint;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

interface CanonicalSourceDomain {
  domainKey: string;
  canonicalTarget: string;
  transitionMode: "ONE_TIME_CUTOVER" | "RECURRING_EXTERNAL_SNAPSHOT";
  initialAuthorityState: "LEGACY_WRITABLE" | "EXTERNAL_SYSTEM_AUTHORITY";
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface CanonicalAuthorityMember {
  domainAuthorityId: string;
  toState: AuthorityState;
  writeFrozenAt: Date | null;
  finalBatchId: string | null;
  expectedVersion: number;
}

interface CanonicalAuthorityCommand {
  actor: MigrationActor;
  cutoverGroupId: string;
  planArtifactRef: string;
  expectedPlanSha256: Uint8Array;
  members: readonly CanonicalAuthorityMember[];
  approvalReason: string;
  idempotencyKey: string;
}

interface CanonicalPlanMember {
  businessUnitId: string;
  domainAuthorityId: string;
  domainKey: string;
  toState: AuthorityState;
  writeFrozenAt: Date | null;
  finalBatchId: string | null;
}

interface CanonicalAuthorityPlan {
  artifactRef: string;
  planSha256: Uint8Array;
  organizationId: string;
  notBefore: Date;
  expiresAt: Date;
  requiredMembers: readonly CanonicalPlanMember[];
}

interface AuthorityTransitionResult {
  cutoverGroupId: string;
  transitionIds: readonly string[];
  effectiveAt: Date;
  replayed: boolean;
}

interface PreparedAuthorityTransition {
  businessUnitId: string;
  domainAuthorityId: string;
  domainKey: string;
  migrationSourceId: string;
  sourceMode: SourceMode;
  fromSourceScopeId: string;
  toSourceScopeId: string | null;
  fromState: AuthorityState;
  toState: AuthorityState;
  writeFrozenAt: Date | null;
  finalBatchId: string | null;
  finalCutoffAt: Date | null;
  expectedVersion: number;
}

function authorityInputInvalid(message: string): never {
  throw new ApiError(422, "MIGRATION_INPUT_INVALID", message);
}

function authorityPlanInvalid(message: string): never {
  throw new ApiError(422, "AUTHORITY_PLAN_INVALID", message);
}

function authorityEvidenceInvalid(status: 409 | 422, message: string): never {
  throw new ApiError(status, "AUTHORITY_EVIDENCE_INVALID", message);
}

function authorityIdempotencyConflict(): never {
  throw new ApiError(
    409,
    "AUTHORITY_IDEMPOTENCY_CONFLICT",
    "The authority transition keys already bind another request.",
  );
}

function canonicalUuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value.toLowerCase();
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function datesEqual(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function validateAuthorityEvidenceShape(
  toState: AuthorityState,
  writeFrozenAt: Date | null,
  finalBatchId: string | null,
  invalid: (message: string) => never,
): void {
  const canonical = toState === "CANONICAL_WRITABLE";
  if (
    (canonical && (writeFrozenAt === null || finalBatchId === null)) ||
    (!canonical && (writeFrozenAt !== null || finalBatchId !== null))
  ) {
    invalid(
      canonical
        ? "Canonical authority requires frozen-write and final-batch evidence."
        : "Noncanonical authority cannot carry final cutover evidence.",
    );
  }
}

function validateAuthorityCommand(
  actor: MigrationActor,
  input: AuthorityTransitionGroupInput,
): CanonicalAuthorityCommand {
  if (!actor || typeof actor !== "object" || !input || typeof input !== "object") {
    authorityInputInvalid("The authority transition command is invalid.");
  }
  const canonicalActor: MigrationActor = {
    userId: canonicalUuid(actor.userId, "actor.userId"),
    organizationId: canonicalUuid(actor.organizationId, "actor.organizationId"),
    activeMembershipId: canonicalUuid(actor.activeMembershipId, "actor.activeMembershipId"),
    businessUnitId: canonicalUuid(actor.businessUnitId, "actor.businessUnitId"),
    capabilities: [],
  };
  if (
    !Array.isArray(actor.capabilities) ||
    !actor.capabilities.every((capability) => typeof capability === "string")
  ) {
    authorityInputInvalid("actor.capabilities must be an array of capability keys.");
  }
  canonicalActor.capabilities = [...actor.capabilities];
  if (!hasClaimedCapability(canonicalActor, AUTHORITY_CAPABILITY)) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${AUTHORITY_CAPABILITY} capability is required.`,
    );
  }

  const cutoverGroupId = canonicalUuid(input.cutoverGroupId, "cutoverGroupId");
  assertProtectedArtifactRef(input.planArtifactRef, "planArtifactRef");
  assertSha256Digest(input.expectedPlanSha256, "expectedPlanSha256");
  if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 100) {
    authorityInputInvalid("Authority transition members must contain between 1 and 100 rows.");
  }

  const members = input.members.map((member, index): CanonicalAuthorityMember => {
    if (!member || typeof member !== "object") {
      authorityInputInvalid(`members[${index}] is invalid.`);
    }
    const candidate = member as AuthorityTransitionGroupMemberInput;
    const domainAuthorityId = canonicalUuid(
      candidate.domainAuthorityId,
      `members[${index}].domainAuthorityId`,
    );
    if (!AUTHORITY_STATES.has(candidate.toState)) {
      authorityInputInvalid(`members[${index}].toState is invalid.`);
    }
    if (candidate.writeFrozenAt !== null && !isValidDate(candidate.writeFrozenAt)) {
      authorityInputInvalid(`members[${index}].writeFrozenAt must be a valid Date or null.`);
    }
    const writeFrozenAt =
      candidate.writeFrozenAt === null ? null : new Date(candidate.writeFrozenAt.getTime());
    const finalBatchId =
      candidate.finalBatchId === null
        ? null
        : canonicalUuid(candidate.finalBatchId, `members[${index}].finalBatchId`);
    if (!Number.isSafeInteger(candidate.expectedVersion) || candidate.expectedVersion < 1) {
      authorityInputInvalid(`members[${index}].expectedVersion must be a positive safe integer.`);
    }
    validateAuthorityEvidenceShape(candidate.toState, writeFrozenAt, finalBatchId, (message) =>
      authorityEvidenceInvalid(422, message),
    );
    return {
      domainAuthorityId,
      toState: candidate.toState,
      writeFrozenAt,
      finalBatchId,
      expectedVersion: candidate.expectedVersion,
    };
  });
  if (new Set(members.map((member) => member.domainAuthorityId)).size !== members.length) {
    authorityPlanInvalid("Caller authority members must be duplicate-free.");
  }

  const approvalReason =
    typeof input.approvalReason === "string" ? input.approvalReason.trim() : "";
  if (approvalReason.length < 1 || approvalReason.length > 2_000) {
    authorityInputInvalid("A bounded authority approval reason is required.");
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length < 1 ||
    input.idempotencyKey.length > 255
  ) {
    authorityInputInvalid("A bounded authority idempotency key is required.");
  }

  return {
    actor: canonicalActor,
    cutoverGroupId,
    planArtifactRef: input.planArtifactRef,
    expectedPlanSha256: new Uint8Array(input.expectedPlanSha256),
    members: [...members].sort((left, right) =>
      compareAscii(left.domainAuthorityId, right.domainAuthorityId),
    ),
    approvalReason,
    idempotencyKey: input.idempotencyKey,
  };
}

function validateVerifiedAuthorityPlan(value: unknown): CanonicalAuthorityPlan {
  if (!value || typeof value !== "object") {
    authorityPlanInvalid("The reviewed authority plan is invalid.");
  }
  const plan = value as Partial<VerifiedAuthorityTransitionPlan>;
  assertProtectedArtifactRef(plan.artifactRef, "verifiedPlan.artifactRef");
  assertSha256Digest(plan.planSha256, "verifiedPlan.planSha256");
  const organizationId = canonicalUuid(plan.organizationId, "verifiedPlan.organizationId");
  if (!isValidDate(plan.notBefore) || !isValidDate(plan.expiresAt)) {
    authorityPlanInvalid("The reviewed authority execution window is invalid.");
  }
  const notBefore = new Date(plan.notBefore.getTime());
  const expiresAt = new Date(plan.expiresAt.getTime());
  if (notBefore.getTime() > expiresAt.getTime()) {
    authorityPlanInvalid("The reviewed authority execution window is inverted.");
  }
  if (
    !Array.isArray(plan.requiredMembers) ||
    plan.requiredMembers.length < 1 ||
    plan.requiredMembers.length > 100
  ) {
    authorityPlanInvalid("The reviewed authority member inventory is invalid.");
  }

  const requiredMembers = plan.requiredMembers.map((member, index): CanonicalPlanMember => {
    if (!member || typeof member !== "object") {
      authorityPlanInvalid(`verifiedPlan.requiredMembers[${index}] is invalid.`);
    }
    const candidate = member as VerifiedAuthorityTransitionPlan["requiredMembers"][number];
    const businessUnitId = canonicalUuid(
      candidate.businessUnitId,
      `verifiedPlan.requiredMembers[${index}].businessUnitId`,
    );
    const domainAuthorityId = canonicalUuid(
      candidate.domainAuthorityId,
      `verifiedPlan.requiredMembers[${index}].domainAuthorityId`,
    );
    if (
      typeof candidate.domainKey !== "string" ||
      candidate.domainKey.length > 127 ||
      !DOMAIN_PATTERN.test(candidate.domainKey)
    ) {
      authorityPlanInvalid(`verifiedPlan.requiredMembers[${index}].domainKey is invalid.`);
    }
    if (!AUTHORITY_STATES.has(candidate.toState)) {
      authorityPlanInvalid(`verifiedPlan.requiredMembers[${index}].toState is invalid.`);
    }
    if (candidate.writeFrozenAt !== null && !isValidDate(candidate.writeFrozenAt)) {
      authorityPlanInvalid(
        `verifiedPlan.requiredMembers[${index}].writeFrozenAt is invalid.`,
      );
    }
    const writeFrozenAt =
      candidate.writeFrozenAt === null ? null : new Date(candidate.writeFrozenAt.getTime());
    const finalBatchId =
      candidate.finalBatchId === null
        ? null
        : canonicalUuid(
            candidate.finalBatchId,
            `verifiedPlan.requiredMembers[${index}].finalBatchId`,
          );
    validateAuthorityEvidenceShape(candidate.toState, writeFrozenAt, finalBatchId, (message) =>
      authorityPlanInvalid(message),
    );
    return {
      businessUnitId,
      domainAuthorityId,
      domainKey: candidate.domainKey,
      toState: candidate.toState,
      writeFrozenAt,
      finalBatchId,
    };
  });
  const authorityIds = new Set(requiredMembers.map((member) => member.domainAuthorityId));
  const domainTuples = new Set(
    requiredMembers.map((member) => `${member.businessUnitId}\0${member.domainKey}`),
  );
  if (
    authorityIds.size !== requiredMembers.length ||
    domainTuples.size !== requiredMembers.length
  ) {
    authorityPlanInvalid("The reviewed authority member inventory contains duplicates.");
  }

  return {
    artifactRef: plan.artifactRef,
    planSha256: new Uint8Array(plan.planSha256),
    organizationId,
    notBefore,
    expiresAt,
    requiredMembers: [...requiredMembers].sort((left, right) =>
      compareAscii(left.domainAuthorityId, right.domainAuthorityId),
    ),
  };
}

function bindVerifiedAuthorityPlan(
  command: CanonicalAuthorityCommand,
  plan: CanonicalAuthorityPlan,
): void {
  if (
    plan.artifactRef !== command.planArtifactRef ||
    !digestsEqual(plan.planSha256, command.expectedPlanSha256) ||
    plan.organizationId !== command.actor.organizationId ||
    plan.requiredMembers.length !== command.members.length
  ) {
    authorityPlanInvalid("The reviewed authority plan does not bind this exact request.");
  }
  const callerByAuthority = new Map(
    command.members.map((member) => [member.domainAuthorityId, member] as const),
  );
  for (const signed of plan.requiredMembers) {
    const caller = callerByAuthority.get(signed.domainAuthorityId);
    if (
      !caller ||
      caller.toState !== signed.toState ||
      !datesEqual(caller.writeFrozenAt, signed.writeFrozenAt) ||
      caller.finalBatchId !== signed.finalBatchId
    ) {
      authorityPlanInvalid("The reviewed authority plan member set does not match the caller.");
    }
  }
}

function canonicalAuthorityGroupDigest(command: CanonicalAuthorityCommand): Uint8Array {
  const members = command.members.map((member) => ({
    domainAuthorityId: member.domainAuthorityId,
    toState: member.toState,
    writeFrozenAt: member.writeFrozenAt?.toISOString() ?? null,
    finalBatchId: member.finalBatchId,
    expectedVersion: member.expectedVersion,
  }));
  const canonicalJson = JSON.stringify({
    organizationId: command.actor.organizationId,
    cutoverGroupId: command.cutoverGroupId,
    idempotencyKey: command.idempotencyKey,
    planArtifactRef: command.planArtifactRef,
    planSha256Hex: Buffer.from(command.expectedPlanSha256).toString("hex"),
    approvalReason: command.approvalReason,
    members,
  });
  return createHash("sha256").update(canonicalJson, "utf8").digest();
}

async function findAuthorityReplay(
  transaction: DatabaseTransaction,
  command: CanonicalAuthorityCommand,
  plan: CanonicalAuthorityPlan,
  groupSha256: Uint8Array,
): Promise<AuthorityTransitionResult | null> {
  const groups = await transaction
    .select({
      id: sourceAuthorityTransitionGroups.id,
      idempotencyKey: sourceAuthorityTransitionGroups.idempotencyKey,
      groupSize: sourceAuthorityTransitionGroups.groupSize,
      groupSha256: sourceAuthorityTransitionGroups.groupSha256,
      planArtifactRef: sourceAuthorityTransitionGroups.planArtifactRef,
      planSha256: sourceAuthorityTransitionGroups.planSha256,
      effectiveAt: sourceAuthorityTransitionGroups.effectiveAt,
      approvedByMembershipId: sourceAuthorityTransitionGroups.approvedByMembershipId,
      approvalReason: sourceAuthorityTransitionGroups.approvalReason,
    })
    .from(sourceAuthorityTransitionGroups)
    .where(
      and(
        eq(sourceAuthorityTransitionGroups.organizationId, command.actor.organizationId),
        or(
          eq(sourceAuthorityTransitionGroups.id, command.cutoverGroupId),
          eq(sourceAuthorityTransitionGroups.idempotencyKey, command.idempotencyKey),
        ),
      ),
    )
    .orderBy(asc(sourceAuthorityTransitionGroups.id))
    .for("share");
  if (groups.length === 0) return null;
  if (groups.length !== 1) authorityIdempotencyConflict();

  const group = groups[0]!;
  if (
    group.id !== command.cutoverGroupId ||
    group.idempotencyKey !== command.idempotencyKey ||
    group.groupSize !== command.members.length ||
    !digestsEqual(group.groupSha256, groupSha256) ||
    group.planArtifactRef !== command.planArtifactRef ||
    !digestsEqual(group.planSha256, command.expectedPlanSha256) ||
    group.approvedByMembershipId !== command.actor.activeMembershipId ||
    group.approvalReason !== command.approvalReason
  ) {
    authorityIdempotencyConflict();
  }

  const transitions = await transaction
    .select({
      id: sourceAuthorityTransitions.id,
      businessUnitId: sourceAuthorityTransitions.businessUnitId,
      domainAuthorityId: sourceAuthorityTransitions.domainAuthorityId,
      fromSourceScopeId: sourceAuthorityTransitions.fromSourceScopeId,
      toSourceScopeId: sourceAuthorityTransitions.toSourceScopeId,
      fromState: sourceAuthorityTransitions.fromState,
      toState: sourceAuthorityTransitions.toState,
      writeFrozenAt: sourceAuthorityTransitions.writeFrozenAt,
      finalBatchId: sourceAuthorityTransitions.finalBatchId,
      finalCutoffAt: sourceAuthorityTransitions.finalCutoffAt,
    })
    .from(sourceAuthorityTransitions)
    .where(
      and(
        eq(sourceAuthorityTransitions.organizationId, command.actor.organizationId),
        eq(sourceAuthorityTransitions.transitionGroupId, command.cutoverGroupId),
      ),
    )
    .orderBy(asc(sourceAuthorityTransitions.domainAuthorityId))
    .for("share");
  if (transitions.length !== command.members.length) authorityIdempotencyConflict();

  const lineages = await transaction
    .select({
      transitionId: sourceAuthorityTransitions.id,
      authorityId: migrationDomainAuthorities.id,
      authorityDomainKey: migrationDomainAuthorities.domainKey,
      authorityCanonicalTarget: migrationDomainAuthorities.canonicalTarget,
      scopeId: migrationSourceScopes.id,
      scopeBusinessUnitId: migrationSourceScopes.businessUnitId,
      scopeDomainKey: migrationSourceScopes.domainKey,
      scopeCanonicalTarget: migrationSourceScopes.canonicalTarget,
      migrationSourceId: migrationSourceScopes.migrationSourceId,
      sourceMode: migrationSources.sourceMode,
      finalBatchId: importBatches.id,
      finalBatchBusinessUnitId: importBatches.businessUnitId,
      finalBatchMigrationSourceId: importBatches.migrationSourceId,
      finalBatchDryRun: importBatches.dryRun,
      finalBatchStatus: importBatches.status,
      finalBatchCutoffAt: importBatches.cutoffAt,
    })
    .from(sourceAuthorityTransitions)
    .innerJoin(
      migrationDomainAuthorities,
      and(
        eq(
          migrationDomainAuthorities.organizationId,
          sourceAuthorityTransitions.organizationId,
        ),
        eq(
          migrationDomainAuthorities.businessUnitId,
          sourceAuthorityTransitions.businessUnitId,
        ),
        eq(migrationDomainAuthorities.id, sourceAuthorityTransitions.domainAuthorityId),
      ),
    )
    .innerJoin(
      migrationSourceScopes,
      and(
        eq(migrationSourceScopes.organizationId, sourceAuthorityTransitions.organizationId),
        eq(migrationSourceScopes.businessUnitId, sourceAuthorityTransitions.businessUnitId),
        eq(migrationSourceScopes.id, sourceAuthorityTransitions.fromSourceScopeId),
      ),
    )
    .innerJoin(
      migrationSources,
      and(
        eq(migrationSources.organizationId, migrationSourceScopes.organizationId),
        eq(migrationSources.businessUnitId, migrationSourceScopes.businessUnitId),
        eq(migrationSources.id, migrationSourceScopes.migrationSourceId),
      ),
    )
    .leftJoin(
      importBatches,
      and(
        eq(importBatches.organizationId, sourceAuthorityTransitions.organizationId),
        eq(importBatches.businessUnitId, sourceAuthorityTransitions.businessUnitId),
        eq(importBatches.id, sourceAuthorityTransitions.finalBatchId),
      ),
    )
    .where(
      and(
        eq(sourceAuthorityTransitions.organizationId, command.actor.organizationId),
        eq(sourceAuthorityTransitions.transitionGroupId, command.cutoverGroupId),
      ),
    )
    .orderBy(asc(sourceAuthorityTransitions.domainAuthorityId));
  if (lineages.length !== transitions.length) authorityIdempotencyConflict();

  const signedByAuthority = new Map(
    plan.requiredMembers.map((member) => [member.domainAuthorityId, member] as const),
  );
  for (let index = 0; index < command.members.length; index += 1) {
    const requested = command.members[index]!;
    const stored = transitions[index];
    const lineage = lineages[index];
    const signed = signedByAuthority.get(requested.domainAuthorityId);
    if (
      !stored ||
      !lineage ||
      !signed ||
      lineage.transitionId !== stored.id ||
      lineage.authorityId !== requested.domainAuthorityId ||
      stored.domainAuthorityId !== requested.domainAuthorityId ||
      stored.businessUnitId !== signed.businessUnitId ||
      stored.fromSourceScopeId === null ||
      stored.fromSourceScopeId !== lineage.scopeId ||
      stored.toState !== requested.toState ||
      !datesEqual(stored.writeFrozenAt, requested.writeFrozenAt) ||
      stored.finalBatchId !== requested.finalBatchId ||
      lineage.scopeBusinessUnitId !== stored.businessUnitId ||
      lineage.scopeDomainKey !== signed.domainKey ||
      lineage.scopeDomainKey !== lineage.authorityDomainKey ||
      lineage.scopeCanonicalTarget !== lineage.authorityCanonicalTarget
    ) {
      authorityIdempotencyConflict();
    }
    try {
      assertAuthorityTransition({
        sourceMode: lineage.sourceMode,
        from: stored.fromState,
        to: stored.toState,
        cutoverApproved: true,
      });
    } catch {
      authorityIdempotencyConflict();
    }
    if (stored.toState === "CANONICAL_WRITABLE") {
      if (
        stored.toSourceScopeId !== null ||
        stored.writeFrozenAt === null ||
        stored.finalBatchId === null ||
        stored.finalCutoffAt === null ||
        lineage.finalBatchId !== stored.finalBatchId ||
        lineage.finalBatchBusinessUnitId !== stored.businessUnitId ||
        lineage.finalBatchMigrationSourceId !== lineage.migrationSourceId ||
        lineage.finalBatchDryRun !== false ||
        lineage.finalBatchStatus !== "RECONCILED" ||
        lineage.finalBatchCutoffAt === null ||
        !datesEqual(stored.finalCutoffAt, lineage.finalBatchCutoffAt) ||
        stored.writeFrozenAt.getTime() > lineage.finalBatchCutoffAt.getTime() ||
        lineage.finalBatchCutoffAt.getTime() > group.effectiveAt.getTime()
      ) {
        authorityIdempotencyConflict();
      }
    } else if (
      stored.toSourceScopeId !== stored.fromSourceScopeId ||
      stored.finalBatchId !== null ||
      stored.finalCutoffAt !== null ||
      lineage.finalBatchId !== null
    ) {
      authorityIdempotencyConflict();
    }
  }

  return {
    cutoverGroupId: group.id,
    transitionIds: transitions.map((transition) => transition.id),
    effectiveAt: group.effectiveAt,
    replayed: true,
  };
}

function validateSourceCommand(
  actor: MigrationActor,
  input: RegisterMigrationSourceInput,
): {
  sourceKey: string;
  domains: readonly CanonicalSourceDomain[];
} {
  if (!actor || typeof actor !== "object" || !input || typeof input !== "object") {
    authorityInputInvalid("The migration source registration command is invalid.");
  }
  assertUuid(actor.userId, "actor.userId");
  assertUuid(actor.organizationId, "actor.organizationId");
  assertUuid(actor.activeMembershipId, "actor.activeMembershipId");
  assertUuid(actor.businessUnitId, "actor.businessUnitId");
  assertUuid(input.businessUnitId, "businessUnitId");
  assertUuid(input.ownerMembershipId, "ownerMembershipId");
  if (input.businessUnitId !== actor.businessUnitId) {
    throw new ApiError(
      403,
      "MIGRATION_SCOPE_FORBIDDEN",
      "Switch the active business-unit context before registering a source.",
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
  if (!hasClaimedCapability(actor, SOURCE_CAPABILITY)) {
    throw new ApiError(
      403,
      "MIGRATION_CAPABILITY_REQUIRED",
      `The ${SOURCE_CAPABILITY} capability is required.`,
    );
  }
  if (!SOURCE_KINDS.has(input.sourceKind)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "sourceKind is invalid.");
  }
  if (
    input.sourceMode !== "ONE_TIME_MIGRATION" &&
    input.sourceMode !== "RECURRING_READ_ONLY_SNAPSHOT"
  ) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "sourceMode is invalid.");
  }
  if (!Array.isArray(input.domains) || input.domains.length < 1 || input.domains.length > 100) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "At least one bounded migration domain is required.",
    );
  }

  const domains = input.domains.map((domain, index) => {
    if (!domain || typeof domain !== "object") {
      throw new ApiError(422, "MIGRATION_INPUT_INVALID", `domains[${index}] is invalid.`);
    }
    const canonical: CanonicalSourceDomain = {
      domainKey: normalizeKey(
        domain.domainKey,
        `domains[${index}].domainKey`,
        DOMAIN_PATTERN,
      ),
      canonicalTarget: normalizeKey(
        domain.canonicalTarget,
        `domains[${index}].canonicalTarget`,
        DOMAIN_PATTERN,
      ),
      transitionMode: domain.transitionMode,
      initialAuthorityState: domain.initialAuthorityState,
    };
    const validPair =
      (input.sourceMode === "ONE_TIME_MIGRATION" &&
        canonical.transitionMode === "ONE_TIME_CUTOVER" &&
        canonical.initialAuthorityState === "LEGACY_WRITABLE") ||
      (input.sourceMode === "RECURRING_READ_ONLY_SNAPSHOT" &&
        canonical.transitionMode === "RECURRING_EXTERNAL_SNAPSHOT" &&
        canonical.initialAuthorityState === "EXTERNAL_SYSTEM_AUTHORITY");
    if (!validPair) {
      throw new ApiError(
        422,
        "MIGRATION_SOURCE_MODE_INVALID",
        "Source mode, transition mode, and initial authority state do not match.",
      );
    }
    return canonical;
  });
  const domainKeys = new Set(domains.map((domain) => domain.domainKey));
  if (domainKeys.size !== domains.length) {
    throw new ApiError(
      422,
      "MIGRATION_DOMAIN_DUPLICATE",
      "Migration domains must be duplicate-free after canonicalization.",
    );
  }
  return {
    sourceKey: normalizeKey(input.sourceKey, "sourceKey", SOURCE_KEY_PATTERN),
    domains: [...domains].sort((left, right) =>
      compareAscii(left.domainKey, right.domainKey),
    ),
  };
}

export async function registerMigrationSource(
  actor: MigrationActor,
  input: RegisterMigrationSourceInput,
): Promise<string> {
  const canonical = validateSourceCommand(actor, input);
  const database = getDatabase();
  try {
    return await database.transaction(async (transaction) => {
      const [organization] = await transaction
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, actor.organizationId), eq(organizations.status, "ACTIVE")))
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
            eq(businessUnits.id, input.businessUnitId),
            eq(businessUnits.organizationId, actor.organizationId),
            eq(businessUnits.status, "ACTIVE"),
          ),
        )
        .for("share")
        .limit(1);
      if (!businessUnit) {
        throw new ApiError(404, "MIGRATION_BUSINESS_UNIT_NOT_FOUND", "Business unit not found.");
      }
      await requireActorCapability(
        transaction,
        actor,
        SOURCE_CAPABILITY,
        input.businessUnitId,
        false,
      );

      await requireActiveSourceOwner(
        transaction,
        actor.organizationId,
        input.businessUnitId,
        input.ownerMembershipId,
      );

      const [canonicalTransition] = await transaction
        .select({ id: sourceAuthorityTransitionGroups.id })
        .from(sourceAuthorityTransitionGroups)
        .innerJoin(
          sourceAuthorityTransitions,
          and(
            eq(sourceAuthorityTransitions.organizationId, sourceAuthorityTransitionGroups.organizationId),
            eq(sourceAuthorityTransitions.transitionGroupId, sourceAuthorityTransitionGroups.id),
            eq(sourceAuthorityTransitions.toState, "CANONICAL_WRITABLE"),
          ),
        )
        .where(eq(sourceAuthorityTransitionGroups.organizationId, actor.organizationId))
        .limit(1);

      await requireActorCapability(
        transaction,
        actor,
        SOURCE_CAPABILITY,
        input.businessUnitId,
        false,
      );
      await requireActiveSourceOwner(
        transaction,
        actor.organizationId,
        input.businessUnitId,
        input.ownerMembershipId,
      );

      const [source] = await transaction
        .insert(migrationSources)
        .values({
          organizationId: actor.organizationId,
          businessUnitId: input.businessUnitId,
          sourceKey: canonical.sourceKey,
          sourceKind: input.sourceKind,
          sourceMode: input.sourceMode,
          ownerMembershipId: input.ownerMembershipId,
          status: "REGISTERED",
        })
        .returning({ id: migrationSources.id });
      if (!source) {
        throw new ApiError(500, "MIGRATION_SOURCE_CREATE_FAILED", "Migration source was not stored.");
      }

      let activeScopeCount = 0;
      for (const domain of canonical.domains) {
        const [existingHead] = await transaction
          .select({ canonicalTarget: migrationDomainAuthorities.canonicalTarget })
          .from(migrationDomainAuthorities)
          .where(
            and(
              eq(migrationDomainAuthorities.organizationId, actor.organizationId),
              eq(migrationDomainAuthorities.businessUnitId, input.businessUnitId),
              eq(migrationDomainAuthorities.domainKey, domain.domainKey),
            ),
          )
          .limit(1);
        if (existingHead && existingHead.canonicalTarget !== domain.canonicalTarget) {
          throw new ApiError(
            409,
            "MIGRATION_DOMAIN_CONFLICT",
            "The durable migration domain uses another canonical target.",
          );
        }
        if (!existingHead && canonicalTransition) {
          throw new ApiError(
            409,
            "MIGRATION_POST_CUTOVER_DOMAIN_FORBIDDEN",
            "A new source-authority domain cannot be opened after canonical cutover.",
          );
        }

        const [scope] = await transaction
          .insert(migrationSourceScopes)
          .values({
            organizationId: actor.organizationId,
            businessUnitId: input.businessUnitId,
            migrationSourceId: source.id,
            domainKey: domain.domainKey,
            canonicalTarget: domain.canonicalTarget,
            transitionMode: domain.transitionMode,
            sourceStatus: "REGISTERED",
          })
          .returning({ id: migrationSourceScopes.id });
        if (!scope) {
          throw new ApiError(500, "MIGRATION_SCOPE_CREATE_FAILED", "Migration scope was not stored.");
        }

        if (!existingHead) {
          const [claimed] = await transaction
            .insert(migrationDomainAuthorities)
            .values({
              organizationId: actor.organizationId,
              businessUnitId: input.businessUnitId,
              domainKey: domain.domainKey,
              canonicalTarget: domain.canonicalTarget,
              authorityState: domain.initialAuthorityState,
              authoritySourceScopeId: scope.id,
            })
            .onConflictDoNothing({
              target: [
                migrationDomainAuthorities.organizationId,
                migrationDomainAuthorities.businessUnitId,
                migrationDomainAuthorities.domainKey,
              ],
            })
            .returning({ id: migrationDomainAuthorities.id });
          if (claimed) {
            await transaction
              .update(migrationSourceScopes)
              .set({ sourceStatus: "ACTIVE_AUTHORITY" })
              .where(eq(migrationSourceScopes.id, scope.id));
            activeScopeCount += 1;
          } else {
            const [winner] = await transaction
              .select({ canonicalTarget: migrationDomainAuthorities.canonicalTarget })
              .from(migrationDomainAuthorities)
              .where(
                and(
                  eq(migrationDomainAuthorities.organizationId, actor.organizationId),
                  eq(migrationDomainAuthorities.businessUnitId, input.businessUnitId),
                  eq(migrationDomainAuthorities.domainKey, domain.domainKey),
                ),
              )
              .limit(1);
            if (!winner || winner.canonicalTarget !== domain.canonicalTarget) {
              throw new ApiError(
                409,
                "MIGRATION_DOMAIN_CONFLICT",
                "A concurrent source claimed the domain with incompatible metadata.",
              );
            }
          }
        }
      }

      await requireActorCapability(
        transaction,
        actor,
        SOURCE_CAPABILITY,
        input.businessUnitId,
        false,
      );
      await requireActiveSourceOwner(
        transaction,
        actor.organizationId,
        input.businessUnitId,
        input.ownerMembershipId,
      );
      if (activeScopeCount > 0) {
        await transaction
          .update(migrationSources)
          .set({ status: "ACTIVE" })
          .where(eq(migrationSources.id, source.id));
      }
      return source.id;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    if (databaseConstraint(error) === "migration_sources_source_unique") {
      throw new ApiError(
        409,
        "MIGRATION_SOURCE_CONFLICT",
        "A migration source already uses this key.",
      );
    }
    throw new ApiError(
      500,
      "MIGRATION_SOURCE_REGISTRATION_FAILED",
      "The migration source could not be registered.",
    );
  }
}

export async function transitionSourceAuthorityGroup(
  actor: MigrationActor,
  input: AuthorityTransitionGroupInput,
  planVerifier: AuthorityTransitionPlanVerifier,
): Promise<AuthorityTransitionResult> {
  const command = validateAuthorityCommand(actor, input);
  if (!planVerifier || typeof planVerifier.verify !== "function") {
    authorityInputInvalid("An authority plan verifier is required.");
  }

  let untrustedPlan: unknown;
  try {
    untrustedPlan = await planVerifier.verify(
      command.planArtifactRef,
      new Uint8Array(command.expectedPlanSha256),
    );
  } catch {
    throw new ApiError(
      422,
      "AUTHORITY_PLAN_VERIFICATION_FAILED",
      "The reviewed authority plan could not be verified.",
    );
  }
  const plan = validateVerifiedAuthorityPlan(untrustedPlan);
  bindVerifiedAuthorityPlan(command, plan);
  const groupSha256 = canonicalAuthorityGroupDigest(command);
  const memberByAuthority = new Map(
    command.members.map((member) => [member.domainAuthorityId, member] as const),
  );
  const signedByAuthority = new Map(
    plan.requiredMembers.map((member) => [member.domainAuthorityId, member] as const),
  );

  const database = getDatabase();
  try {
    return await database.transaction(async (transaction) => {
      const [organization] = await transaction
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.id, command.actor.organizationId),
            eq(organizations.status, "ACTIVE"),
          ),
        )
        .for("update")
        .limit(1);
      if (!organization) {
        throw new ApiError(
          404,
          "MIGRATION_ORGANIZATION_NOT_FOUND",
          "Organization not found.",
        );
      }

      let actorEvidence = await requireActorCapability(
        transaction,
        command.actor,
        AUTHORITY_CAPABILITY,
        command.actor.businessUnitId,
        true,
      );
      const replay = await findAuthorityReplay(
        transaction,
        command,
        plan,
        groupSha256,
      );
      if (replay) {
        await requireActorCapability(
          transaction,
          command.actor,
          AUTHORITY_CAPABILITY,
          command.actor.businessUnitId,
          true,
        );
        return replay;
      }

      const heads = await transaction
        .select({
          id: migrationDomainAuthorities.id,
          businessUnitId: migrationDomainAuthorities.businessUnitId,
          businessUnitStatus: businessUnits.status,
          domainKey: migrationDomainAuthorities.domainKey,
          canonicalTarget: migrationDomainAuthorities.canonicalTarget,
          authorityState: migrationDomainAuthorities.authorityState,
          authoritySourceScopeId: migrationDomainAuthorities.authoritySourceScopeId,
          version: migrationDomainAuthorities.version,
        })
        .from(migrationDomainAuthorities)
        .innerJoin(
          businessUnits,
          and(
            eq(businessUnits.organizationId, migrationDomainAuthorities.organizationId),
            eq(businessUnits.id, migrationDomainAuthorities.businessUnitId),
          ),
        )
        .where(
          and(
            eq(migrationDomainAuthorities.organizationId, command.actor.organizationId),
            sql`${migrationDomainAuthorities.authorityState} <> 'CANONICAL_WRITABLE'`,
          ),
        )
        .orderBy(
          asc(migrationDomainAuthorities.businessUnitId),
          asc(migrationDomainAuthorities.domainKey),
          asc(migrationDomainAuthorities.id),
        )
        .for("update", { of: [migrationDomainAuthorities, businessUnits] });

      if (
        heads.length !== command.members.length ||
        heads.some((head) => !memberByAuthority.has(head.id))
      ) {
        throw new ApiError(
          409,
          "AUTHORITY_INVENTORY_MISMATCH",
          "The signed plan does not cover the current noncanonical authority inventory.",
        );
      }

      const authorityIds = heads.map((head) => head.id);
      const lockedScopes = await transaction
        .select({
          authorityId: migrationDomainAuthorities.id,
          businessUnitId: migrationSourceScopes.businessUnitId,
          scopeId: migrationSourceScopes.id,
          scopeDomainKey: migrationSourceScopes.domainKey,
          scopeCanonicalTarget: migrationSourceScopes.canonicalTarget,
          scopeStatus: migrationSourceScopes.sourceStatus,
          migrationSourceId: migrationSourceScopes.migrationSourceId,
          sourceMode: migrationSources.sourceMode,
          migrationSourceStatus: migrationSources.status,
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
        .innerJoin(
          migrationSources,
          and(
            eq(migrationSources.organizationId, migrationSourceScopes.organizationId),
            eq(migrationSources.businessUnitId, migrationSourceScopes.businessUnitId),
            eq(migrationSources.id, migrationSourceScopes.migrationSourceId),
          ),
        )
        .where(
          and(
            eq(migrationDomainAuthorities.organizationId, command.actor.organizationId),
            inArray(migrationDomainAuthorities.id, authorityIds),
          ),
        )
        .orderBy(
          asc(migrationDomainAuthorities.businessUnitId),
          asc(migrationDomainAuthorities.domainKey),
          asc(migrationDomainAuthorities.id),
        )
        .for("update", { of: [migrationSourceScopes, migrationSources] });
      if (lockedScopes.length !== heads.length) {
        authorityEvidenceInvalid(409, "A current authority source scope is missing.");
      }
      const scopeByAuthority = new Map(
        lockedScopes.map((scope) => [scope.authorityId, scope] as const),
      );

      const finalBatchIds = [
        ...new Set(
          command.members
            .map((member) => member.finalBatchId)
            .filter((batchId): batchId is string => batchId !== null),
        ),
      ].sort(compareAscii);
      const canonicalSourceIds = [
        ...new Set(
          command.members
            .filter((member) => member.toState === "CANONICAL_WRITABLE")
            .map((member) => scopeByAuthority.get(member.domainAuthorityId)?.migrationSourceId)
            .filter((sourceId): sourceId is string => sourceId !== undefined),
        ),
      ].sort(compareAscii);
      const lockedSourceBatches =
        canonicalSourceIds.length === 0
          ? []
          : await transaction
              .select({
                id: importBatches.id,
                businessUnitId: importBatches.businessUnitId,
                migrationSourceId: importBatches.migrationSourceId,
                validatedDryRunBatchId: importBatches.validatedDryRunBatchId,
                dryRun: importBatches.dryRun,
                status: importBatches.status,
                cutoffAt: importBatches.cutoffAt,
              })
              .from(importBatches)
              .where(
                and(
                  eq(importBatches.organizationId, command.actor.organizationId),
                  or(
                    inArray(importBatches.migrationSourceId, canonicalSourceIds),
                    inArray(importBatches.id, finalBatchIds),
                  ),
                ),
              )
              .orderBy(asc(importBatches.businessUnitId), asc(importBatches.id))
              .for("update");
      const finalBatchById = new Map(
        lockedSourceBatches.map((batch) => [batch.id, batch] as const),
      );

      const lockedReconciliationRuns =
        finalBatchIds.length === 0
          ? []
          : await transaction
              .select({
                id: reconciliationRuns.id,
                businessUnitId: reconciliationRuns.businessUnitId,
                batchId: reconciliationRuns.batchId,
                runNo: reconciliationRuns.runNo,
                status: reconciliationRuns.status,
                signedByMembershipId: reconciliationRuns.signedByMembershipId,
                signedAt: reconciliationRuns.signedAt,
              })
              .from(reconciliationRuns)
              .where(
                and(
                  eq(reconciliationRuns.organizationId, command.actor.organizationId),
                  inArray(reconciliationRuns.batchId, finalBatchIds),
                ),
              )
              .orderBy(
                asc(reconciliationRuns.businessUnitId),
                asc(reconciliationRuns.batchId),
                asc(reconciliationRuns.runNo),
                asc(reconciliationRuns.id),
              )
              .for("share");

      const [clocks] = await transaction.select({
        transactionTime: sql<unknown>`transaction_timestamp()`,
        wallTime: sql<unknown>`clock_timestamp()`,
      })
        .from(organizations)
        .where(eq(organizations.id, command.actor.organizationId))
        .limit(1);
      const transactionTime = parseAuthorityDatabaseTimestamp(clocks?.transactionTime);
      const wallTime = parseAuthorityDatabaseTimestamp(clocks?.wallTime);
      if (
        !clocks ||
        transactionTime.getTime() < plan.notBefore.getTime() ||
        transactionTime.getTime() > plan.expiresAt.getTime() ||
        wallTime.getTime() < plan.notBefore.getTime() ||
        wallTime.getTime() > plan.expiresAt.getTime()
      ) {
        throw new ApiError(
          409,
          "AUTHORITY_WINDOW_CLOSED",
          "The reviewed authority execution window is closed.",
        );
      }

      const prepared: PreparedAuthorityTransition[] = [];
      const sourceBatchBindings = new Map<
        string,
        { finalBatchId: string; validatedDryRunBatchId: string | null; cutoffAt: Date }
      >();
      for (const head of heads) {
        const requested = memberByAuthority.get(head.id)!;
        const signed = signedByAuthority.get(head.id)!;
        const scope = scopeByAuthority.get(head.id)!;
        if (head.businessUnitStatus !== "ACTIVE") {
          throw new ApiError(
            404,
            "MIGRATION_BUSINESS_UNIT_NOT_FOUND",
            "A migration inventory business unit is not active.",
          );
        }
        if (
          signed.businessUnitId !== head.businessUnitId ||
          signed.domainKey !== head.domainKey
        ) {
          throw new ApiError(
            409,
            "AUTHORITY_PLAN_MEMBER_MISMATCH",
            "A reviewed plan member does not match its durable authority identity.",
          );
        }
        if (head.version !== requested.expectedVersion) {
          throw new ApiError(
            409,
            "AUTHORITY_VERSION_CONFLICT",
            "A durable authority head changed after review.",
          );
        }
        if (
          head.authoritySourceScopeId === null ||
          scope.scopeId !== head.authoritySourceScopeId ||
          scope.businessUnitId !== head.businessUnitId ||
          scope.scopeDomainKey !== head.domainKey ||
          scope.scopeCanonicalTarget !== head.canonicalTarget ||
          scope.scopeStatus !== "ACTIVE_AUTHORITY" ||
          scope.migrationSourceStatus !== "ACTIVE"
        ) {
          authorityEvidenceInvalid(409, "The current authority source lineage is invalid.");
        }
        try {
          assertAuthorityTransition({
            sourceMode: scope.sourceMode,
            from: head.authorityState,
            to: requested.toState,
            cutoverApproved: true,
          });
        } catch {
          throw new ApiError(
            409,
            "AUTHORITY_TRANSITION_INVALID",
            "The reviewed authority lifecycle transition is not permitted.",
          );
        }

        let finalCutoffAt: Date | null = null;
        if (requested.toState === "CANONICAL_WRITABLE") {
          const finalBatch = finalBatchById.get(requested.finalBatchId!);
          const hasSignedRun = lockedReconciliationRuns.some(
            (run) =>
              run.batchId === requested.finalBatchId &&
              run.businessUnitId === head.businessUnitId &&
              run.status === "SIGNED" &&
              run.signedByMembershipId !== null &&
              run.signedAt !== null,
          );
          if (
            !finalBatch ||
            finalBatch.businessUnitId !== head.businessUnitId ||
            finalBatch.migrationSourceId !== scope.migrationSourceId ||
            finalBatch.dryRun ||
            finalBatch.status !== "RECONCILED" ||
            !hasSignedRun ||
            requested.writeFrozenAt!.getTime() > finalBatch.cutoffAt.getTime() ||
            finalBatch.cutoffAt.getTime() > transactionTime.getTime()
          ) {
            authorityEvidenceInvalid(409, "The selected final batch evidence is invalid.");
          }
          const existingBinding = sourceBatchBindings.get(scope.migrationSourceId);
          if (
            existingBinding &&
            (existingBinding.finalBatchId !== finalBatch.id ||
              existingBinding.cutoffAt.getTime() !== finalBatch.cutoffAt.getTime())
          ) {
            throw new ApiError(
              409,
              "AUTHORITY_BATCH_BINDING_CONFLICT",
              "Authority domains from one source must share one final batch and cutoff.",
            );
          }
          sourceBatchBindings.set(scope.migrationSourceId, {
            finalBatchId: finalBatch.id,
            validatedDryRunBatchId: finalBatch.validatedDryRunBatchId,
            cutoffAt: new Date(finalBatch.cutoffAt.getTime()),
          });
          finalCutoffAt = new Date(finalBatch.cutoffAt.getTime());
        }

        prepared.push({
          businessUnitId: head.businessUnitId,
          domainAuthorityId: head.id,
          domainKey: head.domainKey,
          migrationSourceId: scope.migrationSourceId,
          sourceMode: scope.sourceMode,
          fromSourceScopeId: scope.scopeId,
          toSourceScopeId:
            requested.toState === "CANONICAL_WRITABLE" ? null : scope.scopeId,
          fromState: head.authorityState,
          toState: requested.toState,
          writeFrozenAt: requested.writeFrozenAt,
          finalBatchId: requested.finalBatchId,
          finalCutoffAt,
          expectedVersion: requested.expectedVersion,
        });
      }

      for (const [migrationSourceId, binding] of sourceBatchBindings) {
        const exemptBatchIds = new Set([
          binding.finalBatchId,
          ...(binding.validatedDryRunBatchId ? [binding.validatedDryRunBatchId] : []),
        ]);
        if (
          lockedSourceBatches.some(
            (batch) =>
              batch.migrationSourceId === migrationSourceId &&
              !exemptBatchIds.has(batch.id) &&
              ([
                "REGISTERED",
                "STAGED",
                "VALIDATED",
                "APPROVED",
                "APPLYING",
                "APPLIED",
              ].includes(batch.status) ||
                batch.cutoffAt.getTime() >= binding.cutoffAt.getTime()),
          )
        ) {
          throw new ApiError(
            409,
            "AUTHORITY_LATER_DELTA_EXISTS",
            "A later source delta exists through the effective cutover time.",
          );
        }
      }

      actorEvidence = await requireActorCapability(
        transaction,
        command.actor,
        AUTHORITY_CAPABILITY,
        command.actor.businessUnitId,
        true,
      );
      const [preInsertClock] = await transaction
        .select({ wallTime: sql<unknown>`clock_timestamp()` })
        .from(organizations)
        .where(eq(organizations.id, command.actor.organizationId))
        .limit(1);
      const preInsertWallTime = parseAuthorityDatabaseTimestamp(preInsertClock?.wallTime);
      if (
        !preInsertClock ||
        transactionTime.getTime() < plan.notBefore.getTime() ||
        transactionTime.getTime() > plan.expiresAt.getTime() ||
        preInsertWallTime.getTime() < plan.notBefore.getTime() ||
        preInsertWallTime.getTime() > plan.expiresAt.getTime()
      ) {
        throw new ApiError(
          409,
          "AUTHORITY_WINDOW_CLOSED",
          "The reviewed authority execution window closed before persistence.",
        );
      }

      const [storedGroup] = await transaction
        .insert(sourceAuthorityTransitionGroups)
        .values({
          id: command.cutoverGroupId,
          organizationId: command.actor.organizationId,
          idempotencyKey: command.idempotencyKey,
          groupSize: prepared.length,
          groupSha256,
          planArtifactRef: command.planArtifactRef,
          planSha256: command.expectedPlanSha256,
          approvedByMembershipId: command.actor.activeMembershipId,
          approvalReason: command.approvalReason,
        })
        .returning({
          id: sourceAuthorityTransitionGroups.id,
          effectiveAt: sourceAuthorityTransitionGroups.effectiveAt,
        });
      if (!storedGroup) {
        throw new ApiError(
          500,
          "AUTHORITY_TRANSITION_FAILED",
          "The authority transition group could not be stored.",
        );
      }

      const storedTransitions = await transaction
        .insert(sourceAuthorityTransitions)
        .values(
          prepared.map((member) => ({
            organizationId: command.actor.organizationId,
            businessUnitId: member.businessUnitId,
            transitionGroupId: storedGroup.id,
            domainAuthorityId: member.domainAuthorityId,
            fromSourceScopeId: member.fromSourceScopeId,
            toSourceScopeId: member.toSourceScopeId,
            fromState: member.fromState,
            toState: member.toState,
            writeFrozenAt: member.writeFrozenAt,
            finalBatchId: member.finalBatchId,
            finalCutoffAt: member.finalCutoffAt,
          })),
        )
        .returning({
          id: sourceAuthorityTransitions.id,
          domainAuthorityId: sourceAuthorityTransitions.domainAuthorityId,
        });
      if (storedTransitions.length !== prepared.length) {
        throw new ApiError(
          500,
          "AUTHORITY_TRANSITION_FAILED",
          "The authority transition members could not be stored.",
        );
      }

      for (const member of prepared) {
        const [updatedHead] = await transaction
          .update(migrationDomainAuthorities)
          .set({
            authorityState: member.toState,
            authoritySourceScopeId: member.toSourceScopeId,
          })
          .where(
            and(
              eq(migrationDomainAuthorities.organizationId, command.actor.organizationId),
              eq(migrationDomainAuthorities.businessUnitId, member.businessUnitId),
              eq(migrationDomainAuthorities.id, member.domainAuthorityId),
              eq(migrationDomainAuthorities.version, member.expectedVersion),
            ),
          )
          .returning({ id: migrationDomainAuthorities.id });
        if (!updatedHead) {
          throw new ApiError(
            409,
            "AUTHORITY_VERSION_CONFLICT",
            "A durable authority head changed during cutover.",
          );
        }
        if (member.toState === "CANONICAL_WRITABLE") {
          await transaction
            .update(migrationSourceScopes)
            .set({ sourceStatus: "ARCHIVED_READ_ONLY" })
            .where(
              and(
                eq(migrationSourceScopes.organizationId, command.actor.organizationId),
                eq(migrationSourceScopes.businessUnitId, member.businessUnitId),
                eq(migrationSourceScopes.id, member.fromSourceScopeId),
              ),
            );
        }
      }

      const sourcesToRefresh = [
        ...new Map(
          prepared
            .filter((member) => member.toState === "CANONICAL_WRITABLE")
            .map((member) => [
              `${member.businessUnitId}\0${member.migrationSourceId}`,
              {
                businessUnitId: member.businessUnitId,
                migrationSourceId: member.migrationSourceId,
              },
            ] as const),
        ).values(),
      ].sort((left, right) =>
        compareAscii(
          `${left.businessUnitId}\0${left.migrationSourceId}`,
          `${right.businessUnitId}\0${right.migrationSourceId}`,
        ),
      );
      for (const source of sourcesToRefresh) {
        const [remainingScope] = await transaction
          .select({ id: migrationSourceScopes.id })
          .from(migrationSourceScopes)
          .where(
            and(
              eq(migrationSourceScopes.organizationId, command.actor.organizationId),
              eq(migrationSourceScopes.businessUnitId, source.businessUnitId),
              eq(migrationSourceScopes.migrationSourceId, source.migrationSourceId),
              sql`${migrationSourceScopes.sourceStatus} <> 'ARCHIVED_READ_ONLY'`,
            ),
          )
          .orderBy(asc(migrationSourceScopes.id))
          .limit(1)
          .for("share");
        await transaction
          .update(migrationSources)
          .set({ status: remainingScope ? "ACTIVE" : "ARCHIVED_READ_ONLY" })
          .where(
            and(
              eq(migrationSources.organizationId, command.actor.organizationId),
              eq(migrationSources.businessUnitId, source.businessUnitId),
              eq(migrationSources.id, source.migrationSourceId),
            ),
          );
      }

      const members = plan.requiredMembers.map((member) => ({
        businessUnitId: member.businessUnitId,
        domainAuthorityId: member.domainAuthorityId,
        domainKey: member.domainKey,
        toState: member.toState,
      }));
      const eventSummary = {
        schemaVersion: 1,
        cutoverGroupId: storedGroup.id,
        effectiveAt: storedGroup.effectiveAt.toISOString(),
        memberCount: members.length,
        members,
      };
      const eventActorType = actorEvidence.userType === "SERVICE" ? "SERVICE" : "USER";
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: null,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_AUTHORITY_SWITCHED",
        targetType: "SOURCE_AUTHORITY_TRANSITION_GROUP",
        targetId: storedGroup.id,
        outcome: "SUCCESS",
        reason: "REVIEWED_SIGNED_CUTOVER_PLAN",
        correlationId: storedGroup.id,
        changeSummary: eventSummary,
        occurredAt: storedGroup.effectiveAt,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: null,
        eventType: "crm.migration.authority_switched",
        eventVersion: 1,
        aggregateType: "SOURCE_AUTHORITY_TRANSITION_GROUP",
        aggregateId: storedGroup.id,
        aggregateVersion: 1,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        correlationId: storedGroup.id,
        payload: eventSummary,
        occurredAt: storedGroup.effectiveAt,
      });

      return {
        cutoverGroupId: storedGroup.id,
        transitionIds: [...storedTransitions]
          .sort((left, right) =>
            compareAscii(left.domainAuthorityId, right.domainAuthorityId),
          )
          .map((transition) => transition.id),
        effectiveAt: storedGroup.effectiveAt,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const constraint = databaseConstraint(error);
    if (
      constraint === "source_authority_transition_groups_pkey" ||
      constraint === "transition_groups_tenant_id_unique" ||
      constraint === "source_authority_transition_groups_idempotency_unique"
    ) {
      authorityIdempotencyConflict();
    }
    throw new ApiError(
      500,
      "AUTHORITY_TRANSITION_FAILED",
      "The authority transition could not be completed.",
    );
  }
}
