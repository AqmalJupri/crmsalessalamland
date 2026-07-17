import "server-only";

import { createHash } from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { assertImportBatchTransition } from "@/domain/migration/batch-lifecycle";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  importRows,
  legacyObjectLinks,
} from "@/server/db/migration-schema";
import { auditEvents, memberships, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import {
  assertProtectedArtifactRef,
  assertSha256Digest,
  digestsEqual,
} from "./artifact-checksum";
import type { MigrationActor } from "./contracts";
import { parseAuthorityDatabaseTimestamp } from "./database-timestamp";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  type MigrationDatabaseTransaction,
  validateMigrationActor,
} from "./stage-batch";
import {
  deriveValidationState,
  persistedSummaryMatches,
} from "./validate-batch";

const APPLY_CAPABILITY = "migration.apply";
const MIN_LEASE_SECONDS = 1;
const MAX_LEASE_SECONDS = 3_600;
const MIN_CHUNK_SIZE = 1;
const MAX_CHUNK_SIZE = 100;
const MAX_EVIDENCE_DEPTH = 64;
const MAX_EVIDENCE_NODES = 100_000;
const MAX_EVIDENCE_PROPERTIES = 10_000;
const MAX_EVIDENCE_KEY_BYTES = 262_144;
const MAX_EVIDENCE_STRING_BYTES = 1_048_576;
const MAX_EVIDENCE_ARTIFACT_BYTES = 1_048_576;
const EVIDENCE_PROPERTY_OVERHEAD_BYTES = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESTINATION_TYPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,126}$/;

type Database = ReturnType<typeof getDatabase>;

export interface ApprovedImportRow {
  id: string;
  organizationId: string;
  businessUnitId: string;
  batchId: string;
  migrationSourceId: string;
  sourceObjectType: string;
  sourceRowKey: string;
  sourceRecordId: string | null;
  normalizedEvidenceRef: string;
  normalizedSha256: Uint8Array;
  rowVersion: number;
  currentLinkId: string | null;
}

export interface ApprovedEvidenceLoader {
  /** Loads the exact bytes stored at row.normalizedEvidenceRef. */
  load(row: ApprovedImportRow): Promise<{
    protectedBytes: Uint8Array;
  }>;
}

export interface ApprovedEvidenceSchemaBinding {
  migrationSourceId: string;
  schemaVersion: string;
  sourceObjectType: string;
}

export interface ApprovedEvidenceValidator<TValue> {
  /** Decodes and schema-validates the digest-bound bytes for this adapter binding. */
  parseAndValidate(
    binding: Readonly<ApprovedEvidenceSchemaBinding>,
    protectedBytes: Readonly<Uint8Array>,
  ): Promise<TValue> | TValue;
}

interface ApplyDependencies<TTransaction, TValue> {
  evidenceLoader: ApprovedEvidenceLoader;
  evidenceValidator: ApprovedEvidenceValidator<TValue>;
  writer: CanonicalImportWriter<TTransaction, TValue>;
}

export type ApplyImportBatchInput<TTransaction, TValue> =
  | (ApplyDependencies<TTransaction, TValue> & {
      mode: "START";
      batchId: string;
      expectedApprovedBatchVersion: number;
      applyRunId: string;
      leaseSeconds: number;
      chunkSize: number;
    })
  | (ApplyDependencies<TTransaction, TValue> & {
      mode: "RESUME";
      batchId: string;
      applyRunId: string;
      leaseSeconds: number;
      chunkSize: number;
    });

export interface ApplyBatchSummary {
  batchId: string;
  importedRows: number;
  noOpRows: number;
  rejectedRows: number;
  appliedAt: Date;
  replayed: boolean;
}

export interface CanonicalImportWriter<TTransaction, TValue> {
  apply(
    transaction: TTransaction,
    row: ApprovedImportRow,
    value: Readonly<TValue>,
  ): Promise<{
    outcome: "IMPORTED" | "NO_OP_REPLAY";
    destinationEntityType: string;
    destinationEntityId: string;
  }>;
}

interface ApplyCommand<TTransaction, TValue> {
  actor: MigrationActor;
  mode: "START" | "RESUME";
  batchId: string;
  expectedApprovedBatchVersion: number | null;
  applyRunId: string;
  leaseSeconds: number;
  chunkSize: number;
  evidenceLoader: ApprovedEvidenceLoader;
  evidenceValidator: ApprovedEvidenceValidator<TValue>;
  writer: CanonicalImportWriter<TTransaction, TValue>;
}

interface BatchLocator {
  batchId: string;
  migrationSourceId: string;
}

interface LockedApplyBatch {
  id: string;
  migrationSourceId: string;
  schemaVersion: string;
  status: string;
  dryRun: boolean;
  version: number;
  totalRowCount: number;
  stagedRowCount: number;
  validRowCount: number;
  rejectedRowCount: number;
  quarantinedRowCount: number;
  hiddenRowCount: number;
  approvedRowCount: number;
  importedRowCount: number;
  noOpRowCount: number;
  approvedByMembershipId: string | null;
  approvedAt: Date | null;
  approvalMode: "FULL" | "PARTIAL" | null;
  approvalReason: string | null;
  appliedByMembershipId: string | null;
  applyRunId: string | null;
  applyLeaseExpiresAt: Date | null;
  applyStartedAt: Date | null;
  appliedAt: Date | null;
  repairOfBatchId: string | null;
  operatorReason: string | null;
}

interface LoadedEvidence<TValue> {
  value: Readonly<TValue>;
}

interface ApprovedImportRowWithSchema extends ApprovedImportRow {
  schemaVersion: string;
}

interface CanonicalWriterResult {
  outcome: "IMPORTED" | "NO_OP_REPLAY";
  destinationEntityType: string;
  destinationEntityId: string;
}

