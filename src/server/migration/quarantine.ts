import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  importRows,
  quarantineItems,
} from "@/server/db/migration-schema";
import { auditEvents, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import {
  assertProtectedArtifactRef,
  assertSha256Digest,
  digestsEqual,
} from "./artifact-checksum";
import type { MigrationActor } from "./contracts";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  validateMigrationActor,
} from "./stage-batch";

const VALIDATE_CAPABILITY = "migration.validate";
const REVIEW_CAPABILITY = "migration.review_quarantine";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,126}$/;
const MAX_METADATA_BYTES = 8_192;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_COLLECTION = 128;
const MAX_METADATA_STRING = 512;

type Database = ReturnType<typeof getDatabase>;

export interface OpenQuarantineItemInput {
  importRowId: string;
  expectedRowVersion: number;
  reasonCode: string;
  redactedMetadata: Readonly<Record<string, unknown>>;
}

export interface ResolveQuarantineInput {
  quarantineItemId: string;
  disposition: "APPROVE_ROW" | "REJECT_ROW";
  resolutionReason: string;
  correctedNormalizedEvidenceRef: string | null;
  expectedNormalizedSha256: Uint8Array | null;
  expectedItemVersion: number;
  expectedRowVersion: number;
}

export interface VerifiedNormalizedEvidence {
  ref: string;
  sha256: Uint8Array;
}

export interface NormalizedEvidenceVerifier {
  verify(
    ref: string,
    expectedSha256: Uint8Array | null,
  ): Promise<VerifiedNormalizedEvidence>;
}

interface OpenCommand {
  actor: MigrationActor;
  importRowId: string;
  expectedRowVersion: number;
  reasonCode: string;
  redactedMetadata: Record<string, unknown>;
}

interface ResolveCommand {
  actor: MigrationActor;
  quarantineItemId: string;
  disposition: "APPROVE_ROW" | "REJECT_ROW";
  resolutionReason: string;
  correctedNormalizedEvidenceRef: string | null;
  expectedNormalizedSha256: Uint8Array | null;
  expectedItemVersion: number;
  expectedRowVersion: number;
}

interface ResolutionLocator {
  quarantineItemId: string;
  importRowId: string;
  batchId: string;
  migrationSourceId: string;
}

interface ResolutionReadContext extends ResolutionLocator {
  batchEnvelope: {
    transformVersionId: string;
    validatedDryRunBatchId: string | null;
    repairOfBatchId: string | null;
    protectedArtifactRef: string;
    sourceSha256: Uint8Array;
    sizeBytes: bigint;
    capturedAt: Date;
    cutoffAt: Date;
    schemaVersion: string;
    dryRun: boolean;
    operatorReason: string | null;
  };
  itemVersion: number;
  rowVersion: number;
  rawEvidenceRef: string;
  rowSha256: Uint8Array;
  normalizedEvidenceRef: string | null;
  normalizedSha256: Uint8Array | null;
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(
      422,
      "MIGRATION_INPUT_INVALID",
      `${field} must be a positive safe integer.`,
    );
  }
  return value as number;
}

function safeCounterChange(value: number, delta: -1 | 1): number {
  const result = value + delta;
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(result) || result < 0) {
    throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch counters are stale.");
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function metadataFailure(): never {
  throw new ApiError(
    422,
    "MIGRATION_METADATA_NOT_REDACTED",
    "Migration metadata must contain only bounded redacted codes.",
  );
}

function stringLooksSensitive(value: string): boolean {
  const trimmed = value.trim();
  if (value.length > MAX_METADATA_STRING || /[\u0000-\u001f\u007f]/.test(value)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return true;
  if (/(?:^|\D)\+?\d[\d\s().-]{7,}\d(?:\D|$)/.test(value)) return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/i.test(value)) return true;
  if (/\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)\s*[:=]/i.test(value)) {
    return true;
  }
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) {
    return true;
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") return true;
    } catch {
      return true;
    }
  }
  return false;
}

function keyLooksSensitive(key: string): boolean {
  const canonicalKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[_-])(?:email|phone|mobile|telephone|name|address|nric|passport|password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|payload|raw|customer|record)(?:$|[_-])/i.test(
    canonicalKey,
  );
}

