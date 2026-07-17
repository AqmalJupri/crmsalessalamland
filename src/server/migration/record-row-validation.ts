import "server-only";

import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import { importBatches, importRows } from "@/server/db/migration-schema";
import { auditEvents, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import {
  assertProtectedArtifactRef,
  assertSha256Digest,
  digestsEqual,
} from "./artifact-checksum";
import type { MigrationActor } from "./contracts";
import { openQuarantineItem } from "./quarantine";
import {
  type NormalizedEvidenceVerifier,
  type VerifiedNormalizedEvidence,
  verifyNormalizedEvidenceSnapshot,
} from "./normalized-evidence";
import { snapshotRedactedMigrationMetadata } from "./redacted-metadata";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  validateMigrationActor,
} from "./stage-batch";

const VALIDATE_CAPABILITY = "migration.validate";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,126}$/;

type Database = ReturnType<typeof getDatabase>;

export interface RowValidationDecision {
  outcome: "VALID" | "REJECTED" | "QUARANTINED" | "HIDDEN";
  normalizedEvidenceRef: string | null;
  normalizedSha256: Uint8Array | null;
  errorCode: string | null;
  redactedMetadata: Readonly<Record<string, unknown>>;
}

export interface RecordRowValidationInput {
  importRowId: string;
  expectedRowVersion: number;
  decision: RowValidationDecision;
}

interface ValidationCommand {
  actor: MigrationActor;
  importRowId: string;
  expectedRowVersion: number;
  decision: RowValidationDecision;
}

