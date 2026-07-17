import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { assertImportBatchTransition } from "@/domain/migration/batch-lifecycle";
import type { BatchValidationSummary } from "@/domain/migration/types";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  importRows,
  quarantineItems,
  type ImportRowOutcome,
} from "@/server/db/migration-schema";
import { auditEvents, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import type { MigrationActor } from "./contracts";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  type MigrationDatabaseTransaction,
  validateMigrationActor,
} from "./stage-batch";

const VALIDATE_CAPABILITY = "migration.validate";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Database = ReturnType<typeof getDatabase>;

export interface ValidateImportBatchInput {
  batchId: string;
  expectedBatchVersion: number;
}

export interface DerivedValidationState extends BatchValidationSummary {
  stagedRows: number;
  importedRows: number;
  noOpRows: number;
  openQuarantineRows: number;
}

interface ValidateCommand {
  actor: MigrationActor;
  batchId: string;
  expectedBatchVersion: number;
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

function validateCommand(
  actorInput: MigrationActor,
  input: ValidateImportBatchInput,
): ValidateCommand {
  const actor = validateMigrationActor(actorInput, VALIDATE_CAPABILITY);
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The batch validation input is invalid.");
  }
  return {
    actor,
    batchId: canonicalUuid(input.batchId, "batchId"),
    expectedBatchVersion: positiveVersion(input.expectedBatchVersion, "expectedBatchVersion"),
  };
}

export async function deriveValidationState(
  transaction: MigrationDatabaseTransaction,
  actor: MigrationActor,
  batchId: string,
): Promise<DerivedValidationState> {
  const grouped = await transaction
    .select({
      outcome: importRows.outcome,
      rowCount: sql<string>`count(*)::text`,
      invalidNormalizedCount: sql<string>`(count(*) filter (
        where ${importRows.outcome} = 'VALID'
          and (${importRows.normalizedEvidenceRef} is null
            or ${importRows.normalizedSha256} is null
            or octet_length(${importRows.normalizedSha256}) <> 32)
      ))::text`,
    })
    .from(importRows)
    .where(
      and(
        eq(importRows.organizationId, actor.organizationId),
        eq(importRows.businessUnitId, actor.businessUnitId),
        eq(importRows.batchId, batchId),
      ),
    )
    .groupBy(importRows.outcome);

  const counts = new Map<ImportRowOutcome, number>();
  let invalidNormalizedCount = 0;
  for (const row of grouped) {
    const rowCount = safeDatabaseCount(row.rowCount);
    counts.set(row.outcome, rowCount);
    invalidNormalizedCount += safeDatabaseCount(row.invalidNormalizedCount);
  }
  if (invalidNormalizedCount > 0) {
    throw new ApiError(
      409,
      "IMPORT_ROW_NORMALIZED_EVIDENCE_REQUIRED",
      "Every valid row requires protected normalized evidence.",
    );
  }
  const count = (outcome: ImportRowOutcome) => counts.get(outcome) ?? 0;
  const [openQuarantine] = await transaction
    .select({ rowCount: sql<string>`count(*)::text` })
    .from(quarantineItems)
    .innerJoin(
      importRows,
      and(
        eq(importRows.organizationId, quarantineItems.organizationId),
        eq(importRows.businessUnitId, quarantineItems.businessUnitId),
        eq(importRows.id, quarantineItems.importRowId),
      ),
    )
    .where(
      and(
        eq(quarantineItems.organizationId, actor.organizationId),
        eq(quarantineItems.businessUnitId, actor.businessUnitId),
        eq(importRows.batchId, batchId),
        eq(quarantineItems.status, "OPEN"),
      ),
    );
  const totalRows = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(totalRows)) {
    throw new ApiError(
      500,
      "IMPORT_BATCH_SUMMARY_UNSAFE",
      "The import-row summary exceeds the safe reporting range.",
    );
  }
  return {
    totalRows,
    stagedRows: count("STAGED"),
    validRows: count("VALID"),
    rejectedRows: count("REJECTED"),
    quarantinedRows: count("QUARANTINED"),
    hiddenRows: count("HIDDEN"),
    importedRows: count("IMPORTED"),
    noOpRows: count("NO_OP_REPLAY"),
    openQuarantineRows: safeDatabaseCount(openQuarantine?.rowCount ?? "0"),
  };
}

function safeDatabaseCount(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ApiError(
      500,
      "IMPORT_BATCH_SUMMARY_UNSAFE",
      "The import-row summary could not be represented safely.",
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ApiError(
      500,
      "IMPORT_BATCH_SUMMARY_UNSAFE",
      "The import-row summary exceeds the safe reporting range.",
    );
  }
  return count;
}