function inspectRedactedValue(value: unknown, depth: number): void {
  if (depth > MAX_METADATA_DEPTH) metadataFailure();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) metadataFailure();
    return;
  }
  if (typeof value === "string") {
    if (stringLooksSensitive(value)) metadataFailure();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_COLLECTION) metadataFailure();
    for (const entry of value) inspectRedactedValue(entry, depth + 1);
    return;
  }
  if (!isPlainObject(value)) metadataFailure();
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_COLLECTION) metadataFailure();
  for (const [key, entry] of entries) {
    if (
      key.length < 1 ||
      key.length > 64 ||
      !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(key) ||
      keyLooksSensitive(key)
    ) {
      metadataFailure();
    }
    inspectRedactedValue(entry, depth + 1);
  }
}

export function assertRedactedMigrationMetadata(
  value: unknown,
  field: string,
): asserts value is Readonly<Record<string, unknown>> {
  void field;
  if (!isPlainObject(value)) metadataFailure();
  inspectRedactedValue(value, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    metadataFailure();
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) metadataFailure();
}

function cloneMetadata(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateOpenCommand(
  actorInput: MigrationActor,
  input: OpenQuarantineItemInput,
): OpenCommand {
  const actor = validateMigrationActor(actorInput, VALIDATE_CAPABILITY);
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The quarantine command is invalid.");
  }
  if (typeof input.reasonCode !== "string" || !REASON_CODE_PATTERN.test(input.reasonCode)) {
    throw new ApiError(
      422,
      "QUARANTINE_REASON_INVALID",
      "reasonCode must be a bounded canonical reason code.",
    );
  }
  assertRedactedMigrationMetadata(input.redactedMetadata, "redactedMetadata");
  return {
    actor,
    importRowId: canonicalUuid(input.importRowId, "importRowId"),
    expectedRowVersion: positiveVersion(input.expectedRowVersion, "expectedRowVersion"),
    reasonCode: input.reasonCode,
    redactedMetadata: cloneMetadata(input.redactedMetadata),
  };
}

function resolutionInvalid(message: string): never {
  throw new ApiError(422, "QUARANTINE_RESOLUTION_INVALID", message);
}

function validateResolutionReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 2_000 ||
    stringLooksSensitive(value)
  ) {
    resolutionInvalid("resolutionReason must be bounded, non-empty, and redacted.");
  }
  return value;
}

function validateResolveCommand(
  actorInput: MigrationActor,
  input: ResolveQuarantineInput,
): ResolveCommand {
  const actor = validateMigrationActor(actorInput, REVIEW_CAPABILITY);
  if (!input || typeof input !== "object") {
    resolutionInvalid("The quarantine resolution command is invalid.");
  }
  if (input.disposition !== "APPROVE_ROW" && input.disposition !== "REJECT_ROW") {
    resolutionInvalid("disposition must be APPROVE_ROW or REJECT_ROW.");
  }
  const correctedRef = input.correctedNormalizedEvidenceRef;
  const expectedSha = input.expectedNormalizedSha256;
  if (input.disposition === "REJECT_ROW") {
    if (correctedRef !== null || expectedSha !== null) {
      throw new ApiError(
        422,
        "QUARANTINE_CORRECTION_FORBIDDEN",
        "Rejected rows cannot carry corrected normalized evidence.",
      );
    }
  } else if (correctedRef !== null) {
    assertProtectedArtifactRef(correctedRef, "correctedNormalizedEvidenceRef");
    if (expectedSha === null) {
      resolutionInvalid("Corrected normalized evidence requires a reviewed checksum.");
    }
    assertSha256Digest(expectedSha, "expectedNormalizedSha256");
  } else if (expectedSha !== null) {
    resolutionInvalid("A normalized checksum cannot be supplied without corrected evidence.");
  }
  return {
    actor,
    quarantineItemId: canonicalUuid(input.quarantineItemId, "quarantineItemId"),
    disposition: input.disposition,
    resolutionReason: validateResolutionReason(input.resolutionReason),
    correctedNormalizedEvidenceRef: correctedRef,
    expectedNormalizedSha256:
      expectedSha === null ? null : new Uint8Array(expectedSha),
    expectedItemVersion: positiveVersion(input.expectedItemVersion, "expectedItemVersion"),
    expectedRowVersion: positiveVersion(input.expectedRowVersion, "expectedRowVersion"),
  };
}

