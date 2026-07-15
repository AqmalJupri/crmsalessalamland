import "server-only";

import { timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { hashSensitiveLookup } from "@/server/auth/crypto";
import { hasLeadRecordAccess } from "@/server/auth/capability-policy";
import type { Viewer } from "@/server/auth/viewer";
import { getDatabase } from "@/server/db/client";
import {
  auditEvents,
  idempotencyKeys,
  leadStageHistory,
  leads,
  memberships,
  opportunities,
  outboxEvents,
  pipelineStageTransitions,
  pipelines,
  pipelineStages,
  users,
  type LeadTransitionReplaySnapshot,
} from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import { assertOwnerAssignmentAllowed } from "./assignment-policy";
import {
  transitionReason,
  type TransitionLeadInput,
} from "./schemas";
import { assertStageTransitionAllowed } from "./stage-policy";

const IDEMPOTENCY_COMMAND = "lead.transition";
const IDEMPOTENCY_RESPONSE_MAC_DOMAIN = "idempotency-response:v1";

const transitionReplaySnapshotSchema = z
  .object({
    id: z.uuid(),
    stage: z.string().min(1).max(63),
    stageId: z.uuid(),
    ownerMembershipId: z.uuid().nullable(),
    version: z.number().int().positive(),
    updatedAt: z.iso.datetime({ offset: true }),
    changed: z.boolean(),
  })
  .strict();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function transitionRequestHash(
  viewer: Viewer,
  leadId: string,
  input: TransitionLeadInput,
): Uint8Array {
  const canonicalRequest = canonicalize({
    businessUnitId: viewer.businessUnitId,
    convertedOpportunityId: input.convertedOpportunityId,
    leadId,
    organizationId: viewer.organizationId,
    ownerMembershipId: input.ownerMembershipId,
    reason: transitionReason(input),
    stage: input.stage,
    version: input.version,
  });
  return hashSensitiveLookup(
    `idempotency:${IDEMPOTENCY_COMMAND}:${JSON.stringify(canonicalRequest)}`,
  );
}

function transitionResponseMac(input: {
  actorScope: string;
  actorUserId: string | null;
  businessUnitId: string | null;
  commandName: string;
  idempotencyKey: string;
  organizationId: string;
  requestHash: Uint8Array;
  responseCode: number | null;
  responseSnapshot: unknown;
  resultEntityId: string | null;
  resultEntityType: string | null;
  status: string;
}): Uint8Array {
  const envelope = canonicalize({
    actorScope: input.actorScope,
    actorUserId: input.actorUserId,
    businessUnitId: input.businessUnitId,
    commandName: input.commandName,
    idempotencyKey: input.idempotencyKey,
    organizationId: input.organizationId,
    requestHash: Buffer.from(input.requestHash).toString("base64url"),
    responseCode: input.responseCode,
    responseSnapshot: input.responseSnapshot,
    resultEntityId: input.resultEntityId,
    resultEntityType: input.resultEntityType,
    status: input.status,
  });
  return hashSensitiveLookup(
    `${IDEMPOTENCY_RESPONSE_MAC_DOMAIN}:${JSON.stringify(envelope)}`,
  );
}

function parseTransitionReplaySnapshot(
  snapshot: unknown,
  expectedLeadId: string,
): LeadTransitionReplaySnapshot {
  const result = transitionReplaySnapshotSchema.safeParse(snapshot);
  if (!result.success || result.data.id !== expectedLeadId) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_RESPONSE_INVALID",
      "Respons permintaan terdahulu tidak lengkap atau rosak.",
    );
  }
  return result.data;
}

export interface TransitionedLead extends Record<string, unknown> {
  id: string;
  stage: string;
  stageId: string;
  ownerMembershipId: string | null;
  version: number;
  updatedAt: string;
}

