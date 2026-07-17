import "server-only";

import { and, eq } from "drizzle-orm";
import { assertImportBatchTransition } from "@/domain/migration/batch-lifecycle";
import type { BatchValidationSummary } from "@/domain/migration/types";
import { getDatabase } from "@/server/db/client";
import { importBatches } from "@/server/db/migration-schema";
import { auditEvents, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import type { MigrationActor } from "./contracts";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  validateMigrationActor,
} from "./stage-batch";
import {
  deriveValidationState,
  persistedSummaryMatches,
  summaryFromState,
} from "./validate-batch";

const VALIDATE_CAPABILITY = "migration.validate";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Database = ReturnType<typeof getDatabase>;

export interface CompleteDryRunInput {
  batchId: string;
  expectedValidatedBatchVersion: number;
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

function actorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

export async function completeDryRun(
  actorInput: MigrationActor,
  input: CompleteDryRunInput,
): Promise<BatchValidationSummary> {
  const actor = validateMigrationActor(actorInput, VALIDATE_CAPABILITY);
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The dry-run completion input is invalid.");
  }
  const batchId = canonicalUuid(input.batchId, "batchId");
  const expectedVersion = positiveVersion(
    input.expectedValidatedBatchVersion,
    "expectedValidatedBatchVersion",
  );
  const database: Database = getDatabase();
  const [locator] = await database
    .select({ migrationSourceId: importBatches.migrationSourceId })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, actor.organizationId),
        eq(importBatches.businessUnitId, actor.businessUnitId),
        eq(importBatches.id, batchId),
      ),
    )
    .limit(1);
  if (!locator) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");

  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        actor,
        VALIDATE_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        actor,
        locator.migrationSourceId,
      );
      const [batch] = await transaction
        .select({
          status: importBatches.status,
          dryRun: importBatches.dryRun,
          version: importBatches.version,
          totalRowCount: importBatches.totalRowCount,
          stagedRowCount: importBatches.stagedRowCount,
          validRowCount: importBatches.validRowCount,
          rejectedRowCount: importBatches.rejectedRowCount,
          quarantinedRowCount: importBatches.quarantinedRowCount,
          hiddenRowCount: importBatches.hiddenRowCount,
          importedRowCount: importBatches.importedRowCount,
          noOpRowCount: importBatches.noOpRowCount,
          approvedRowCount: importBatches.approvedRowCount,
          approvalMode: importBatches.approvalMode,
          approvedByMembershipId: importBatches.approvedByMembershipId,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, actor.organizationId),
            eq(importBatches.businessUnitId, actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      if (batch.version !== expectedVersion) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The validated dry run changed before completion.",
        );
      }
      if (batch.status !== "VALIDATED" || !batch.dryRun) {
        throw new ApiError(
          409,
          "DRY_RUN_STATE_INVALID",
          "Only a validated dry-run batch can be completed.",
        );
      }
      assertImportBatchTransition(batch.status, "DRY_RUN_COMPLETE");
      const state = await deriveValidationState(transaction, actor, batchId);
      if (!persistedSummaryMatches(batch, state)) {
        throw new ApiError(
          409,
          "DRY_RUN_SUMMARY_CONFLICT",
          "The persisted validation summary no longer matches its import rows.",
        );
      }
      if (
        state.stagedRows > 0 ||
        state.hiddenRows > 0 ||
        state.quarantinedRows > 0 ||
        state.openQuarantineRows > 0 ||
        state.importedRows > 0 ||
        state.noOpRows > 0
      ) {
        throw new ApiError(
          409,
          "DRY_RUN_NOT_REVIEWED",
          "A dry run requires every hidden and quarantined row to be explicitly reviewed.",
        );
      }
      if (
        batch.approvedRowCount !== 0 ||
        batch.approvalMode !== null ||
        batch.approvedByMembershipId !== null
      ) {
        throw new ApiError(
          409,
          "DRY_RUN_APPROVAL_STATE_INVALID",
          "Dry runs cannot carry approval state.",
        );
      }
      const [updated] = await transaction
        .update(importBatches)
        .set({ status: "DRY_RUN_COMPLETE" })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.version, expectedVersion),
            eq(importBatches.status, "VALIDATED"),
            eq(importBatches.dryRun, true),
          ),
        )
        .returning({ version: importBatches.version });
      if (!updated) {
        throw new ApiError(409, "IMPORT_BATCH_VERSION_CONFLICT", "The dry run changed.");
      }
      const summary = summaryFromState(state);
      const effect = { schemaVersion: 1, batchId, ...summary };
      const eventActorType = actorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: actor.organizationId,
        businessUnitId: actor.businessUnitId,
        actorType: eventActorType,
        actorUserId: actor.userId,
        action: "MIGRATION_DRY_RUN_COMPLETED",
        targetType: "IMPORT_BATCH",
        targetId: batchId,
        outcome: "SUCCESS",
        reason: "VALIDATION_SUMMARY_RECHECKED",
        correlationId: batchId,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: actor.organizationId,
        businessUnitId: actor.businessUnitId,
        eventType: "crm.migration.dry_run_completed",
        eventVersion: 1,
        aggregateType: "IMPORT_BATCH",
        aggregateId: batchId,
        aggregateVersion: updated.version,
        actorType: eventActorType,
        actorUserId: actor.userId,
        correlationId: batchId,
        payload: effect,
      });
      actorEvidence = await requireMigrationActorCapability(
        transaction,
        actor,
        VALIDATE_CAPABILITY,
      );
      void actorEvidence;
      return summary;
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "DRY_RUN_COMPLETION_FAILED",
      "The validated dry run could not be completed.",
    );
  }
}