async function locateRow(
  database: Database,
  command: OpenCommand,
): Promise<{ importRowId: string; batchId: string; migrationSourceId: string }> {
  const [locator] = await database
    .select({
      importRowId: importRows.id,
      batchId: importRows.batchId,
      migrationSourceId: importBatches.migrationSourceId,
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
        eq(importRows.id, command.importRowId),
      ),
    )
    .limit(1);
  if (!locator) {
    throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
  }
  return locator;
}

function assertMutableStagedBatch(status: string): void {
  if (status !== "STAGED") {
    throw new ApiError(
      409,
      "IMPORT_BATCH_TERMINAL",
      "Quarantine can change only rows in a staged batch.",
    );
  }
}

function resolutionBatchEnvelopeMatches(
  current: ResolutionReadContext["batchEnvelope"],
  expected: ResolutionReadContext["batchEnvelope"],
): boolean {
  return (
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
    current.operatorReason === expected.operatorReason
  );
}

function eventActorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

export async function openQuarantineItem(
  actorInput: MigrationActor,
  input: OpenQuarantineItemInput,
): Promise<{ quarantineItemId: string; replayed: boolean }> {
  const command = validateOpenCommand(actorInput, input);
  const database = getDatabase();
  const locator = await locateRow(database, command);
  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        VALIDATE_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        locator.migrationSourceId,
      );
      const [batch] = await transaction
        .select({
          id: importBatches.id,
          status: importBatches.status,
          stagedRowCount: importBatches.stagedRowCount,
          quarantinedRowCount: importBatches.quarantinedRowCount,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, locator.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      assertMutableStagedBatch(batch.status);
      const [row] = await transaction
        .select({ id: importRows.id, outcome: importRows.outcome, version: importRows.version })
        .from(importRows)
        .where(
          and(
            eq(importRows.organizationId, command.actor.organizationId),
            eq(importRows.businessUnitId, command.actor.businessUnitId),
            eq(importRows.batchId, batch.id),
            eq(importRows.id, command.importRowId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
      const openItems = await transaction
        .select({
          id: quarantineItems.id,
          reasonCode: quarantineItems.reasonCode,
          reasonMetadata: quarantineItems.reasonMetadata,
        })
        .from(quarantineItems)
        .where(
          and(
            eq(quarantineItems.organizationId, command.actor.organizationId),
            eq(quarantineItems.businessUnitId, command.actor.businessUnitId),
            eq(quarantineItems.importRowId, row.id),
            eq(quarantineItems.status, "OPEN"),
          ),
        )
        .orderBy(asc(quarantineItems.reasonCode), asc(quarantineItems.id))
        .for("update");
      const sameReason = openItems.find((item) => item.reasonCode === command.reasonCode);
      if (sameReason) {
        if (row.outcome !== "QUARANTINED" || batch.quarantinedRowCount < 1) {
          throw new ApiError(
            409,
            "QUARANTINE_STATE_CONFLICT",
            "The open quarantine item is not backed by a quarantined row summary.",
          );
        }
        if (canonicalJson(sameReason.reasonMetadata) !== canonicalJson(command.redactedMetadata)) {
          throw new ApiError(
            409,
            "QUARANTINE_IDEMPOTENCY_CONFLICT",
            "The open quarantine reason already binds different redacted evidence.",
          );
        }
        await requireMigrationActorCapability(
          transaction,
          command.actor,
          VALIDATE_CAPABILITY,
        );
        return { quarantineItemId: sameReason.id, replayed: true };
      }
      if (row.version !== command.expectedRowVersion) {
        throw new ApiError(
          409,
          "QUARANTINE_VERSION_CONFLICT",
          "The import row changed before quarantine was recorded.",
        );
      }
      if (row.outcome !== "STAGED" && row.outcome !== "QUARANTINED") {
        throw new ApiError(
          409,
          "QUARANTINE_ROW_STATE_INVALID",
          "Only staged or already quarantined rows can receive a quarantine reason.",
        );
      }
      if (
        (row.outcome === "STAGED" && batch.stagedRowCount < 1) ||
        (row.outcome === "QUARANTINED" && batch.quarantinedRowCount < 1)
      ) {
        throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch counters are stale.");
      }
      const [created] = await transaction
        .insert(quarantineItems)
        .values({
          organizationId: command.actor.organizationId,
          businessUnitId: command.actor.businessUnitId,
          importRowId: row.id,
          reasonCode: command.reasonCode,
          reasonMetadata: command.redactedMetadata,
        })
        .returning({ id: quarantineItems.id, version: quarantineItems.version });
      if (!created) {
        throw new ApiError(500, "QUARANTINE_CREATE_FAILED", "Quarantine was not stored.");
      }
      let rowVersion = row.version;
      if (row.outcome === "STAGED") {
        if (batch.stagedRowCount < 1) {
          throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch counters are stale.");
        }
        const [updatedRow] = await transaction
          .update(importRows)
          .set({
            outcome: "QUARANTINED",
            errorCode: command.reasonCode,
            errorMetadata: command.redactedMetadata,
          })
          .where(eq(importRows.id, row.id))
          .returning({ version: importRows.version });
        if (!updatedRow) throw new ApiError(409, "QUARANTINE_VERSION_CONFLICT", "Row changed.");
        rowVersion = updatedRow.version;
        const [updatedBatch] = await transaction
          .update(importBatches)
          .set({
            stagedRowCount: safeCounterChange(batch.stagedRowCount, -1),
            quarantinedRowCount: safeCounterChange(batch.quarantinedRowCount, 1),
          })
          .where(eq(importBatches.id, batch.id))
          .returning({ id: importBatches.id });
        if (!updatedBatch) {
          throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch changed.");
        }
      } else {
        const [updatedRow] = await transaction
          .update(importRows)
          .set({ updatedAt: sql`transaction_timestamp()` })
          .where(and(eq(importRows.id, row.id), eq(importRows.version, row.version)))
          .returning({ version: importRows.version });
        if (!updatedRow) {
          throw new ApiError(409, "QUARANTINE_VERSION_CONFLICT", "Row changed.");
        }
        rowVersion = updatedRow.version;
      }
      const effect = {
        schemaVersion: 1,
        quarantineItemId: created.id,
        importRowId: row.id,
        reasonCode: command.reasonCode,
      };
      const actorType = eventActorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_ROW_QUARANTINED",
        targetType: "IMPORT_ROW",
        targetId: row.id,
        outcome: "SUCCESS",
        reason: command.reasonCode,
        correlationId: created.id,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_row_quarantined",
        eventVersion: 1,
        aggregateType: "IMPORT_ROW",
        aggregateId: row.id,
        aggregateVersion: rowVersion,
        actorType,
        actorUserId: command.actor.userId,
        correlationId: created.id,
        payload: effect,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        VALIDATE_CAPABILITY,
      );
      void actorEvidence;
      return { quarantineItemId: created.id, replayed: false };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const constraint =
      error && typeof error === "object" && "constraint_name" in error
        ? (error as { constraint_name?: unknown }).constraint_name
        : undefined;
    if (constraint === "quarantine_items_open_unique") {
      throw new ApiError(
        409,
        "QUARANTINE_IDEMPOTENCY_CONFLICT",
        "The quarantine reason was concurrently opened.",
      );
    }
    throw new ApiError(
      500,
      "QUARANTINE_CREATE_FAILED",
      "The quarantine item could not be recorded.",
    );
  }
}

async function locateResolution(
  database: Database,
  command: ResolveCommand,
): Promise<ResolutionLocator> {
  const [locator] = await database
    .select({
      quarantineItemId: quarantineItems.id,
      importRowId: importRows.id,
      batchId: importBatches.id,
      migrationSourceId: importBatches.migrationSourceId,
    })
    .from(quarantineItems)
    .innerJoin(
      importRows,
      and(
        eq(importRows.organizationId, quarantineItems.organizationId),
        eq(importRows.businessUnitId, quarantineItems.businessUnitId),
        eq(importRows.id, quarantineItems.importRowId),
      ),
    )
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
        eq(quarantineItems.organizationId, command.actor.organizationId),
        eq(quarantineItems.businessUnitId, command.actor.businessUnitId),
        eq(quarantineItems.id, command.quarantineItemId),
      ),
    )
    .limit(1);
  if (!locator) {
    throw new ApiError(404, "QUARANTINE_ITEM_NOT_FOUND", "Quarantine item not found.");
  }
  return locator;
}

