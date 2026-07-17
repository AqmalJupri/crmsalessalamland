import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  assertImportBatchTransition,
  assertPartialApprovalAllowed,
} from "@/domain/migration/batch-lifecycle";
import { MigrationPolicyError } from "@/domain/migration/types";
import { getDatabase } from "@/server/db/client";
import { importBatches, importRows } from "@/server/db/migration-schema";
import { auditEvents, memberships, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import type { MigrationActor } from "./contracts";
import { migrationTextLooksSensitive } from "./redacted-metadata";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  validateMigrationActor,
} from "./stage-batch";
import { deriveValidationState, persistedSummaryMatches } from "./validate-batch";

const APPROVE_CAPABILITY = "migration.approve";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Database = ReturnType<typeof getDatabase>;

export interface ApproveImportBatchInput {
  batchId: string;
  expectedBatchVersion: number;
  approvalMode: "FULL" | "PARTIAL";
  approvalReason: string | null;
}

interface ApprovalCommand {
  actor: MigrationActor;
  batchId: string;
  expectedBatchVersion: number;
  approvalMode: "FULL" | "PARTIAL";
  approvalReason: string;
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
  input: ApproveImportBatchInput,
): ApprovalCommand {
  const actor = validateMigrationActor(actorInput, APPROVE_CAPABILITY);
  if (!input || typeof input !== "object") {
    throw new ApiError(422, "MIGRATION_INPUT_INVALID", "The batch approval input is invalid.");
  }
  if (input.approvalMode !== "FULL" && input.approvalMode !== "PARTIAL") {
    throw new ApiError(
      422,
      "IMPORT_BATCH_APPROVAL_MODE_INVALID",
      "approvalMode must be FULL or PARTIAL.",
    );
  }
  const approvalReason =
    typeof input.approvalReason === "string" ? input.approvalReason.trim() : "";
  if (
    approvalReason.length < 1 ||
    approvalReason.length > 2_000 ||
    migrationTextLooksSensitive(approvalReason)
  ) {
    throw new ApiError(
      422,
      "IMPORT_BATCH_APPROVAL_REASON_REQUIRED",
      "A bounded non-empty approval reason is required.",
    );
  }
  return {
    actor,
    batchId: canonicalUuid(input.batchId, "batchId"),
    expectedBatchVersion: positiveVersion(input.expectedBatchVersion, "expectedBatchVersion"),
    approvalMode: input.approvalMode,
    approvalReason,
  };
}

function actorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