interface RowContext {
  batchId: string;
  migrationSourceId: string;
  batchEnvelope: {
    version: number;
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
  rawEvidenceRef: string;
  rowSha256: Uint8Array;
}

function batchEnvelopeMatches(
  current: RowContext["batchEnvelope"],
  expected: RowContext["batchEnvelope"],
): boolean {
  return (
    Number.isSafeInteger(current.version) &&
    current.version >= expected.version &&
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

function invalidDecision(message: string): never {
  throw new ApiError(422, "ROW_VALIDATION_DECISION_INVALID", message);
}

function validateDecision(input: unknown): RowValidationDecision {
  if (!input || typeof input !== "object") {
    invalidDecision("The row validation decision is invalid.");
  }
  const decision = input as RowValidationDecision;
  if (
    decision.outcome !== "VALID" &&
    decision.outcome !== "REJECTED" &&
    decision.outcome !== "QUARANTINED" &&
    decision.outcome !== "HIDDEN"
  ) {
    invalidDecision("outcome must be a supported validation decision.");
  }
  const redactedMetadata = snapshotRedactedMigrationMetadata(
    decision.redactedMetadata,
    "redactedMetadata",
  );
  if (decision.outcome === "VALID") {
    if (
      decision.normalizedEvidenceRef === null ||
      decision.normalizedSha256 === null ||
      decision.errorCode !== null
    ) {
      invalidDecision("A valid row requires normalized evidence and forbids an error code.");
    }
    assertProtectedArtifactRef(decision.normalizedEvidenceRef, "normalizedEvidenceRef");
    assertSha256Digest(decision.normalizedSha256, "normalizedSha256");
  } else {
    if (decision.normalizedEvidenceRef !== null || decision.normalizedSha256 !== null) {
      invalidDecision("Non-valid row decisions cannot carry normalized evidence.");
    }
    if (
      typeof decision.errorCode !== "string" ||
      !ERROR_CODE_PATTERN.test(decision.errorCode)
    ) {
      invalidDecision("Non-valid row decisions require a stable canonical error code.");
    }
  }
  return {
    outcome: decision.outcome,
    normalizedEvidenceRef: decision.normalizedEvidenceRef,
    normalizedSha256:
      decision.normalizedSha256 === null
        ? null
        : new Uint8Array(decision.normalizedSha256),
    errorCode: decision.errorCode,
    redactedMetadata,
  };
}

function validateCommand(
  actorInput: MigrationActor,
  input: RecordRowValidationInput,
): ValidationCommand {
  const actor = validateMigrationActor(actorInput, VALIDATE_CAPABILITY);
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The row validation input is invalid.");
  }
  return {
    actor,
    importRowId: canonicalUuid(input.importRowId, "importRowId"),
    expectedRowVersion: positiveVersion(input.expectedRowVersion, "expectedRowVersion"),
    decision: validateDecision(input.decision),
  };
}

function requireVerifier(verifier: NormalizedEvidenceVerifier): NormalizedEvidenceVerifier {
  let verify: NormalizedEvidenceVerifier["verify"];
  try {
    if (typeof verifier?.verify !== "function") throw new Error();
    verify = verifier.verify.bind(verifier);
  } catch {
    invalidDecision("A normalized evidence verifier is required.");
  }
  return { verify };
}

async function locateRow(
  database: Database,
  command: ValidationCommand,
): Promise<{ batchId: string; migrationSourceId: string }> {
  const [locator] = await database
    .select({ batchId: importRows.batchId, migrationSourceId: importBatches.migrationSourceId })
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
  if (!locator) throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
  return locator;
}

async function readRowContext(
  database: Database,
  command: ValidationCommand,
  locator: { batchId: string; migrationSourceId: string },
): Promise<RowContext> {
  return database.transaction(async (transaction) => {
    await requireActiveMigrationTenant(transaction, command.actor);
    await requireMigrationActorCapability(transaction, command.actor, VALIDATE_CAPABILITY);
    await lockAndValidateMigrationSourceAuthority(
      transaction,
      command.actor,
      locator.migrationSourceId,
    );
    const [batch] = await transaction
      .select({
        id: importBatches.id,
        status: importBatches.status,
        version: importBatches.version,
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
    if (batch.status !== "STAGED") {
      throw new ApiError(409, "IMPORT_BATCH_TERMINAL", "Only staged batches can be validated.");
    }
    const [row] = await transaction
      .select({
        outcome: importRows.outcome,
        version: importRows.version,
        rawEvidenceRef: importRows.rawEvidenceRef,
        rowSha256: importRows.rowSha256,
      })
      .from(importRows)
      .where(
        and(
          eq(importRows.organizationId, command.actor.organizationId),
          eq(importRows.businessUnitId, command.actor.businessUnitId),
          eq(importRows.batchId, batch.id),
          eq(importRows.id, command.importRowId),
        ),
      )
      .for("share")
      .limit(1);
    if (!row) throw new ApiError(404, "IMPORT_ROW_NOT_FOUND", "Import row not found.");
    if (row.version !== command.expectedRowVersion) {
      throw new ApiError(
        409,
        "IMPORT_ROW_VERSION_CONFLICT",
        "The import row changed before validation.",
      );
    }
    if (row.outcome !== "STAGED") {
      throw new ApiError(
        409,
        "IMPORT_ROW_STATE_INVALID",
        "Only a staged import row can receive a validation decision.",
      );
    }
    await requireMigrationActorCapability(transaction, command.actor, VALIDATE_CAPABILITY);
    return {
      batchId: batch.id,
      migrationSourceId: locator.migrationSourceId,
      batchEnvelope: {
        version: batch.version,
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
      rawEvidenceRef: row.rawEvidenceRef,
      rowSha256: new Uint8Array(row.rowSha256),
    };
  });
}

async function verifyNormalizedEvidence(
  decision: RowValidationDecision,
  verifier: NormalizedEvidenceVerifier,
): Promise<VerifiedNormalizedEvidence | null> {
  if (decision.outcome !== "VALID") return null;
  if (decision.normalizedEvidenceRef === null || decision.normalizedSha256 === null) {
    invalidDecision("A valid row requires normalized evidence.");
  }
  return verifyNormalizedEvidenceSnapshot(
    verifier,
    decision.normalizedEvidenceRef,
    decision.normalizedSha256,
  );
}

function nextCounter(value: number, delta: -1 | 1): number {
  const result = value + delta;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch counters are stale.");
  }
  return result;
}

function actorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

async function writeDecision(
  database: Database,
  command: ValidationCommand,
  context: RowContext,
  verified: VerifiedNormalizedEvidence | null,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        VALIDATE_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        context.migrationSourceId,
      );
      const [batch] = await transaction
        .select({
          id: importBatches.id,
          status: importBatches.status,
          version: importBatches.version,
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
          stagedRowCount: importBatches.stagedRowCount,
          validRowCount: importBatches.validRowCount,
          rejectedRowCount: importBatches.rejectedRowCount,
          hiddenRowCount: importBatches.hiddenRowCount,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, context.migrationSourceId),
            eq(importBatches.id, context.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      if (batch.status !== "STAGED") {
        throw new ApiError(409, "IMPORT_BATCH_TERMINAL", "Only staged batches can be validated.");
      }
      if (
        !batchEnvelopeMatches(
          {
            version: batch.version,
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
          context.batchEnvelope,
        )
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_CHANGED_DURING_VERIFICATION",
          "The import batch acquisition envelope changed during evidence verification.",
        );
      }
      const [row] = await transaction
        .select({
          outcome: importRows.outcome,
          version: importRows.version,
          rawEvidenceRef: importRows.rawEvidenceRef,
          rowSha256: importRows.rowSha256,
        })
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
      if (row.version !== command.expectedRowVersion || row.outcome !== "STAGED") {
        throw new ApiError(
          409,
          "IMPORT_ROW_VERSION_CONFLICT",
          "The import row changed during normalized evidence verification.",
        );
      }
      if (
        row.rawEvidenceRef !== context.rawEvidenceRef ||
        !digestsEqual(row.rowSha256, context.rowSha256)
      ) {
        throw new ApiError(
          409,
          "IMPORT_ROW_RAW_EVIDENCE_CHANGED",
          "The immutable raw evidence changed during validation.",
        );
      }
      if (batch.stagedRowCount < 1) {
        throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "Batch counters are stale.");
      }
      const [updatedRow] = await transaction
        .update(importRows)
        .set({
          outcome: command.decision.outcome,
          normalizedEvidenceRef: verified?.ref ?? null,
          normalizedSha256: verified?.sha256 ?? null,
          errorCode: command.decision.errorCode,
          errorMetadata:
            command.decision.outcome === "VALID" ? {} : command.decision.redactedMetadata,
        })
        .where(
          and(
            eq(importRows.id, command.importRowId),
            eq(importRows.version, command.expectedRowVersion),
            eq(importRows.outcome, "STAGED"),
          ),
        )
        .returning({ version: importRows.version });
      if (!updatedRow) {
        throw new ApiError(409, "IMPORT_ROW_VERSION_CONFLICT", "The import row changed.");
      }
      const [updatedBatch] = await transaction
        .update(importBatches)
        .set({
          stagedRowCount: nextCounter(batch.stagedRowCount, -1),
          validRowCount:
            command.decision.outcome === "VALID"
              ? nextCounter(batch.validRowCount, 1)
              : batch.validRowCount,
          rejectedRowCount:
            command.decision.outcome === "REJECTED"
              ? nextCounter(batch.rejectedRowCount, 1)
              : batch.rejectedRowCount,
          hiddenRowCount:
            command.decision.outcome === "HIDDEN"
              ? nextCounter(batch.hiddenRowCount, 1)
              : batch.hiddenRowCount,
        })
        .where(eq(importBatches.id, batch.id))
        .returning({ version: importBatches.version });
      if (!updatedBatch) {
        throw new ApiError(409, "IMPORT_BATCH_COUNTER_CONFLICT", "The import batch changed.");
      }
      const effect = {
        schemaVersion: 1,
        batchId: batch.id,
        importRowId: command.importRowId,
        outcome: command.decision.outcome,
        errorCode: command.decision.errorCode,
      };
      const eventActorType = actorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_ROW_VALIDATED",
        targetType: "IMPORT_ROW",
        targetId: command.importRowId,
        outcome: "SUCCESS",
        reason: command.decision.outcome,
        correlationId: batch.id,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_row_validated",
        eventVersion: 1,
        aggregateType: "IMPORT_ROW",
        aggregateId: command.importRowId,
        aggregateVersion: updatedRow.version,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        correlationId: batch.id,
        payload: effect,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        VALIDATE_CAPABILITY,
      );
      void actorEvidence;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_ROW_VALIDATION_FAILED",
      "The import-row validation could not be recorded.",
    );
  }
}

export async function recordImportRowValidation(
  actorInput: MigrationActor,
  input: RecordRowValidationInput,
  evidenceVerifier: NormalizedEvidenceVerifier,
): Promise<void> {
  const command = validateCommand(actorInput, input);
  const verifier = requireVerifier(evidenceVerifier);
  if (command.decision.outcome === "QUARANTINED") {
    await openQuarantineItem(command.actor, {
      importRowId: command.importRowId,
      expectedRowVersion: command.expectedRowVersion,
      reasonCode: command.decision.errorCode!,
      redactedMetadata: command.decision.redactedMetadata,
    });
    return;
  }
  const database = getDatabase();
  const locator = await locateRow(database, command);
  const context = await readRowContext(database, command, locator);
  const verified = await verifyNormalizedEvidence(command.decision, verifier);
  await writeDecision(database, command, context, verified);
}