async function readResolutionContext(
  database: Database,
  command: ResolveCommand,
  locator: ResolutionLocator,
): Promise<ResolutionReadContext> {
  return database.transaction(async (transaction) => {
    await requireActiveMigrationTenant(transaction, command.actor);
    await requireMigrationActorCapability(transaction, command.actor, REVIEW_CAPABILITY);
    await lockAndValidateMigrationSourceAuthority(
      transaction,
      command.actor,
      locator.migrationSourceId,
    );
    const [batch] = await transaction
      .select({
        id: importBatches.id,
        status: importBatches.status,
        transformVersionId: importBatches.transformVersionId,
        validatedDryRunBatchId: importBatches.validatedDryRunBatchId,
        repairOfBatchId: importBatches.repairOfBatchId,
        protectedArtifactRef: importBatches.protectedArtifactRef,
        sourceSha256: importBatches.sourceSha256,
        sizeBytes: importBatches.sizeBytes,
        capturedAt: importBatches.capturedAt,
        cutoffAt: importBatches.cutoffAt,
        schemaVersion: importBatches.schemaVersion,
        dryRun: importBatches.dryRun,
        operatorReason: importBatches.operatorReason,
      })
      .from(importBatches)
      .where(
        and(
          eq(importBatches.organizationId, command.actor.organizationId),
          eq(importBatches.businessUnitId, command.actor.businessUnitId),
          eq(importBatches.migrationSourceId, locator.migrationSourceId),
          eq(importBatches.id, locator.batchId),
        ),
      )
      .for("share")
      .limit(1);
    if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
    assertMutableStagedBatch(batch.status);
    const [row] = await transaction
      .select({
        id: importRows.id,
        outcome: importRows.outcome,
        rawEvidenceRef: importRows.rawEvidenceRef,
        rowSha256: importRows.rowSha256,
        normalizedEvidenceRef: importRows.normalizedEvidenceRef,
        normalizedSha256: importRows.normalizedSha256,
        version: importRows.version,
      })
      .from(importRows)
      .where(
        and(
          eq(importRows.organizationId, command.actor.organizationId),
          eq(importRows.businessUnitId, command.actor.businessUnitId),
          eq(importRows.batchId, batch.id),
          eq(importRows.id, locator.importRowId),
        ),
      )
      .for("share")
      .limit(1);
    if (!row) throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
    const [item] = await transaction
      .select({
        id: quarantineItems.id,
        status: quarantineItems.status,
        version: quarantineItems.version,
      })
      .from(quarantineItems)
      .where(
        and(
          eq(quarantineItems.organizationId, command.actor.organizationId),
          eq(quarantineItems.businessUnitId, command.actor.businessUnitId),
          eq(quarantineItems.importRowId, row.id),
          eq(quarantineItems.id, locator.quarantineItemId),
        ),
      )
      .for("share")
      .limit(1);
    if (!item) {
      throw new ApiError(404, "QUARANTINE_ITEM_NOT_FOUND", "Quarantine item not found.");
    }
    if (row.outcome !== "QUARANTINED" || item.status !== "OPEN") {
      throw new ApiError(
        409,
        "QUARANTINE_STATE_CONFLICT",
        "Only an open item on a quarantined row can be resolved.",
      );
    }
    if (item.version !== command.expectedItemVersion || row.version !== command.expectedRowVersion) {
      throw new ApiError(
        409,
        "QUARANTINE_VERSION_CONFLICT",
        "The quarantine item or import row changed before review.",
      );
    }
    await requireMigrationActorCapability(transaction, command.actor, REVIEW_CAPABILITY);
    return {
      ...locator,
      batchEnvelope: {
        transformVersionId: batch.transformVersionId,
        validatedDryRunBatchId: batch.validatedDryRunBatchId,
        repairOfBatchId: batch.repairOfBatchId,
        protectedArtifactRef: batch.protectedArtifactRef,
        sourceSha256: new Uint8Array(batch.sourceSha256),
        sizeBytes: batch.sizeBytes,
        capturedAt: new Date(batch.capturedAt.getTime()),
        cutoffAt: new Date(batch.cutoffAt.getTime()),
        schemaVersion: batch.schemaVersion,
        dryRun: batch.dryRun,
        operatorReason: batch.operatorReason,
      },
      itemVersion: item.version,
      rowVersion: row.version,
      rawEvidenceRef: row.rawEvidenceRef,
      rowSha256: new Uint8Array(row.rowSha256),
      normalizedEvidenceRef: row.normalizedEvidenceRef,
      normalizedSha256:
        row.normalizedSha256 === null ? null : new Uint8Array(row.normalizedSha256),
    };
  });
}