interface CurrentLegacyLink {
  id: string;
  importRowId: string;
  linkVersion: number;
  destinationEntityType: string;
  destinationEntityId: string;
  originBatchId: string;
  normalizedSha256: Uint8Array;
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      `${field} must be a safe integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
}

function positiveVersion(value: unknown, field: string): number {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function bindDependencyMethod<TObject extends object, TKey extends keyof TObject>(
  value: TObject | null | undefined,
  key: TKey,
  message: string,
): TObject[TKey] {
  try {
    const candidate = value?.[key];
    if (typeof candidate !== "function") throw new Error();
    return candidate.bind(value) as TObject[TKey];
  } catch {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", message);
  }
}

function validateCommand<TTransaction, TValue>(
  actorInput: MigrationActor,
  input: ApplyImportBatchInput<TTransaction, TValue>,
): ApplyCommand<TTransaction, TValue> {
  const actor = validateMigrationActor(actorInput, APPLY_CAPABILITY);
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The apply command is invalid.");
  }
  if (input.mode !== "START" && input.mode !== "RESUME") {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      "mode must be START or RESUME.",
    );
  }
  const load = bindDependencyMethod(
    input.evidenceLoader,
    "load",
    "An approved evidence loader is required.",
  ) as ApprovedEvidenceLoader["load"];
  const apply = bindDependencyMethod(
    input.writer,
    "apply",
    "A canonical import writer is required.",
  ) as CanonicalImportWriter<TTransaction, TValue>["apply"];
  const parseAndValidate = bindDependencyMethod(
    input.evidenceValidator,
    "parseAndValidate",
    "An approved evidence schema validator is required.",
  ) as ApprovedEvidenceValidator<TValue>["parseAndValidate"];
  return {
    actor,
    mode: input.mode,
    batchId: canonicalUuid(input.batchId, "batchId"),
    expectedApprovedBatchVersion:
      input.mode === "START"
        ? positiveVersion(
            input.expectedApprovedBatchVersion,
            "expectedApprovedBatchVersion",
          )
        : null,
    applyRunId: canonicalUuid(input.applyRunId, "applyRunId"),
    leaseSeconds: boundedInteger(
      input.leaseSeconds,
      "leaseSeconds",
      MIN_LEASE_SECONDS,
      MAX_LEASE_SECONDS,
    ),
    chunkSize: boundedInteger(
      input.chunkSize,
      "chunkSize",
      MIN_CHUNK_SIZE,
      MAX_CHUNK_SIZE,
    ),
    evidenceLoader: { load },
    evidenceValidator: { parseAndValidate },
    writer: { apply },
  };
}

function selectedApplyBatchColumns() {
  return {
    id: importBatches.id,
    migrationSourceId: importBatches.migrationSourceId,
    schemaVersion: importBatches.schemaVersion,
    status: importBatches.status,
    dryRun: importBatches.dryRun,
    version: importBatches.version,
    totalRowCount: importBatches.totalRowCount,
    stagedRowCount: importBatches.stagedRowCount,
    validRowCount: importBatches.validRowCount,
    rejectedRowCount: importBatches.rejectedRowCount,
    quarantinedRowCount: importBatches.quarantinedRowCount,
    hiddenRowCount: importBatches.hiddenRowCount,
    approvedRowCount: importBatches.approvedRowCount,
    importedRowCount: importBatches.importedRowCount,
    noOpRowCount: importBatches.noOpRowCount,
    approvedByMembershipId: importBatches.approvedByMembershipId,
    approvedAt: importBatches.approvedAt,
    approvalMode: importBatches.approvalMode,
    approvalReason: importBatches.approvalReason,
    appliedByMembershipId: importBatches.appliedByMembershipId,
    applyRunId: importBatches.applyRunId,
    applyLeaseExpiresAt: importBatches.applyLeaseExpiresAt,
    applyStartedAt: importBatches.applyStartedAt,
    appliedAt: importBatches.appliedAt,
    repairOfBatchId: importBatches.repairOfBatchId,
    operatorReason: importBatches.operatorReason,
  };
}

function safeCounter(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(
      500,
      "IMPORT_BATCH_SUMMARY_UNSAFE",
      `The ${field} counter cannot be represented safely.`,
    );
  }
  return value;
}

function eventActorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

async function locateBatch<TTransaction, TValue>(
  database: Database,
  command: ApplyCommand<TTransaction, TValue>,
): Promise<BatchLocator> {
  const [locator] = await database
    .select({ batchId: importBatches.id, migrationSourceId: importBatches.migrationSourceId })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, command.actor.organizationId),
        eq(importBatches.businessUnitId, command.actor.businessUnitId),
        eq(importBatches.id, command.batchId),
      ),
    )
    .limit(1);
  if (!locator) {
    throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
  }
  return locator;
}

async function membershipUsers(
  transaction: MigrationDatabaseTransaction,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(membershipIds)].sort();
  const rows = await transaction
    .select({ id: memberships.id, userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        inArray(memberships.id, uniqueIds),
      ),
    )
    .orderBy(asc(memberships.id))
    .for("share");
  return new Map(rows.map((row) => [row.id, row.userId] as const));
}

async function requireDifferentApproverAndApplier(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  approvedByMembershipId: string,
): Promise<void> {
  const users = await membershipUsers(transaction, actor.organizationId, [
    approvedByMembershipId,
    actor.activeMembershipId,
  ]);
  const approverUserId = users.get(approvedByMembershipId);
  const applierUserId = users.get(actor.activeMembershipId);
  if (!approverUserId || !applierUserId) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_PROVENANCE_INVALID",
      "Approver and applier provenance must remain available.",
    );
  }
  if (approverUserId === applierUserId) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_MAKER_CHECKER_REQUIRED",
      "The approving and applying identities must be different.",
    );
  }
}

async function ownedByActor(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  appliedByMembershipId: string,
): Promise<boolean> {
  const users = await membershipUsers(transaction, actor.organizationId, [
    appliedByMembershipId,
    actor.activeMembershipId,
  ]);
  const ownerUserId = users.get(appliedByMembershipId);
  const actorUserId = users.get(actor.activeMembershipId);
  if (!ownerUserId || !actorUserId) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_PROVENANCE_INVALID",
      "Apply ownership provenance must remain available.",
    );
  }
  return ownerUserId === actorUserId;
}

function summaryFromAppliedBatch(
  batch: LockedApplyBatch,
  replayed: boolean,
): ApplyBatchSummary {
  if (batch.status !== "APPLIED" || batch.appliedAt === null) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_APPLY_STATE_INVALID",
      "The import batch has no completed apply summary.",
    );
  }
  return {
    batchId: batch.id,
    importedRows: safeCounter(batch.importedRowCount, "importedRowCount"),
    noOpRows: safeCounter(batch.noOpRowCount, "noOpRowCount"),
    rejectedRows: safeCounter(batch.rejectedRowCount, "rejectedRowCount"),
    appliedAt: new Date(batch.appliedAt.getTime()),
    replayed,
  };
}

async function requireExactAppliedReplay<TTransaction, TValue>(
  transaction: MigrationDatabaseTransaction,
  command: ApplyCommand<TTransaction, TValue>,
  batch: LockedApplyBatch,
): Promise<ApplyBatchSummary> {
  if (
    batch.applyRunId !== command.applyRunId ||
    batch.appliedByMembershipId === null ||
    !(await ownedByActor(
      transaction,
      command.actor,
      batch.appliedByMembershipId,
    ))
  ) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_APPLY_RUN_CONFLICT",
      "The applied batch belongs to another immutable apply run.",
    );
  }
  await requireMigrationActorCapability(
    transaction,
    command.actor,
    APPLY_CAPABILITY,
  );
  return summaryFromAppliedBatch(batch, true);
}

async function assertInitialApprovedRows(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  batch: LockedApplyBatch,
): Promise<void> {
  const state = await deriveValidationState(transaction, actor, batch.id);
  if (
    !persistedSummaryMatches(batch, state) ||
    state.totalRows !== batch.totalRowCount ||
    state.validRows !== batch.approvedRowCount ||
    state.validRows < 1 ||
    state.stagedRows !== 0 ||
    state.importedRows !== 0 ||
    state.noOpRows !== 0 ||
    state.quarantinedRows !== 0 ||
    state.hiddenRows !== 0 ||
    state.openQuarantineRows !== 0
  ) {
    throw new ApiError(
      409,
      "IMPORT_BATCH_APPROVED_ROWS_INVALID",
      "The approved row subset is no longer eligible for canonical apply.",
    );
  }
}

async function startApplyClaim<TTransaction, TValue>(
  database: Database,
  command: ApplyCommand<TTransaction, TValue>,
  locator: BatchLocator,
): Promise<ApplyBatchSummary | null> {
  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        locator.migrationSourceId,
      );
      const [batch] = await transaction
        .select(selectedApplyBatchColumns())
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, command.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) {
        throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      }
      if (batch.status === "APPLIED") {
        return requireExactAppliedReplay(transaction, command, batch);
      }
      if (batch.status === "APPLYING") {
        const [clock] = await transaction
          .select({ now: sql<Date>`clock_timestamp()` })
          .from(importBatches)
          .where(eq(importBatches.id, batch.id))
          .limit(1);
        if (
          batch.applyLeaseExpiresAt !== null &&
          clock &&
          batch.applyLeaseExpiresAt.getTime() >
            parseAuthorityDatabaseTimestamp(clock.now).getTime()
        ) {
          throw new ApiError(
            409,
            "IMPORT_BATCH_APPLY_LEASE_CONFLICT",
            "Another apply run owns the live batch lease.",
          );
        }
        throw new ApiError(
          409,
          "IMPORT_BATCH_RESUME_REQUIRED",
          "An applying batch must continue through RESUME.",
        );
      }
      if (
        batch.status !== "APPROVED" ||
        batch.dryRun ||
        batch.approvedByMembershipId === null ||
        batch.approvedAt === null ||
        batch.approvalMode === null ||
        batch.approvalReason === null
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_STATE_INVALID",
          "Only an approved live batch can begin canonical apply.",
        );
      }
      if (batch.version !== command.expectedApprovedBatchVersion) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The approved import batch changed before apply claim.",
        );
      }
      await assertInitialApprovedRows(transaction, command.actor, batch);
      await requireDifferentApproverAndApplier(
        transaction,
        command.actor,
        batch.approvedByMembershipId,
      );
      assertImportBatchTransition("APPROVED", "APPLYING");

      const [claimed] = await transaction
        .update(importBatches)
        .set({
          status: "APPLYING",
          appliedByMembershipId: command.actor.activeMembershipId,
          applyRunId: command.applyRunId,
          applyLeaseExpiresAt: sql`clock_timestamp() + (${command.leaseSeconds} * interval '1 second')`,
          applyStartedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(importBatches.id, batch.id),
            eq(importBatches.version, command.expectedApprovedBatchVersion!),
            eq(importBatches.status, "APPROVED"),
            sql`${importBatches.applyRunId} is null`,
          ),
        )
        .returning({
          version: importBatches.version,
          applyStartedAt: importBatches.applyStartedAt,
          applyLeaseExpiresAt: importBatches.applyLeaseExpiresAt,
        });
      if (
        !claimed ||
        claimed.applyStartedAt === null ||
        claimed.applyLeaseExpiresAt === null
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The approved import batch changed during apply claim.",
        );
      }
      const effect = {
        schemaVersion: 1,
        batchId: batch.id,
        applyRunId: command.applyRunId,
        approvedRowCount: batch.approvedRowCount,
        applyStartedAt: claimed.applyStartedAt.toISOString(),
        leaseExpiresAt: claimed.applyLeaseExpiresAt.toISOString(),
      };
      const actorType = eventActorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_BATCH_APPLY_STARTED",
        targetType: "IMPORT_BATCH",
        targetId: batch.id,
        outcome: "SUCCESS",
        reason: "APPROVED_BATCH_CLAIMED",
        correlationId: batch.id,
        changeSummary: effect,
        occurredAt: claimed.applyStartedAt,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_batch_apply_started",
        eventVersion: 1,
        aggregateType: "IMPORT_BATCH",
        aggregateId: batch.id,
        aggregateVersion: claimed.version,
        actorType,
        actorUserId: command.actor.userId,
        correlationId: batch.id,
        payload: effect,
        occurredAt: claimed.applyStartedAt,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      void actorEvidence;
      return null;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_BATCH_APPLY_CLAIM_FAILED",
      "The approved import batch could not be claimed.",
    );
  }
}

async function resumeApplyOwnership<TTransaction, TValue>(
  database: Database,
  command: ApplyCommand<TTransaction, TValue>,
  locator: BatchLocator,
): Promise<ApplyBatchSummary | null> {
  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        locator.migrationSourceId,
      );
      const [batch] = await transaction
        .select(selectedApplyBatchColumns())
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, command.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) {
        throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      }
      if (batch.status === "APPLIED") {
        return requireExactAppliedReplay(transaction, command, batch);
      }
      if (
        batch.status !== "APPLYING" ||
        batch.appliedByMembershipId === null ||
        batch.applyRunId === null ||
        batch.applyLeaseExpiresAt === null ||
        batch.applyStartedAt === null
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_STATE_INVALID",
          "Only an owned applying batch can be resumed.",
        );
      }
      const [clock] = await transaction
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(importBatches)
        .where(eq(importBatches.id, batch.id))
        .limit(1);
      if (!clock) {
        throw new ApiError(
          500,
          "IMPORT_BATCH_APPLY_RESUME_FAILED",
          "The database clock could not be read.",
        );
      }
      const leaseLive =
        batch.applyLeaseExpiresAt.getTime() >
        parseAuthorityDatabaseTimestamp(clock.now).getTime();
      const sameOwner = await ownedByActor(
        transaction,
        command.actor,
        batch.appliedByMembershipId,
      );
      if (!sameOwner) {
        throw new ApiError(
          409,
          leaseLive
            ? "IMPORT_BATCH_APPLY_LEASE_CONFLICT"
            : "IMPORT_BATCH_APPLY_TAKEOVER_REQUIRED",
          leaseLive
            ? "Another identity owns the live apply lease."
            : "Expired cross-identity apply takeover requires a separate audited command.",
        );
      }
      if (batch.applyRunId !== command.applyRunId) {
        throw new ApiError(
          409,
          leaseLive
            ? "IMPORT_BATCH_APPLY_LEASE_CONFLICT"
            : "IMPORT_BATCH_APPLY_RUN_CONFLICT",
          "The applying batch belongs to another immutable apply run.",
        );
      }

      if (!leaseLive) {
        const [renewed] = await transaction
          .update(importBatches)
          .set({
            applyLeaseExpiresAt: sql`clock_timestamp() + (${command.leaseSeconds} * interval '1 second')`,
          })
          .where(
            and(
              eq(importBatches.id, batch.id),
              eq(importBatches.version, batch.version),
              eq(importBatches.status, "APPLYING"),
              eq(importBatches.applyRunId, command.applyRunId),
              sql`${importBatches.applyLeaseExpiresAt} <= clock_timestamp()`,
            ),
          )
          .returning({
            version: importBatches.version,
            leaseExpiresAt: importBatches.applyLeaseExpiresAt,
          });
        if (!renewed || renewed.leaseExpiresAt === null) {
          throw new ApiError(
            409,
            "IMPORT_BATCH_APPLY_LEASE_CONFLICT",
            "The apply lease changed before renewal.",
          );
        }
        const effect = {
          schemaVersion: 1,
          batchId: batch.id,
          applyRunId: command.applyRunId,
          leaseExpiresAt: renewed.leaseExpiresAt.toISOString(),
          continuation: "SAME_OWNER",
        };
        const actorType = eventActorType(actorEvidence.userType);
        await transaction.insert(auditEvents).values({
          organizationId: command.actor.organizationId,
          businessUnitId: command.actor.businessUnitId,
          actorType,
          actorUserId: command.actor.userId,
          action: "MIGRATION_IMPORT_BATCH_APPLY_RESUMED",
          targetType: "IMPORT_BATCH",
          targetId: batch.id,
          outcome: "SUCCESS",
          reason: "EXPIRED_SAME_OWNER_LEASE_RENEWED",
          correlationId: batch.id,
          changeSummary: effect,
        });
        await transaction.insert(outboxEvents).values({
          organizationId: command.actor.organizationId,
          businessUnitId: command.actor.businessUnitId,
          eventType: "crm.migration.import_batch_apply_resumed",
          eventVersion: 1,
          aggregateType: "IMPORT_BATCH",
          aggregateId: batch.id,
          aggregateVersion: renewed.version,
          actorType,
          actorUserId: command.actor.userId,
          correlationId: batch.id,
          payload: effect,
        });
      }
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      void actorEvidence;
      return null;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_BATCH_APPLY_RESUME_FAILED",
      "The applying import batch could not be resumed.",
    );
  }
}

function approvedEvidenceBindingInvalid(): never {
  throw new ApiError(
    422,
    "APPROVED_EVIDENCE_BINDING_INVALID",
    "Loaded normalized evidence did not bind the approved import row.",
  );
}

function ownDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

interface EvidenceSnapshotState {
  nodes: number;
  properties: number;
  keyBytes: number;
  stringBytes: number;
  artifactBytes: number;
  active: WeakSet<object>;
}

function addEvidenceArtifactBytes(
  state: EvidenceSnapshotState,
  bytes: number,
): void {
  const next = state.artifactBytes + bytes;
  if (!Number.isSafeInteger(next) || next > MAX_EVIDENCE_ARTIFACT_BYTES) {
    approvedEvidenceBindingInvalid();
  }
  state.artifactBytes = next;
}

function snapshotEvidenceValue(
  value: unknown,
  state: EvidenceSnapshotState,
  depth: number,
): unknown {
  if (depth > MAX_EVIDENCE_DEPTH) approvedEvidenceBindingInvalid();
  if (value === null) {
    addEvidenceArtifactBytes(state, 4);
    return value;
  }
  if (typeof value === "boolean") {
    addEvidenceArtifactBytes(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    state.stringBytes += bytes;
    if (state.stringBytes > MAX_EVIDENCE_STRING_BYTES) {
      approvedEvidenceBindingInvalid();
    }
    addEvidenceArtifactBytes(state, bytes);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) approvedEvidenceBindingInvalid();
    addEvidenceArtifactBytes(state, 8);
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) {
    approvedEvidenceBindingInvalid();
  }
  state.nodes += 1;
  if (state.nodes > MAX_EVIDENCE_NODES || state.active.has(value)) {
    approvedEvidenceBindingInvalid();
  }
  state.active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      approvedEvidenceBindingInvalid();
    }
    const propertyCount = state.properties + keys.length;
    if (
      !Number.isSafeInteger(propertyCount) ||
      propertyCount > MAX_EVIDENCE_PROPERTIES
    ) {
      approvedEvidenceBindingInvalid();
    }
    state.properties = propertyCount;
    let objectKeyBytes = 0;
    for (const key of keys) {
      objectKeyBytes += Buffer.byteLength(key as string, "utf8");
      if (!Number.isSafeInteger(objectKeyBytes)) approvedEvidenceBindingInvalid();
    }
    const keyBytes = state.keyBytes + objectKeyBytes;
    if (!Number.isSafeInteger(keyBytes) || keyBytes > MAX_EVIDENCE_KEY_BYTES) {
      approvedEvidenceBindingInvalid();
    }
    state.keyBytes = keyBytes;
    addEvidenceArtifactBytes(
      state,
      16 + objectKeyBytes + keys.length * EVIDENCE_PROPERTY_OVERHEAD_BYTES,
    );
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) approvedEvidenceBindingInvalid();
      const lengthDescriptor = descriptors.length;
      if (!ownDataDescriptor(lengthDescriptor) || lengthDescriptor.value !== value.length) {
        approvedEvidenceBindingInvalid();
      }
      if (keys.length !== value.length + 1) approvedEvidenceBindingInvalid();
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!ownDataDescriptor(descriptor) || descriptor.enumerable !== true) {
          approvedEvidenceBindingInvalid();
        }
        result.push(snapshotEvidenceValue(descriptor.value, state, depth + 1));
      }
      return Object.freeze(result);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      approvedEvidenceBindingInvalid();
    }
    const result: Record<string, unknown> = {};
    for (const key of keys.map(String).sort()) {
      const descriptor = descriptors[key];
      if (!ownDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        approvedEvidenceBindingInvalid();
      }
      Object.defineProperty(result, key, {
        value: snapshotEvidenceValue(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    approvedEvidenceBindingInvalid();
  } finally {
    state.active.delete(value);
  }
}

function publicApprovedRow(row: ApprovedImportRow): ApprovedImportRow {
  return Object.freeze({
    id: row.id,
    organizationId: row.organizationId,
    businessUnitId: row.businessUnitId,
    batchId: row.batchId,
    migrationSourceId: row.migrationSourceId,
    sourceObjectType: row.sourceObjectType,
    sourceRowKey: row.sourceRowKey,
    sourceRecordId: row.sourceRecordId,
    normalizedEvidenceRef: row.normalizedEvidenceRef,
    normalizedSha256: new Uint8Array(row.normalizedSha256),
    rowVersion: row.rowVersion,
    currentLinkId: row.currentLinkId,
  });
}

async function loadApprovedEvidence<TValue>(
  loader: ApprovedEvidenceLoader,
  validator: ApprovedEvidenceValidator<TValue>,
  row: ApprovedImportRowWithSchema,
): Promise<LoadedEvidence<TValue>> {
  let untrusted: unknown;
  try {
    untrusted = await loader.load(publicApprovedRow(row));
  } catch {
    throw new ApiError(
      422,
      "APPROVED_EVIDENCE_LOAD_FAILED",
      "Protected normalized evidence could not be loaded.",
    );
  }
  try {
    if (untrusted === null || typeof untrusted !== "object" || isProxy(untrusted)) {
      approvedEvidenceBindingInvalid();
    }
    const prototype = Object.getPrototypeOf(untrusted);
    if (prototype !== Object.prototype && prototype !== null) {
      approvedEvidenceBindingInvalid();
    }
    const keys = Reflect.ownKeys(untrusted);
    if (keys.length !== 1 || !keys.includes("protectedBytes")) {
      approvedEvidenceBindingInvalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(untrusted);
    if (!ownDataDescriptor(descriptors.protectedBytes)) {
      approvedEvidenceBindingInvalid();
    }
    const bytesValue = descriptors.protectedBytes.value;
    if (
      bytesValue === null ||
      typeof bytesValue !== "object" ||
      isProxy(bytesValue) ||
      !isUint8Array(bytesValue) ||
      bytesValue.byteLength > MAX_EVIDENCE_ARTIFACT_BYTES
    ) {
      approvedEvidenceBindingInvalid();
    }
    const protectedBytes = new Uint8Array(bytesValue);
    assertProtectedArtifactRef(row.normalizedEvidenceRef, "normalizedEvidenceRef");
    assertSha256Digest(row.normalizedSha256, "normalizedSha256");
    const computedDigest = createHash("sha256").update(protectedBytes).digest();
    if (!digestsEqual(computedDigest, row.normalizedSha256)) {
      approvedEvidenceBindingInvalid();
    }
    let parsed: TValue;
    try {
      parsed = await validator.parseAndValidate(
        Object.freeze({
          migrationSourceId: row.migrationSourceId,
          schemaVersion: row.schemaVersion,
          sourceObjectType: row.sourceObjectType,
        }),
        protectedBytes,
      );
    } catch {
      throw new ApiError(
        422,
        "APPROVED_EVIDENCE_SCHEMA_INVALID",
        "Loaded normalized evidence does not satisfy its bound source adapter schema.",
      );
    }
    const postValidationDigest = createHash("sha256")
      .update(protectedBytes)
      .digest();
    if (!digestsEqual(postValidationDigest, row.normalizedSha256)) {
      approvedEvidenceBindingInvalid();
    }
    const snapshot = snapshotEvidenceValue(
      parsed,
      {
        nodes: 0,
        properties: 0,
        keyBytes: 0,
        stringBytes: 0,
        artifactBytes: 0,
        active: new WeakSet(),
      },
      0,
    );
    return { value: snapshot as Readonly<TValue> };
  } catch (error: unknown) {
    if (
      error instanceof ApiError &&
      (error.code === "APPROVED_EVIDENCE_BINDING_INVALID" ||
        error.code === "APPROVED_EVIDENCE_SCHEMA_INVALID")
    ) {
      throw error;
    }
    approvedEvidenceBindingInvalid();
  }
}

async function nextApprovedChunk<TTransaction, TValue>(
  database: Database,
  command: ApplyCommand<TTransaction, TValue>,
): Promise<ApprovedImportRowWithSchema[]> {
  try {
    const rows = await database
      .select({
        id: importRows.id,
        organizationId: importRows.organizationId,
        businessUnitId: importRows.businessUnitId,
        batchId: importRows.batchId,
        migrationSourceId: importBatches.migrationSourceId,
        schemaVersion: importBatches.schemaVersion,
        sourceObjectType: importRows.sourceObjectType,
        sourceRowKey: importRows.sourceRowKey,
        sourceRecordId: importRows.sourceRecordId,
        normalizedEvidenceRef: importRows.normalizedEvidenceRef,
        normalizedSha256: importRows.normalizedSha256,
        rowVersion: importRows.version,
        currentLinkId: sql<string | null>`(
          select link.id
          from legacy_object_links link
          where link.organization_id = ${importRows.organizationId}
            and link.business_unit_id = ${importRows.businessUnitId}
            and link.migration_source_id = ${importBatches.migrationSourceId}
            and link.source_object_type = ${importRows.sourceObjectType}
            and link.source_row_key = ${importRows.sourceRowKey}
          order by link.link_version desc, link.id
          limit 1
        )`,
      })
      .from(importRows)
      .innerJoin(
        importBatches,
        and(
          eq(importBatches.organizationId, importRows.organizationId),
          eq(importBatches.businessUnitId, importRows.businessUnitId),
          eq(importBatches.id, importRows.batchId),
        ),
      )
      .where(
        and(
          eq(importRows.organizationId, command.actor.organizationId),
          eq(importRows.businessUnitId, command.actor.businessUnitId),
          eq(importRows.batchId, command.batchId),
          eq(importRows.outcome, "VALID"),
          eq(importBatches.status, "APPLYING"),
          eq(importBatches.applyRunId, command.applyRunId),
        ),
      )
      .orderBy(
        asc(importRows.sourceObjectType),
        asc(importRows.sourceRowKey),
        asc(importRows.id),
      )
      .limit(command.chunkSize);
    return rows.map((row) => {
      if (
        row.normalizedEvidenceRef === null ||
        row.normalizedSha256 === null ||
        !Number.isSafeInteger(row.rowVersion) ||
        row.rowVersion < 1
      ) {
        throw new ApiError(
          409,
          "IMPORT_ROW_APPROVED_EVIDENCE_INVALID",
          "An approved row has invalid normalized evidence.",
        );
      }
      return {
        id: row.id,
        organizationId: row.organizationId,
        businessUnitId: row.businessUnitId,
        batchId: row.batchId,
        migrationSourceId: row.migrationSourceId,
        schemaVersion: row.schemaVersion,
        sourceObjectType: row.sourceObjectType,
        sourceRowKey: row.sourceRowKey,
        sourceRecordId: row.sourceRecordId,
        normalizedEvidenceRef: row.normalizedEvidenceRef,
        normalizedSha256: new Uint8Array(row.normalizedSha256),
        rowVersion: row.rowVersion,
        currentLinkId: row.currentLinkId,
      };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_ROW_APPLY_READ_FAILED",
      "Approved import rows could not be read.",
    );
  }
}

function writerResultInvalid(): never {
  throw new ApiError(
    500,
    "CANONICAL_IMPORT_WRITER_RESULT_INVALID",
    "The canonical import writer returned an invalid result.",
  );
}

function snapshotWriterResult(value: unknown): CanonicalWriterResult {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) {
      writerResultInvalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) writerResultInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 3 ||
      !keys.includes("outcome") ||
      !keys.includes("destinationEntityType") ||
      !keys.includes("destinationEntityId") ||
      !ownDataDescriptor(descriptors.outcome) ||
      !ownDataDescriptor(descriptors.destinationEntityType) ||
      !ownDataDescriptor(descriptors.destinationEntityId)
    ) {
      writerResultInvalid();
    }
    const outcome = descriptors.outcome.value;
    const destinationEntityType = descriptors.destinationEntityType.value;
    const destinationEntityId = descriptors.destinationEntityId.value;
    if (
      (outcome !== "IMPORTED" && outcome !== "NO_OP_REPLAY") ||
      typeof destinationEntityType !== "string" ||
      !DESTINATION_TYPE_PATTERN.test(destinationEntityType)
    ) {
      writerResultInvalid();
    }
    return {
      outcome,
      destinationEntityType,
      destinationEntityId: canonicalUuid(
        destinationEntityId,
        "writer.destinationEntityId",
      ),
    };
  } catch (error: unknown) {
    if (
      error instanceof ApiError &&
      error.code === "CANONICAL_IMPORT_WRITER_RESULT_INVALID"
    ) {
      throw error;
    }
    writerResultInvalid();
  }
}

async function currentLegacyLink(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  row: ApprovedImportRow,
): Promise<CurrentLegacyLink | null> {
  const [link] = await transaction
    .select({
      id: legacyObjectLinks.id,
      importRowId: legacyObjectLinks.importRowId,
      linkVersion: legacyObjectLinks.linkVersion,
      destinationEntityType: legacyObjectLinks.destinationEntityType,
      destinationEntityId: legacyObjectLinks.destinationEntityId,
    })
    .from(legacyObjectLinks)
    .where(
      and(
        eq(legacyObjectLinks.organizationId, actor.organizationId),
        eq(legacyObjectLinks.businessUnitId, actor.businessUnitId),
        eq(legacyObjectLinks.migrationSourceId, row.migrationSourceId),
        eq(legacyObjectLinks.sourceObjectType, row.sourceObjectType),
        eq(legacyObjectLinks.sourceRowKey, row.sourceRowKey),
      ),
    )
    .orderBy(desc(legacyObjectLinks.linkVersion), asc(legacyObjectLinks.id))
    .for("update")
    .limit(1);
  if (!link) return null;
  const [origin] = await transaction
    .select({
      batchId: importRows.batchId,
      normalizedSha256: importRows.normalizedSha256,
    })
    .from(importRows)
    .where(
      and(
        eq(importRows.organizationId, actor.organizationId),
        eq(importRows.businessUnitId, actor.businessUnitId),
        eq(importRows.id, link.importRowId),
      ),
    )
    .for("share")
    .limit(1);
  if (!origin || origin.normalizedSha256 === null) {
    throw new ApiError(
      409,
      "IMPORT_ROW_LINEAGE_INVALID",
      "The current legacy link has no durable import-row origin.",
    );
  }
  return {
    ...link,
    originBatchId: origin.batchId,
    normalizedSha256: new Uint8Array(origin.normalizedSha256),
  };
}

function sameApprovedRow(
  current: {
    organizationId: string;
    businessUnitId: string;
    batchId: string;
    sourceObjectType: string;
    sourceRowKey: string;
    sourceRecordId: string | null;
    normalizedEvidenceRef: string | null;
    normalizedSha256: Uint8Array | null;
  },
  expected: ApprovedImportRow,
): boolean {
  return (
    current.organizationId === expected.organizationId &&
    current.businessUnitId === expected.businessUnitId &&
    current.batchId === expected.batchId &&
    current.sourceObjectType === expected.sourceObjectType &&
    current.sourceRowKey === expected.sourceRowKey &&
    current.sourceRecordId === expected.sourceRecordId &&
    current.normalizedEvidenceRef === expected.normalizedEvidenceRef &&
    current.normalizedSha256 !== null &&
    digestsEqual(current.normalizedSha256, expected.normalizedSha256)
  );
}

function databaseConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("constraint_name" in error)) {
    return undefined;
  }
  const name = (error as { constraint_name?: unknown }).constraint_name;
  return typeof name === "string" ? name : undefined;
}

async function applyOneApprovedRow<TTransaction, TValue>(
  database: Database,
  command: ApplyCommand<TTransaction, TValue>,
  row: ApprovedImportRowWithSchema,
  evidence: LoadedEvidence<TValue>,
): Promise<"APPLIED" | "SKIPPED"> {
  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        row.migrationSourceId,
      );
      const [currentRow] = await transaction
        .select({
          id: importRows.id,
          organizationId: importRows.organizationId,
          businessUnitId: importRows.businessUnitId,
          batchId: importRows.batchId,
          sourceObjectType: importRows.sourceObjectType,
          sourceRowKey: importRows.sourceRowKey,
          sourceRecordId: importRows.sourceRecordId,
          normalizedEvidenceRef: importRows.normalizedEvidenceRef,
          normalizedSha256: importRows.normalizedSha256,
          outcome: importRows.outcome,
          resolvedLinkId: importRows.resolvedLinkId,
          version: importRows.version,
        })
        .from(importRows)
        .where(
          and(
            eq(importRows.organizationId, command.actor.organizationId),
            eq(importRows.businessUnitId, command.actor.businessUnitId),
            eq(importRows.batchId, row.batchId),
            eq(importRows.id, row.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!currentRow) {
        throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
      }
      const [batch] = await transaction
        .select({
          ...selectedApplyBatchColumns(),
          leaseLive: sql<boolean>`${importBatches.applyLeaseExpiresAt} > clock_timestamp()`,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, row.migrationSourceId),
            eq(importBatches.id, row.batchId),
          ),
        )
        .limit(1);
      if (!batch) {
        throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      }
      if (batch.schemaVersion !== row.schemaVersion) {
        throw new ApiError(
          409,
          "IMPORT_ROW_APPROVED_EVIDENCE_CHANGED",
          "The approved source adapter schema changed during evidence loading.",
        );
      }
      if (batch.status === "APPLIED") {
        await requireExactAppliedReplay(transaction, command, batch);
        if (
          (currentRow.outcome !== "IMPORTED" &&
            currentRow.outcome !== "NO_OP_REPLAY") ||
          currentRow.resolvedLinkId === null
        ) {
          throw new ApiError(
            409,
            "IMPORT_BATCH_APPLY_STATE_INVALID",
            "An applied batch contains an unresolved row.",
          );
        }
        return "SKIPPED";
      }
      if (
        batch.status !== "APPLYING" ||
        batch.applyRunId !== command.applyRunId ||
        batch.appliedByMembershipId === null ||
        batch.applyLeaseExpiresAt === null ||
        !batch.leaseLive
      ) {
        throw new ApiError(
          409,
          batch.status === "APPLYING"
            ? "IMPORT_BATCH_APPLY_LEASE_EXPIRED"
            : "IMPORT_BATCH_APPLY_STATE_INVALID",
          "The apply run no longer owns a live applying batch.",
        );
      }
      if (
        !(await ownedByActor(
          transaction,
          command.actor,
          batch.appliedByMembershipId,
        ))
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_TAKEOVER_REQUIRED",
          "Another identity owns the applying batch.",
        );
      }
      if (
        currentRow.outcome === "IMPORTED" ||
        currentRow.outcome === "NO_OP_REPLAY"
      ) {
        if (currentRow.resolvedLinkId === null) {
          throw new ApiError(
            409,
            "IMPORT_ROW_LINEAGE_INVALID",
            "An applied row has no resolved legacy link.",
          );
        }
        return "SKIPPED";
      }
      if (currentRow.outcome !== "VALID" || currentRow.version !== row.rowVersion) {
        throw new ApiError(
          409,
          "IMPORT_ROW_VERSION_CONFLICT",
          "The approved import row changed during evidence loading.",
        );
      }
      if (!sameApprovedRow(currentRow, row)) {
        throw new ApiError(
          409,
          "IMPORT_ROW_APPROVED_EVIDENCE_CHANGED",
          "The approved normalized evidence changed during loading.",
        );
      }

      const currentLink = await currentLegacyLink(
        transaction,
        command.actor,
        row,
      );
      if ((currentLink?.id ?? null) !== row.currentLinkId) {
        throw new ApiError(
          409,
          "IMPORT_ROW_LINEAGE_CHANGED",
          "The current legacy-link head changed during evidence loading.",
        );
      }

      let untrustedWriterResult: unknown;
      try {
        untrustedWriterResult = await command.writer.apply(
          transaction as unknown as TTransaction,
          publicApprovedRow(row),
          evidence.value,
        );
      } catch {
        throw new ApiError(
          500,
          "CANONICAL_IMPORT_WRITER_FAILED",
          "The canonical import writer could not apply the approved row.",
        );
      }
      const result = snapshotWriterResult(untrustedWriterResult);

      let resolvedLinkId: string;
      if (result.outcome === "NO_OP_REPLAY") {
        if (
          batch.repairOfBatchId === null ||
          batch.operatorReason === null ||
          currentLink === null ||
          currentLink.originBatchId !== batch.repairOfBatchId
        ) {
          throw new ApiError(
            409,
            "IMPORT_ROW_NO_OP_REPAIR_REQUIRED",
            "NO_OP_REPLAY is allowed only for a distinct approved repair row.",
          );
        }
        if (
          currentLink.destinationEntityType !== result.destinationEntityType ||
          currentLink.destinationEntityId !== result.destinationEntityId
        ) {
          throw new ApiError(
            409,
            "IMPORT_ROW_NO_OP_DESTINATION_MISMATCH",
            "NO_OP_REPLAY must resolve to the current canonical link.",
          );
        }
        if (!digestsEqual(currentLink.normalizedSha256, row.normalizedSha256)) {
          throw new ApiError(
            409,
            "IMPORT_ROW_NO_OP_VALUE_MISMATCH",
            "NO_OP_REPLAY requires verified normalized evidence equal to the linked canonical origin.",
          );
        }
        resolvedLinkId = currentLink.id;
      } else {
        if (
          currentLink !== null &&
          (batch.repairOfBatchId === null ||
            batch.operatorReason === null ||
            currentLink.originBatchId !== batch.repairOfBatchId)
        ) {
          throw new ApiError(
            409,
            "IMPORT_ROW_CORRECTION_LINEAGE_REQUIRED",
            "A canonical correction requires exact reviewed repair lineage.",
          );
        }
        const [createdLink] = await transaction
          .insert(legacyObjectLinks)
          .values({
            organizationId: command.actor.organizationId,
            businessUnitId: command.actor.businessUnitId,
            migrationSourceId: row.migrationSourceId,
            importRowId: row.id,
            sourceObjectType: row.sourceObjectType,
            sourceRowKey: row.sourceRowKey,
            linkVersion: currentLink === null ? 1 : currentLink.linkVersion + 1,
            supersedesLinkId: currentLink?.id ?? null,
            destinationEntityType: result.destinationEntityType,
            destinationEntityId: result.destinationEntityId,
            correctionReason: currentLink === null ? null : batch.operatorReason,
            createdByMembershipId: batch.appliedByMembershipId,
          })
          .returning({ id: legacyObjectLinks.id });
        if (!createdLink) {
          throw new ApiError(
            500,
            "IMPORT_ROW_LINEAGE_WRITE_FAILED",
            "The canonical lineage link could not be stored.",
          );
        }
        resolvedLinkId = createdLink.id;
      }

      const [updatedRow] = await transaction
        .update(importRows)
        .set({ outcome: result.outcome, resolvedLinkId })
        .where(
          and(
            eq(importRows.organizationId, command.actor.organizationId),
            eq(importRows.businessUnitId, command.actor.businessUnitId),
            eq(importRows.batchId, batch.id),
            eq(importRows.id, row.id),
            eq(importRows.version, row.rowVersion),
            eq(importRows.outcome, "VALID"),
          ),
        )
        .returning({ version: importRows.version });
      if (!updatedRow) {
        throw new ApiError(
          409,
          "IMPORT_ROW_VERSION_CONFLICT",
          "The approved import row changed during canonical apply.",
        );
      }

      const [updatedBatch] = await transaction
        .update(importBatches)
        .set({
          validRowCount: sql`${importBatches.validRowCount} - 1`,
          importedRowCount: sql`${importBatches.importedRowCount} + ${
            result.outcome === "IMPORTED" ? 1 : 0
          }`,
          noOpRowCount: sql`${importBatches.noOpRowCount} + ${
            result.outcome === "NO_OP_REPLAY" ? 1 : 0
          }`,
          applyLeaseExpiresAt: sql`greatest(
            ${importBatches.applyLeaseExpiresAt},
            clock_timestamp() + (${command.leaseSeconds} * interval '1 second')
          )`,
        })
        .where(
          and(
            eq(importBatches.id, batch.id),
            eq(importBatches.status, "APPLYING"),
            eq(importBatches.applyRunId, command.applyRunId),
            eq(
              importBatches.appliedByMembershipId,
              batch.appliedByMembershipId,
            ),
            sql`${importBatches.validRowCount} > 0`,
            sql`${importBatches.applyLeaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ version: importBatches.version });
      if (!updatedBatch) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_LEASE_EXPIRED",
          "The apply lease expired before the row transaction could commit.",
        );
      }

      const effect = {
        schemaVersion: 1,
        batchId: batch.id,
        applyRunId: command.applyRunId,
        importRowId: row.id,
        sourceObjectType: row.sourceObjectType,
        sourceRowKey: row.sourceRowKey,
        outcome: result.outcome,
        resolvedLinkId,
        destinationEntityType: result.destinationEntityType,
        destinationEntityId: result.destinationEntityId,
      };
      const actorType = eventActorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_ROW_APPLIED",
        targetType: "IMPORT_ROW",
        targetId: row.id,
        outcome: "SUCCESS",
        reason: result.outcome,
        correlationId: batch.id,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_row_applied",
        eventVersion: 1,
        aggregateType: "IMPORT_ROW",
        aggregateId: row.id,
        aggregateVersion: updatedRow.version,
        actorType,
        actorUserId: command.actor.userId,
        correlationId: batch.id,
        payload: effect,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      void actorEvidence;
      return "APPLIED";
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const constraint = databaseConstraint(error);
    if (
      constraint === "legacy_object_links_version_unique" ||
      constraint === "legacy_object_links_supersedes_unique"
    ) {
      throw new ApiError(
        409,
        "IMPORT_ROW_LINEAGE_CONFLICT",
        "Another transaction advanced the canonical lineage first.",
      );
    }
    throw new ApiError(
      500,
      "IMPORT_ROW_APPLY_FAILED",
      "The approved row and its canonical effects could not be committed.",
    );
  }
}