export async function transitionLeadRecord(
  viewer: Viewer,
  leadId: string,
  input: TransitionLeadInput,
  requestId: string,
  idempotencyKey: string,
): Promise<{ lead: TransitionedLead; changed: boolean; replayed: boolean }> {
  assertOwnerAssignmentAllowed(viewer, input.ownerMembershipId);
  const now = new Date();

  if (viewer.demo) {
    const changed = input.stage !== "new" || input.ownerMembershipId !== undefined;
    return {
      changed,
      replayed: false,
      lead: {
        id: leadId,
        stage: input.stage,
        stageId: crypto.randomUUID(),
        ownerMembershipId: input.ownerMembershipId ?? null,
        version: input.version + (changed ? 1 : 0),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const requestHash = transitionRequestHash(viewer, leadId, input);
  const actorScope = `USER:${viewer.userId}`;
  return getDatabase().transaction(async (transaction) => {
    const [acquired] = await transaction
      .insert(idempotencyKeys)
      .values({
        organizationId: viewer.organizationId,
        businessUnitId: viewer.businessUnitId,
        actorScope,
        actorUserId: viewer.userId,
        commandName: IDEMPOTENCY_COMMAND,
        idempotencyKey,
        requestHash,
        status: "IN_PROGRESS",
        lockedAt: now,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });

    if (!acquired) {
      const [existing] = await transaction
        .select({
          organizationId: idempotencyKeys.organizationId,
          businessUnitId: idempotencyKeys.businessUnitId,
          actorScope: idempotencyKeys.actorScope,
          actorUserId: idempotencyKeys.actorUserId,
          commandName: idempotencyKeys.commandName,
          idempotencyKey: idempotencyKeys.idempotencyKey,
          requestHash: idempotencyKeys.requestHash,
          status: idempotencyKeys.status,
          resultEntityType: idempotencyKeys.resultEntityType,
          resultEntityId: idempotencyKeys.resultEntityId,
          responseCode: idempotencyKeys.responseCode,
          responseSnapshot: idempotencyKeys.responseSnapshot,
          responseMac: idempotencyKeys.responseMac,
          errorCode: idempotencyKeys.errorCode,
        })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.organizationId, viewer.organizationId),
            eq(idempotencyKeys.actorScope, actorScope),
            eq(idempotencyKeys.commandName, IDEMPOTENCY_COMMAND),
            eq(idempotencyKeys.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);

      if (!existing || !hashesEqual(existing.requestHash, requestHash)) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_MISMATCH",
          "Kunci permintaan telah digunakan untuk data lain.",
        );
      }
      if (existing.status === "COMPLETED") {
        const expectedResponseMac = transitionResponseMac({
          organizationId: existing.organizationId,
          businessUnitId: existing.businessUnitId,
          actorScope: existing.actorScope,
          actorUserId: existing.actorUserId,
          commandName: existing.commandName,
          idempotencyKey: existing.idempotencyKey,
          requestHash: existing.requestHash,
          status: existing.status,
          resultEntityType: existing.resultEntityType,
          resultEntityId: existing.resultEntityId,
          responseCode: existing.responseCode,
          responseSnapshot: existing.responseSnapshot,
        });
        if (
          !existing.responseMac ||
          !hashesEqual(existing.responseMac, expectedResponseMac) ||
          existing.resultEntityType !== "LEAD" ||
          existing.resultEntityId !== leadId ||
          existing.responseCode !== 200
        ) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_RESPONSE_INVALID",
            "Respons permintaan terdahulu tidak lengkap atau rosak.",
          );
        }
        const snapshot = parseTransitionReplaySnapshot(
          existing.responseSnapshot,
          existing.resultEntityId,
        );
        return {
          changed: snapshot.changed,
          replayed: true,
          lead: {
            id: snapshot.id,
            stage: snapshot.stage,
            stageId: snapshot.stageId,
            ownerMembershipId: snapshot.ownerMembershipId,
            version: snapshot.version,
            updatedAt: snapshot.updatedAt,
          },
        };
      }
      if (existing.status === "FAILED") {
        throw new ApiError(
          409,
          "IDEMPOTENT_REQUEST_FAILED",
          "Permintaan terdahulu gagal dan tidak akan dijalankan semula dengan kunci ini.",
          { errorCode: existing.errorCode },
        );
      }
      throw new ApiError(409, "REQUEST_IN_PROGRESS", "Permintaan sedang diproses. Cuba semula.");
    }

    const completeIdempotency = async (
      changed: boolean,
      lead: TransitionedLead,
    ): Promise<{ lead: TransitionedLead; changed: boolean; replayed: false }> => {
      const responseSnapshot: LeadTransitionReplaySnapshot = {
        id: lead.id,
        stage: lead.stage,
        stageId: lead.stageId,
        ownerMembershipId: lead.ownerMembershipId,
        version: lead.version,
        updatedAt: lead.updatedAt,
        changed,
      };
      const responseMac = transitionResponseMac({
        organizationId: viewer.organizationId,
        businessUnitId: viewer.businessUnitId,
        actorScope,
        actorUserId: viewer.userId,
        commandName: IDEMPOTENCY_COMMAND,
        idempotencyKey,
        requestHash,
        status: "COMPLETED",
        resultEntityType: "LEAD",
        resultEntityId: lead.id,
        responseCode: 200,
        responseSnapshot,
      });
      const [completed] = await transaction
        .update(idempotencyKeys)
        .set({
          status: "COMPLETED",
          resultEntityType: "LEAD",
          resultEntityId: lead.id,
          responseCode: 200,
          responseSnapshot,
          responseMac,
          errorCode: null,
          completedAt: new Date(),
        })
        .where(
          and(eq(idempotencyKeys.id, acquired.id), eq(idempotencyKeys.status, "IN_PROGRESS")),
        )
        .returning({ id: idempotencyKeys.id });
      if (!completed) {
        throw new ApiError(409, "IDEMPOTENCY_STATE_CONFLICT", "Status permintaan telah berubah.");
      }
      return { lead, changed, replayed: false };
    };

    const [current] = await transaction
      .select({
        id: leads.id,
        businessUnitId: leads.businessUnitId,
        pipelineId: leads.pipelineId,
        stageId: leads.stageId,
        stageCode: pipelineStages.code,
        stageCategory: pipelineStages.category,
        stageIsTerminal: pipelineStages.isTerminal,
        ownerMembershipId: leads.ownerMembershipId,
        version: leads.version,
        updatedAt: leads.updatedAt,
        pipelineStatus: pipelines.status,
        pipelineEntityType: pipelines.entityType,
      })
      .from(leads)
      .innerJoin(
        pipelineStages,
        and(
          eq(pipelineStages.organizationId, leads.organizationId),
          eq(pipelineStages.businessUnitId, leads.businessUnitId),
          eq(pipelineStages.pipelineId, leads.pipelineId),
          eq(pipelineStages.id, leads.stageId),
        ),
      )
      .innerJoin(
        pipelines,
        and(
          eq(pipelines.organizationId, leads.organizationId),
          eq(pipelines.businessUnitId, leads.businessUnitId),
          eq(pipelines.id, leads.pipelineId),
        ),
      )
      .where(
        and(
          eq(leads.id, leadId),
          eq(leads.organizationId, viewer.organizationId),
          eq(leads.businessUnitId, viewer.businessUnitId),
        ),
      )
      .limit(1)
      .for("update", { of: leads });

    if (!current) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead tidak ditemui.");
    if (
      !hasLeadRecordAccess(
        viewer.capabilityRecordScopes,
        "lead.update",
        viewer.membershipIds,
        current.ownerMembershipId,
      )
    ) {
      throw new ApiError(
        403,
        "LEAD_RECORD_SCOPE_FORBIDDEN",
        "Anda tiada akses untuk mengubah lead ini.",
      );
    }
    if (current.version !== input.version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Lead telah dikemas kini oleh pengguna lain.", {
        currentVersion: current.version,
        currentStage: current.stageCode,
      });
    }
    if (current.pipelineStatus !== "ACTIVE" || current.pipelineEntityType !== "LEAD") {
      throw new ApiError(409, "LEAD_PIPELINE_INACTIVE", "Pipeline lead tidak aktif.");
    }

    const [target] = await transaction
      .select({
        id: pipelineStages.id,
        code: pipelineStages.code,
        category: pipelineStages.category,
        isTerminal: pipelineStages.isTerminal,
      })
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.organizationId, viewer.organizationId),
          eq(pipelineStages.businessUnitId, current.businessUnitId),
          eq(pipelineStages.pipelineId, current.pipelineId),
          eq(pipelineStages.code, input.stage),
          eq(pipelineStages.status, "ACTIVE"),
        ),
      )
      .limit(1);

    if (!target) {
      throw new ApiError(422, "LEAD_STAGE_NOT_FOUND", "Peringkat lead tidak sah atau tidak aktif.");
    }

    const reason = transitionReason(input);
    const stageChanged = current.stageId !== target.id;
    const [configuredTransition] = stageChanged
      ? await transaction
          .select({
            requiresReason: pipelineStageTransitions.requiresReason,
            requiredCapability: pipelineStageTransitions.requiredCapability,
          })
          .from(pipelineStageTransitions)
          .where(
            and(
              eq(pipelineStageTransitions.organizationId, viewer.organizationId),
              eq(pipelineStageTransitions.businessUnitId, current.businessUnitId),
              eq(pipelineStageTransitions.pipelineId, current.pipelineId),
              eq(pipelineStageTransitions.fromStageId, current.stageId),
              eq(pipelineStageTransitions.toStageId, target.id),
              eq(pipelineStageTransitions.status, "ACTIVE"),
            ),
          )
          .limit(1)
      : [undefined];
    if (stageChanged && !configuredTransition) {
      throw new ApiError(
        422,
        "LEAD_TRANSITION_NOT_CONFIGURED",
        "Peralihan peringkat ini tidak dikonfigurasi.",
      );
    }
    assertStageTransitionAllowed({
      current: {
        code: current.stageCode,
        category: current.stageCategory,
        isTerminal: current.stageIsTerminal,
      },
      target,
      reason,
      requiresReason: configuredTransition?.requiresReason ?? false,
      requiredCapability: configuredTransition?.requiredCapability ?? null,
      capabilities: viewer.capabilities,
      canReopen: viewer.capabilities.includes("lead.reopen"),
    });

    if (stageChanged && target.category === "CONVERTED") {
      if (!input.convertedOpportunityId) {
        throw new ApiError(
          422,
          "CONVERTED_OPPORTUNITY_REQUIRED",
          "Opportunity diperlukan untuk peringkat converted.",
        );
      }
      const [opportunity] = await transaction
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.id, input.convertedOpportunityId),
            eq(opportunities.organizationId, viewer.organizationId),
            eq(opportunities.businessUnitId, current.businessUnitId),
            eq(opportunities.leadId, current.id),
          ),
        )
        .limit(1);
      if (!opportunity) {
        throw new ApiError(
          422,
          "CONVERTED_OPPORTUNITY_INVALID",
          "Opportunity tidak dipautkan kepada lead ini.",
        );
      }
    }

    if (input.ownerMembershipId) {
      const [owner] = await transaction
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.id, input.ownerMembershipId),
            eq(memberships.organizationId, viewer.organizationId),
            eq(memberships.businessUnitId, current.businessUnitId),
            eq(memberships.status, "ACTIVE"),
            lte(memberships.validFrom, now),
            or(isNull(memberships.validUntil), gt(memberships.validUntil, now)),
            eq(users.status, "ACTIVE"),
            eq(users.userType, "HUMAN"),
          ),
        )
        .limit(1);
      if (!owner) {
        throw new ApiError(
          422,
          "OWNER_MEMBERSHIP_INVALID",
          "Pemilik lead bukan ahli aktif business unit ini.",
        );
      }
    }

    const nextOwner =
      input.ownerMembershipId === undefined
        ? current.ownerMembershipId
        : input.ownerMembershipId;
    const ownerChanged = nextOwner !== current.ownerMembershipId;

    if (
      ownerChanged &&
      current.ownerMembershipId !== null &&
      (reason?.trim().length ?? 0) === 0
    ) {
      throw new ApiError(
        422,
        "ASSIGNMENT_REASON_REQUIRED",
        "Sebab diperlukan untuk penugasan semula atau membuang pemilik lead.",
      );
    }

    if (!stageChanged && !ownerChanged) {
      return completeIdempotency(false, {
        id: current.id,
        stage: current.stageCode,
        stageId: current.stageId,
        ownerMembershipId: current.ownerMembershipId,
        version: current.version,
        updatedAt: current.updatedAt.toISOString(),
      });
    }

    const changes: {
      stageId?: string;
      ownerMembershipId?: string | null;
      assignedByMembershipId?: string | null;
      assignedAt?: Date | null;
    } = {};
    if (stageChanged) changes.stageId = target.id;
    if (ownerChanged) {
      changes.ownerMembershipId = nextOwner;
      changes.assignedByMembershipId = nextOwner ? viewer.activeMembershipId : null;
      changes.assignedAt = nextOwner ? now : null;
    }

    const [updated] = await transaction
      .update(leads)
      .set(changes)
      .where(
        and(
          eq(leads.id, current.id),
          eq(leads.organizationId, viewer.organizationId),
          eq(leads.businessUnitId, current.businessUnitId),
          eq(leads.version, input.version),
        ),
      )
      .returning({
        id: leads.id,
        stageId: leads.stageId,
        ownerMembershipId: leads.ownerMembershipId,
        version: leads.version,
        updatedAt: leads.updatedAt,
      });

    if (!updated) {
      throw new ApiError(409, "VERSION_CONFLICT", "Lead telah dikemas kini oleh pengguna lain.");
    }

    if (stageChanged) {
      await transaction.insert(leadStageHistory).values({
        organizationId: viewer.organizationId,
        businessUnitId: current.businessUnitId,
        leadId: current.id,
        fromStageId: current.stageId,
        toStageId: target.id,
        actorUserId: viewer.userId,
        transitionSource: "API_USER",
        reason,
        occurredAt: updated.updatedAt,
        correlationId: requestId,
      });
    }

    if (stageChanged) {
      await transaction.insert(auditEvents).values({
        organizationId: viewer.organizationId,
        businessUnitId: current.businessUnitId,
        actorType: "USER",
        actorUserId: viewer.userId,
        action: "LEAD_STAGE_CHANGED",
        targetType: "LEAD",
        targetId: current.id,
        outcome: "SUCCESS",
        requestId,
        correlationId: requestId,
        changeSummary: {
          fromStageId: current.stageId,
          toStageId: target.id,
          fromStageCode: current.stageCode,
          toStageCode: target.code,
          reason,
          version: updated.version,
        },
      });

      await transaction.insert(outboxEvents).values({
        organizationId: viewer.organizationId,
        businessUnitId: current.businessUnitId,
        eventType: "crm.lead.stage_changed",
        eventVersion: 1,
        aggregateType: "LEAD",
        aggregateId: current.id,
        aggregateVersion: updated.version,
        actorType: "USER",
        actorUserId: viewer.userId,
        correlationId: requestId,
        payload: {
          leadId: current.id,
          businessUnitId: current.businessUnitId,
          pipelineId: current.pipelineId,
          fromStageId: current.stageId,
          toStageId: target.id,
          fromStageCode: current.stageCode,
          toStageCode: target.code,
          ownerMembershipId: nextOwner,
          version: updated.version,
        },
      });
    }

    if (ownerChanged) {
      const assignmentAction = nextOwner ? "LEAD_ASSIGNED" : "LEAD_UNASSIGNED";
      const assignmentEventType = nextOwner ? "crm.lead.assigned" : "crm.lead.unassigned";
      await transaction.insert(auditEvents).values({
        organizationId: viewer.organizationId,
        businessUnitId: current.businessUnitId,
        actorType: "USER",
        actorUserId: viewer.userId,
        action: assignmentAction,
        targetType: "LEAD",
        targetId: current.id,
        outcome: "SUCCESS",
        requestId,
        correlationId: requestId,
        changeSummary: {
          fromOwnerMembershipId: current.ownerMembershipId,
          toOwnerMembershipId: nextOwner,
          assignedByMembershipId: viewer.activeMembershipId,
          assignedAt: nextOwner ? now.toISOString() : null,
          reason,
          version: updated.version,
        },
      });

      await transaction.insert(outboxEvents).values({
        organizationId: viewer.organizationId,
        businessUnitId: current.businessUnitId,
        eventType: assignmentEventType,
        eventVersion: 1,
        aggregateType: "LEAD",
        aggregateId: current.id,
        aggregateVersion: updated.version,
        actorType: "USER",
        actorUserId: viewer.userId,
        correlationId: requestId,
        payload: {
          leadId: current.id,
          businessUnitId: current.businessUnitId,
          previousOwnerMembershipId: current.ownerMembershipId,
          ownerMembershipId: nextOwner,
          assignedByMembershipId: viewer.activeMembershipId,
          version: updated.version,
        },
      });
    }

    return completeIdempotency(true, {
      id: updated.id,
      stage: target.code,
      stageId: updated.stageId,
      ownerMembershipId: updated.ownerMembershipId,
      version: updated.version,
      updatedAt: updated.updatedAt.toISOString(),
    });
  });
}