async function verifyCorrectedEvidence(
  command: ResolveCommand,
  verifier: NormalizedEvidenceVerifier,
): Promise<VerifiedNormalizedEvidence | null> {
  if (command.correctedNormalizedEvidenceRef === null) return null;
  let untrusted: unknown;
  try {
    untrusted = await verifier.verify(
      command.correctedNormalizedEvidenceRef,
      command.expectedNormalizedSha256 === null
        ? null
        : new Uint8Array(command.expectedNormalizedSha256),
    );
  } catch {
    throw new ApiError(
      422,
      "NORMALIZED_EVIDENCE_VERIFICATION_FAILED",
      "Corrected normalized evidence could not be verified.",
    );
  }
  if (!untrusted || typeof untrusted !== "object") {
    throw new ApiError(
      422,
      "NORMALIZED_EVIDENCE_BINDING_INVALID",
      "Verified normalized evidence did not bind the reviewed correction.",
    );
  }
  const verified = untrusted as VerifiedNormalizedEvidence;
  if (
    typeof verified.ref !== "string" ||
    !(verified.sha256 instanceof Uint8Array) ||
    verified.sha256.byteLength !== 32 ||
    verified.ref !== command.correctedNormalizedEvidenceRef ||
    command.expectedNormalizedSha256 === null ||
    !digestsEqual(verified.sha256, command.expectedNormalizedSha256)
  ) {
    throw new ApiError(
      422,
      "NORMALIZED_EVIDENCE_BINDING_INVALID",
      "Verified normalized evidence did not bind the reviewed correction.",
    );
  }
  return { ref: verified.ref, sha256: new Uint8Array(verified.sha256) };
}