async function assertFinalLineage(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  batch: LockedApplyBatch,
): Promise<void> {
  const [lineage] = await transaction
    .select({
      invalidCount: sql<string>`(count(*) filter (
        where ${importRows.outcome} in ('IMPORTED', 'NO_OP_REPLAY')
          and (
            ${legacyObjectLinks.id} is null
            or ${legacyObjectLinks.migrationSourceId} <> ${batch.migrationSourceId}
            or ${legacyObjectLinks.sourceObjectType} <> ${importRows.sourceObjectType}
            or ${legacyObjectLinks.sourceRowKey} <> ${importRows.sourceRowKey}
            or (${importRows.outcome} = 'IMPORTED'
              and ${legacyObjectLinks.importRowId} <> ${importRows.id})
          )
      ))::text`,
    })
    .from(importRows)
    .leftJoin(
      legacyObjectLinks,
      and(
        eq(legacyObjectLinks.organizationId, importRows.organizationId),
        eq(legacyObjectLinks.businessUnitId, importRows.businessUnitId),
        eq(legacyObjectLinks.id, importRows.resolvedLinkId),
      ),
    )
    .where(
      and(
        eq(importRows.organizationId, actor.organizationId),
        eq(importRows.businessUnitId, actor.businessUnitId),
        eq(importRows.batchId, batch.id),
      ),
    );
  if ((lineage?.invalidCount ?? "0") !== "0") {
    throw new ApiError(
      409,
      "IMPORT_BATCH_LINEAGE_INVALID",
      "The applied row lineage is incomplete or inconsistent.",
    );
  }
}