export function summaryFromState(state: DerivedValidationState): BatchValidationSummary {
  return {
    totalRows: state.totalRows,
    validRows: state.validRows,
    rejectedRows: state.rejectedRows,
    quarantinedRows: state.quarantinedRows,
    hiddenRows: state.hiddenRows,
  };
}

export function persistedSummaryMatches(
  batch: {
    totalRowCount: number;
    stagedRowCount: number;
    validRowCount: number;
    rejectedRowCount: number;
    quarantinedRowCount: number;
    hiddenRowCount: number;
    importedRowCount: number;
    noOpRowCount: number;
  },
  state: DerivedValidationState,
): boolean {
  return (
    batch.totalRowCount === state.totalRows &&
    batch.stagedRowCount === state.stagedRows &&
    batch.validRowCount === state.validRows &&
    batch.rejectedRowCount === state.rejectedRows &&
    batch.quarantinedRowCount === state.quarantinedRows &&
    batch.hiddenRowCount === state.hiddenRows &&
    batch.importedRowCount === state.importedRows &&
    batch.noOpRowCount === state.noOpRows
  );
}

function actorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

async function locateBatch(
  database: Database,
  command: ValidateCommand,
): Promise<{ migrationSourceId: string }> {
  const [locator] = await database
    .select({ migrationSourceId: importBatches.migrationSourceId })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, command.actor.organizationId),
        eq(importBatches.businessUnitId, command.actor.businessUnitId),
        eq(importBatches.id, command.batchId),
      ),
    )
    .limit(1);
  if (!locator) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
  return locator;
}

export async function validateImportBatch(
  actorInput: MigrationActor,
  input: ValidateImportBatchInput,
): Promise<BatchValidationSummary> {
  const command = validateCommand(actorInput, input);
  const database = getDatabase();
  const locator = await locateBatch(database, command);
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
          status: importBatches.status,
          version: importBatches.version,
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
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      if (batch.version !== command.expectedBatchVersion) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The import batch changed before validation.",
        );
      }
      if (batch.status !== "STAGED") {
        throw new ApiError(
          409,
          "IMPORT_BATCH_STATE_INVALID",
          "Only a staged import batch can be validated.",
        );
      }
      assertImportBatchTransition(batch.status, "VALIDATED");
      const state = await deriveValidationState(transaction, command.actor, command.batchId);
      if (state.stagedRows > 0) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_HAS_STAGED_ROWS",
          "Every import row requires a validation decision.",
        );
      }
      if (state.importedRows > 0 || state.noOpRows > 0) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_ROW_STATE_INVALID",
          "A staged batch cannot contain applied row outcomes.",
        );
      }
      const [updated] = await transaction
        .update(importBatches)
        .set({
          status: "VALIDATED",
          totalRowCount: state.totalRows,
          stagedRowCount: state.stagedRows,
          validRowCount: state.validRows,
          rejectedRowCount: state.rejectedRows,
          quarantinedRowCount: state.quarantinedRows,
          hiddenRowCount: state.hiddenRows,
          importedRowCount: state.importedRows,
          noOpRowCount: state.noOpRows,
          validatedByMembershipId: command.actor.activeMembershipId,
          validatedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(importBatches.id, command.batchId),
            eq(importBatches.version, command.expectedBatchVersion),
            eq(importBatches.status, "STAGED"),
          ),
        )
        .returning({ version: importBatches.version });
      if (!updated) {
        throw new ApiError(409, "IMPORT_BATCH_VERSION_CONFLICT", "The import batch changed.");
      }
      const summary = summaryFromState(state);
      const effect = { schemaVersion: 1, batchId: command.batchId, ...summary };
      const eventActorType = actorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_BATCH_VALIDATED",
        targetType: "IMPORT_BATCH",
        targetId: command.batchId,
        outcome: "SUCCESS",
        reason: "ROW_DERIVED_SUMMARY",
        correlationId: command.batchId,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_batch_validated",
        eventVersion: 1,
        aggregateType: "IMPORT_BATCH",
        aggregateId: command.batchId,
        aggregateVersion: updated.version,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        correlationId: command.batchId,
        payload: effect,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        VALIDATE_CAPABILITY,
      );
      void actorEvidence;
      return summary;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_BATCH_VALIDATION_FAILED",
      "The import batch could not be validated.",
    );
  }
}