function normalizedEvidenceEqual(
  leftRef: string | null,
  leftSha: Uint8Array | null,
  right: VerifiedNormalizedEvidence,
): boolean {
  return leftRef === right.ref && leftSha !== null && digestsEqual(leftSha, right.sha256);
}

async function writeResolution(
  database: Database,
  command: ResolveCommand,
  expected: ResolutionReadContext,
  verifiedCorrection: VerifiedNormalizedEvidence | null,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        REVIEW_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        expected.migrationSourceId,
      );
      const [batch] = await transaction
        .select({
          id: importBatches.id,
          status: importBatches.status,
          transformVersionId: importBatches.transformVersionId,
          validatedDryRunBatchId: importBatches.validatedDryRunBatchId,
          repairOfBatchId: importBatches.repairOfBatchId,
          protectedArtifactRef: importBatches.protectedArtifactRef,
          sourceSha256: importBatches.sourceSha256,
          sizeBytes: importBatches.sizeBytes,
          capturedAt: importBatches.capturedAt,
          cutoffAt: importBatches.cutoffAt,
          schemaVersion: importBatches.schemaVersion,
          dryRun: importBatches.dryRun,
          operatorReason: importBatches.operatorReason,
          validRowCount: importBatches.validRowCount,
          rejectedRowCount: importBatches.rejectedRowCount,
          quarantinedRowCount: importBatches.quarantinedRowCount,
          version: importBatches.version,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, expected.migrationSourceId),
            eq(importBatches.id, expected.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      assertMutableStagedBatch(batch.status);
      if (
        !resolutionBatchEnvelopeMatches(
          {
            transformVersionId: batch.transformVersionId,
            validatedDryRunBatchId: batch.validatedDryRunBatchId,
            repairOfBatchId: batch.repairOfBatchId,
            protectedArtifactRef: batch.protectedArtifactRef,
            sourceSha256: batch.sourceSha256,
            sizeBytes: batch.sizeBytes,
            capturedAt: batch.capturedAt,
            cutoffAt: batch.cutoffAt,
            schemaVersion: batch.schemaVersion,
            dryRun: batch.dryRun,
            operatorReason: batch.operatorReason,
          },
          expected.batchEnvelope,
        )
      ) {
        throw new ApiError(
          409,
          "QUARANTINE_BATCH_CHANGED",
          "The import batch acquisition envelope changed during evidence review.",
        );
      }
      const [row] = await transaction
        .select({
          id: importRows.id,
          outcome: importRows.outcome,
          errorCode: importRows.errorCode,
          rawEvidenceRef: importRows.rawEvidenceRef,
          rowSha256: importRows.rowSha256,
          normalizedEvidenceRef: importRows.normalizedEvidenceRef,
          normalizedSha256: importRows.normalizedSha256,
          version: importRows.version,
        })
        .from(importRows)
        .where(
          and(
            eq(importRows.organizationId, command.actor.organizationId),
            eq(importRows.businessUnitId, command.actor.businessUnitId),
            eq(importRows.batchId, batch.id),
            eq(importRows.id, expected.importRowId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
      const items = await transaction
        .select({
          id: quarantineItems.id,
          reasonCode: quarantineItems.reasonCode,
          status: quarantineItems.status,
          resolution: quarantineItems.resolution,
          version: quarantineItems.version,
        })
        .from(quarantineItems)
        .where(
          and(
            eq(quarantineItems.organizationId, command.actor.organizationId),
            eq(quarantineItems.businessUnitId, command.actor.businessUnitId),
            eq(quarantineItems.importRowId, row.id),
          ),
        )
        .orderBy(asc(quarantineItems.reasonCode), asc(quarantineItems.id))
        .for("update");
      const item = items.find((candidate) => candidate.id === command.quarantineItemId);
      if (!item) {
        throw new ApiError(404, "QUARANTINE_ITEM_NOT_FOUND", "Quarantine item not found.");
      }
      if (
        row.outcome !== "QUARANTINED" ||
        item.status !== "OPEN" ||
        item.version !== command.expectedItemVersion ||
        row.version !== command.expectedRowVersion ||
        item.version !== expected.itemVersion ||
        row.version !== expected.rowVersion
      ) {
        throw new ApiError(
          409,
          "QUARANTINE_VERSION_CONFLICT",
          "The quarantine item or import row changed during evidence review.",
        );
      }
      if (
        row.rawEvidenceRef !== expected.rawEvidenceRef ||
        !digestsEqual(row.rowSha256, expected.rowSha256)
      ) {
        throw new ApiError(
          409,
          "QUARANTINE_RAW_EVIDENCE_CHANGED",
          "The immutable raw evidence changed during review.",
        );
      }

      let normalizedRef = row.normalizedEvidenceRef;
      let normalizedSha = row.normalizedSha256;
      if (verifiedCorrection !== null) {
        if (
          normalizedRef !== null &&
          !normalizedEvidenceEqual(normalizedRef, normalizedSha, verifiedCorrection)
        ) {
          throw new ApiError(
            409,
            "QUARANTINE_NORMALIZED_EVIDENCE_CONFLICT",
            "Approved quarantine reasons must share one normalized evidence envelope.",
          );
        }
        normalizedRef = verifiedCorrection.ref;
        normalizedSha = verifiedCorrection.sha256;
      }
      if (
        command.disposition === "APPROVE_ROW" &&
        (normalizedRef === null || normalizedSha === null || normalizedSha.byteLength !== 32)
      ) {
        throw new ApiError(
          409,
          "QUARANTINE_NORMALIZED_EVIDENCE_REQUIRED",
          "Approval requires verified normalized evidence.",
        );
      }
      if (command.disposition === "APPROVE_ROW" && normalizedRef !== null) {
        assertProtectedArtifactRef(normalizedRef, "normalizedEvidenceRef");
        assertSha256Digest(normalizedSha, "normalizedSha256");
      }

      const remainingOpen = items.filter(
        (candidate) => candidate.id !== item.id && candidate.status === "OPEN",
      );
      const rejectedReasons = items
        .filter(
          (candidate) =>
            candidate.id !== item.id &&
            candidate.status === "RESOLVED" &&
            candidate.resolution === "REJECT_ROW",
        )
        .map((candidate) => candidate.reasonCode);
      if (command.disposition === "REJECT_ROW") rejectedReasons.push(item.reasonCode);
      rejectedReasons.sort();
      const finalOutcome =
        remainingOpen.length > 0
          ? "QUARANTINED"
          : rejectedReasons.length > 0
            ? "REJECTED"
            : "VALID";

      const [resolved] = await transaction
        .update(quarantineItems)
        .set({
          status: "RESOLVED",
          resolution: command.disposition,
          resolvedByMembershipId: command.actor.activeMembershipId,
          resolvedAt: sql`transaction_timestamp()`,
          resolutionReason: command.resolutionReason,
        })
        .where(
          and(
            eq(quarantineItems.id, item.id),
            eq(quarantineItems.status, "OPEN"),
            eq(quarantineItems.version, item.version),
          ),
        )
        .returning({ version: quarantineItems.version });
      if (!resolved) {
        throw new ApiError(409, "QUARANTINE_VERSION_CONFLICT", "Quarantine changed.");
      }

      const shouldUpdateNormalized =
        normalizedRef !== row.normalizedEvidenceRef ||
        (normalizedSha !== null &&
          (row.normalizedSha256 === null || !digestsEqual(normalizedSha, row.normalizedSha256)));
      if (finalOutcome === "QUARANTINED") {
        const [updatedRow] = await transaction
          .update(importRows)
          .set(
            shouldUpdateNormalized
              ? {
                  normalizedEvidenceRef: normalizedRef,
                  normalizedSha256: normalizedSha,
                  updatedAt: sql`transaction_timestamp()`,
                }
              : { updatedAt: sql`transaction_timestamp()` },
          )
          .where(and(eq(importRows.id, row.id), eq(importRows.version, row.version)))
          .returning({ version: importRows.version });
        if (!updatedRow) {
          throw new ApiError(409, "QUARANTINE_VERSION_CONFLICT", "Row changed.");
        }
      } else {
        if (batch.quarantinedRowCount < 1) {
          throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch counters are stale.");
        }
        const [updatedRow] = await transaction
          .update(importRows)
          .set({
            outcome: finalOutcome,
            normalizedEvidenceRef: normalizedRef,
            normalizedSha256: normalizedSha,
            errorCode: finalOutcome === "VALID" ? null : rejectedReasons[0]!,
            errorMetadata:
              finalOutcome === "VALID" ? {} : { reasonCode: rejectedReasons[0]! },
          })
          .where(and(eq(importRows.id, row.id), eq(importRows.version, row.version)))
          .returning({ version: importRows.version });
        if (!updatedRow) {
          throw new ApiError(409, "QUARANTINE_VERSION_CONFLICT", "Row changed.");
        }
        const [updatedBatch] = await transaction
          .update(importBatches)
          .set({
            quarantinedRowCount: safeCounterChange(batch.quarantinedRowCount, -1),
            validRowCount:
              finalOutcome === "VALID"
                ? safeCounterChange(batch.validRowCount, 1)
                : batch.validRowCount,
            rejectedRowCount:
              finalOutcome === "REJECTED"
                ? safeCounterChange(batch.rejectedRowCount, 1)
                : batch.rejectedRowCount,
          })
          .where(eq(importBatches.id, batch.id))
          .returning({ id: importBatches.id });
        if (!updatedBatch) {
          throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch changed.");
        }
      }

      const effect = {
        schemaVersion: 1,
        quarantineItemId: item.id,
        importRowId: row.id,
        reasonCode: item.reasonCode,
        disposition: command.disposition,
        resultingRowOutcome: finalOutcome,
        remainingOpenReasonCount: remainingOpen.length,
      };
      const actorType = eventActorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_QUARANTINE_RESOLVED",
        targetType: "QUARANTINE_ITEM",
        targetId: item.id,
        outcome: "SUCCESS",
        reason: command.disposition,
        correlationId: item.id,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.quarantine_resolved",
        eventVersion: 1,
        aggregateType: "QUARANTINE_ITEM",
        aggregateId: item.id,
        aggregateVersion: resolved.version,
        actorType,
        actorUserId: command.actor.userId,
        correlationId: item.id,
        payload: effect,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        REVIEW_CAPABILITY,
      );
      void actorEvidence;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "QUARANTINE_RESOLUTION_FAILED",
      "The quarantine resolution could not be recorded.",
    );
  }
}

export async function resolveQuarantineItem(
  actorInput: MigrationActor,
  input: ResolveQuarantineInput,
  evidenceVerifier: NormalizedEvidenceVerifier,
): Promise<void> {
  const command = validateResolveCommand(actorInput, input);
  let verifyEvidence: NormalizedEvidenceVerifier["verify"];
  try {
    const candidate = evidenceVerifier?.verify;
    if (typeof candidate !== "function") throw new Error();
    verifyEvidence = candidate.bind(evidenceVerifier);
  } catch {
    resolutionInvalid("A normalized evidence verifier is required.");
  }
  const trustedVerifier: NormalizedEvidenceVerifier = { verify: verifyEvidence };
  const database = getDatabase();
  const locator = await locateResolution(database, command);
  const context = await readResolutionContext(database, command, locator);
  const verifiedCorrection = await verifyCorrectedEvidence(command, trustedVerifier);
  await writeResolution(database, command, context, verifiedCorrection);
}