async function finalizeApply<TTransaction, TValue>(
  database: Database,
  command: ApplyCommand<TTransaction, TValue>,
  locator: BatchLocator,
): Promise<ApplyBatchSummary> {
  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        locator.migrationSourceId,
      );
      const [batch] = await transaction
        .select({
          ...selectedApplyBatchColumns(),
          leaseLive: sql<boolean>`${importBatches.applyLeaseExpiresAt} > clock_timestamp()`,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, command.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) {
        throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      }
      if (batch.status === "APPLIED") {
        return requireExactAppliedReplay(transaction, command, batch);
      }
      if (
        batch.status !== "APPLYING" ||
        batch.applyRunId !== command.applyRunId ||
        batch.appliedByMembershipId === null ||
        batch.applyLeaseExpiresAt === null ||
        !batch.leaseLive
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_STATE_INVALID",
          "The batch cannot be finalized without its live apply ownership.",
        );
      }
      if (
        !(await ownedByActor(
          transaction,
          command.actor,
          batch.appliedByMembershipId,
        ))
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_TAKEOVER_REQUIRED",
          "Another identity owns the applying batch.",
        );
      }
      const state = await deriveValidationState(
        transaction,
        command.actor,
        batch.id,
      );
      if (
        !persistedSummaryMatches(batch, state) ||
        state.stagedRows !== 0 ||
        state.validRows !== 0 ||
        state.quarantinedRows !== 0 ||
        state.hiddenRows !== 0 ||
        state.openQuarantineRows !== 0 ||
        state.importedRows + state.noOpRows !== batch.approvedRowCount
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_INCOMPLETE",
          "The applied row counters do not match the approved subset.",
        );
      }
      await assertFinalLineage(transaction, command.actor, batch);
      assertImportBatchTransition("APPLYING", "APPLIED");
      const [updated] = await transaction
        .update(importBatches)
        .set({ status: "APPLIED", appliedAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(importBatches.id, batch.id),
            eq(importBatches.version, batch.version),
            eq(importBatches.status, "APPLYING"),
            eq(importBatches.applyRunId, command.applyRunId),
            sql`${importBatches.applyLeaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({
          version: importBatches.version,
          appliedAt: importBatches.appliedAt,
        });
      if (!updated || updated.appliedAt === null) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPLY_LEASE_EXPIRED",
          "The apply lease expired before finalization.",
        );
      }
      const effect = {
        schemaVersion: 1,
        batchId: batch.id,
        applyRunId: command.applyRunId,
        importedRows: state.importedRows,
        noOpRows: state.noOpRows,
        rejectedRows: state.rejectedRows,
        appliedAt: updated.appliedAt.toISOString(),
      };
      const actorType = eventActorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_BATCH_APPLIED",
        targetType: "IMPORT_BATCH",
        targetId: batch.id,
        outcome: "SUCCESS",
        reason: "APPROVED_ROWS_CANONICALLY_APPLIED",
        correlationId: batch.id,
        changeSummary: effect,
        occurredAt: updated.appliedAt,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_batch_applied",
        eventVersion: 1,
        aggregateType: "IMPORT_BATCH",
        aggregateId: batch.id,
        aggregateVersion: updated.version,
        actorType,
        actorUserId: command.actor.userId,
        correlationId: batch.id,
        payload: effect,
        occurredAt: updated.appliedAt,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPLY_CAPABILITY,
      );
      void actorEvidence;
      return {
        batchId: batch.id,
        importedRows: state.importedRows,
        noOpRows: state.noOpRows,
        rejectedRows: state.rejectedRows,
        appliedAt: new Date(updated.appliedAt.getTime()),
        replayed: false,
      };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_BATCH_APPLY_FINALIZE_FAILED",
      "The import batch could not be finalized.",
    );
  }
}

export async function applyImportBatch<TTransaction, TValue>(
  actor: MigrationActor,
  input: ApplyImportBatchInput<TTransaction, TValue>,
): Promise<ApplyBatchSummary> {
  const command = validateCommand(actor, input);
  const database = getDatabase();
  const locator = await locateBatch(database, command);
  const replay =
    command.mode === "START"
      ? await startApplyClaim(database, command, locator)
      : await resumeApplyOwnership(database, command, locator);
  if (replay) return replay;

  while (true) {
    const rows = await nextApprovedChunk(database, command);
    if (rows.length === 0) {
      return finalizeApply(database, command, locator);
    }
    const loadedResults = await Promise.allSettled(
      rows.map(async (row) => ({
        row,
        evidence: await loadApprovedEvidence(
          command.evidenceLoader,
          command.evidenceValidator,
          row,
        ),
      })),
    );
    const loaded: Array<{
      row: ApprovedImportRowWithSchema;
      evidence: LoadedEvidence<TValue>;
    }> = [];
    for (const result of loadedResults) {
      if (result.status === "rejected") throw result.reason;
      loaded.push(result.value);
    }
    const applyResults = await Promise.allSettled(
      loaded.map(({ row, evidence }) =>
        applyOneApprovedRow(database, command, row, evidence),
      ),
    );
    for (const result of applyResults) {
      if (result.status === "rejected") throw result.reason;
    }
  }
}