export async function approveImportBatch(
  actorInput: MigrationActor,
  input: ApproveImportBatchInput,
): Promise<{ approvedRowCount: number; approvalMode: "FULL" | "PARTIAL" }> {
  const command = validateCommand(actorInput, input);
  const database: Database = getDatabase();
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

  try {
    return await database.transaction(async (transaction) => {
      await requireActiveMigrationTenant(transaction, command.actor);
      let actorEvidence = await requireMigrationActorCapability(
        transaction,
        command.actor,
        APPROVE_CAPABILITY,
      );
      await lockAndValidateMigrationSourceAuthority(
        transaction,
        command.actor,
        locator.migrationSourceId,
      );
      const [batch] = await transaction
        .select({
          status: importBatches.status,
          dryRun: importBatches.dryRun,
          version: importBatches.version,
          validatedByMembershipId: importBatches.validatedByMembershipId,
          validatedAt: importBatches.validatedAt,
          totalRowCount: importBatches.totalRowCount,
          stagedRowCount: importBatches.stagedRowCount,
          validRowCount: importBatches.validRowCount,
          rejectedRowCount: importBatches.rejectedRowCount,
          quarantinedRowCount: importBatches.quarantinedRowCount,
          hiddenRowCount: importBatches.hiddenRowCount,
          importedRowCount: importBatches.importedRowCount,
          noOpRowCount: importBatches.noOpRowCount,
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
          "The validated import batch changed before approval.",
        );
      }
      if (
        batch.status !== "VALIDATED" ||
        batch.validatedByMembershipId === null ||
        batch.validatedAt === null
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_STATE_INVALID",
          "Only a validated import batch can be approved.",
        );
      }
      assertImportBatchTransition(batch.status, "APPROVED");
      if (batch.dryRun) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_DRY_RUN_APPROVAL_FORBIDDEN",
          "Dry-run batches cannot be approved for canonical apply.",
        );
      }
      const state = await deriveValidationState(transaction, command.actor, command.batchId);
      if (!persistedSummaryMatches(batch, state)) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VALIDATION_SUMMARY_CONFLICT",
          "The persisted validation summary no longer matches its import rows.",
        );
      }
      if (state.stagedRows > 0 || state.importedRows > 0 || state.noOpRows > 0) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_APPROVAL_POLICY_FAILED",
          "The validated batch contains an ineligible row state.",
        );
      }
      if (state.validRows === 0) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_ZERO_ROW_APPROVAL",
          "Approval requires at least one valid row.",
        );
      }
      if (command.approvalMode === "FULL") {
        if (
          state.totalRows !== state.validRows ||
          state.rejectedRows !== 0 ||
          state.quarantinedRows !== 0 ||
          state.hiddenRows !== 0 ||
          state.openQuarantineRows !== 0
        ) {
          throw new ApiError(
            409,
            "IMPORT_BATCH_FULL_APPROVAL_INVALID",
            "Full approval requires every import row to be valid.",
          );
        }
      } else {
        try {
          assertPartialApprovalAllowed({
            totalRows: state.totalRows,
            validRows: state.validRows,
            rejectedRows: state.rejectedRows,
            quarantinedRows: state.quarantinedRows,
            hiddenRows: state.hiddenRows,
          });
        } catch (error: unknown) {
          if (error instanceof MigrationPolicyError) {
            throw new ApiError(
              409,
              "IMPORT_BATCH_APPROVAL_POLICY_FAILED",
              "Partial approval requires a visible rejected subset and no unresolved rows.",
            );
          }
          throw error;
        }
        if (state.openQuarantineRows !== 0) {
          throw new ApiError(
            409,
            "IMPORT_BATCH_APPROVAL_POLICY_FAILED",
            "Partial approval requires a visible rejected subset and no unresolved rows.",
          );
        }
      }

      const [rejectedVisibility] = await transaction
        .select({
          invalidCount: sql<string>`(count(*) filter (
            where ${importRows.outcome} = 'REJECTED'
              and (${importRows.errorCode} is null or btrim(${importRows.errorCode}) = '')
          ))::text`,
        })
        .from(importRows)
        .where(
          and(
            eq(importRows.organizationId, command.actor.organizationId),
            eq(importRows.businessUnitId, command.actor.businessUnitId),
            eq(importRows.batchId, command.batchId),
          ),
        );
      if ((rejectedVisibility?.invalidCount ?? "0") !== "0") {
        throw new ApiError(
          409,
          "IMPORT_BATCH_REJECTED_ROWS_NOT_VISIBLE",
          "Every rejected row requires a stable visible reason code.",
        );
      }

      const membershipEvidence = await transaction
        .select({ id: memberships.id, userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, command.actor.organizationId),
            inArray(memberships.id, [
              batch.validatedByMembershipId,
              command.actor.activeMembershipId,
            ]),
          ),
        )
        .orderBy(asc(memberships.id))
        .for("share");
      const userByMembership = new Map(
        membershipEvidence.map((membership) => [membership.id, membership.userId] as const),
      );
      const validatorUserId = userByMembership.get(batch.validatedByMembershipId);
      const approverUserId = userByMembership.get(command.actor.activeMembershipId);
      if (!validatorUserId || !approverUserId) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_PROVENANCE_INVALID",
          "Validator and approver provenance must remain available.",
        );
      }
      if (validatorUserId === approverUserId) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_MAKER_CHECKER_REQUIRED",
          "The validating and approving people must be different.",
        );
      }

      const approvedRowCount = state.validRows;
      const [updated] = await transaction
        .update(importBatches)
        .set({
          status: "APPROVED",
          approvedRowCount,
          approvedByMembershipId: command.actor.activeMembershipId,
          approvedAt: sql`transaction_timestamp()`,
          approvalMode: command.approvalMode,
          approvalReason: command.approvalReason,
        })
        .where(
          and(
            eq(importBatches.id, command.batchId),
            eq(importBatches.version, command.expectedBatchVersion),
            eq(importBatches.status, "VALIDATED"),
          ),
        )
        .returning({ version: importBatches.version });
      if (!updated) {
        throw new ApiError(409, "IMPORT_BATCH_VERSION_CONFLICT", "The import batch changed.");
      }
      const effect = {
        schemaVersion: 1,
        batchId: command.batchId,
        approvalMode: command.approvalMode,
        approvedRowCount,
        rejectedRowCount: state.rejectedRows,
      };
      const eventActorType = actorType(actorEvidence.userType);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_IMPORT_BATCH_APPROVED",
        targetType: "IMPORT_BATCH",
        targetId: command.batchId,
        outcome: "SUCCESS",
        reason: command.approvalReason,
        correlationId: command.batchId,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.import_batch_approved",
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
        APPROVE_CAPABILITY,
      );
      void actorEvidence;
      return { approvedRowCount, approvalMode: command.approvalMode };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "IMPORT_BATCH_APPROVAL_FAILED",
      "The import batch approval could not be recorded.",
    );
  }
}
