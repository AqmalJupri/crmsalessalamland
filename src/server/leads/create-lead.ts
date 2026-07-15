import "server-only";

import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeMalaysianPhone } from "@/domain/contacts/identity";
import { hashSensitiveLookup } from "@/server/auth/crypto";
import type { Viewer } from "@/server/auth/viewer";
import { getDatabase } from "@/server/db/client";
import {
  auditEvents,
  contactBusinessUnits,
  contactIdentifiers,
  contacts,
  idempotencyKeys,
  leadStageHistory,
  leads,
  memberships,
  outboxEvents,
  pipelineStages,
  pipelines,
  users,
  type LeadCreateReplaySnapshot,
} from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import { assertOwnerAssignmentAllowed } from "./assignment-policy";
import { decideContactIdentity } from "./identity-resolution";
import {
  sourceProviderKeySchema,
  type CreateLeadInput,
} from "./schemas";

const IDEMPOTENCY_COMMAND = "lead.create";
const IDEMPOTENCY_RESPONSE_MAC_DOMAIN = "idempotency-response:v1";
const DEFAULT_LEAD_TITLE = "Permintaan baharu";

export interface CreatedLead extends Record<string, unknown> {
  id: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  name: string;
  phone: string;
  stage: string;
  source: string;
  productInterest: string | null;
  ownerMembershipId: string | null;
  version: number;
  receivedAt: string;
  createdAt: string;
}

const leadCreateReplaySnapshotSchema = z
  .object({
    id: z.uuid(),
    contactId: z.uuid(),
    pipelineId: z.uuid(),
    stageId: z.uuid(),
    stage: z.string().min(1).max(63),
    version: z.number().int().positive(),
    receivedAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

function parseLeadCreateReplaySnapshot(
  snapshot: unknown,
  expectedLeadId: string,
): LeadCreateReplaySnapshot {
  const result = leadCreateReplaySnapshotSchema.safeParse(snapshot);
  if (!result.success || result.data.id !== expectedLeadId) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_RESPONSE_INVALID",
      "Respons permintaan terdahulu tidak lengkap atau rosak.",
    );
  }
  return result.data;
}

function hydrateCreatedLead(
  snapshot: LeadCreateReplaySnapshot,
  input: CreateLeadInput,
  normalizedPhone: string,
  sourceProvider: string,
): CreatedLead {
  return {
    ...snapshot,
    name: input.name,
    phone: normalizedPhone,
    source: sourceProvider,
    productInterest: input.productInterest ?? null,
    ownerMembershipId: input.ownerMembershipId ?? null,
  };
}

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

function requestHashFor(
  input: CreateLeadInput,
  normalizedPhone: string,
  sourceProvider: string,
): Uint8Array {
  const externalLeadId = input.externalLeadId ?? input.sourceExternalId;
  const canonicalRequest = canonicalize({
    attribution: input.attribution ?? {},
    businessUnitId: input.businessUnitId,
    externalLeadId,
    name: input.name,
    normalizedPhone,
    ownerMembershipId: input.ownerMembershipId,
    productInterest: input.productInterest,
    providerOccurredAt: input.providerOccurredAt
      ? new Date(input.providerOccurredAt).toISOString()
      : undefined,
    sourceChannel: input.sourceChannel,
    sourceProvider,
  });

  return hashSensitiveLookup(
    `idempotency:${IDEMPOTENCY_COMMAND}:${JSON.stringify(canonicalRequest)}`,
  );
}

function canonicalSourceProvider(input: CreateLeadInput): string {
  const values = [input.source, input.sourceProvider].filter(
    (value): value is string => value !== undefined,
  );
  if (values.length === 0) {
    throw new ApiError(422, "LEAD_SOURCE_REQUIRED", "Sumber lead diperlukan.");
  }

  const canonicalValues = values.map((value) => sourceProviderKeySchema.safeParse(value));
  if (canonicalValues.some((result) => !result.success)) {
    throw new ApiError(422, "LEAD_SOURCE_INVALID", "Kunci provider lead tidak sah.");
  }
  const [sourceProvider, alias] = canonicalValues.map((result) => result.data!);
  if (alias !== undefined && alias !== sourceProvider) {
    throw new ApiError(422, "LEAD_SOURCE_MISMATCH", "Sumber lead tidak sepadan.");
  }
  return sourceProvider!;
}

function duplicateFingerprint(businessUnitId: string, normalizedPhone: string): Uint8Array {
  return hashSensitiveLookup(`duplicate:lead:${businessUnitId}:PHONE:${normalizedPhone}`);
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function leadCreateResponseMac(input: {
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

export async function createLead(
  viewer: Viewer,
  input: CreateLeadInput,
  idempotencyKey: string,
  requestId: string,
): Promise<{ lead: CreatedLead; replayed: boolean; responseCode: 201 }> {
  if (input.businessUnitId !== viewer.businessUnitId) {
    throw new ApiError(
      403,
      "BUSINESS_UNIT_CONTEXT_REQUIRED",
      "Tukar unit perniagaan aktif sebelum menyimpan lead.",
    );
  }
  assertOwnerAssignmentAllowed(viewer, input.ownerMembershipId);

  const normalizedPhone = normalizeMalaysianPhone(input.phone);
  const sourceProvider = canonicalSourceProvider(input);

  const now = new Date();
  const receivedAt = now;
  const providerOccurredAt = input.providerOccurredAt
    ? new Date(input.providerOccurredAt)
    : null;
  if (providerOccurredAt && providerOccurredAt.getTime() > receivedAt.getTime()) {
    throw new ApiError(
      422,
      "INVALID_PROVIDER_TIME",
      "Masa provider tidak boleh selepas masa penerimaan.",
    );
  }

  if (viewer.demo) {
    return {
      replayed: false,
      responseCode: 201,
      lead: {
        id: crypto.randomUUID(),
        contactId: crypto.randomUUID(),
        pipelineId: crypto.randomUUID(),
        stageId: crypto.randomUUID(),
        name: input.name,
        phone: normalizedPhone,
        stage: "new",
        source: sourceProvider,
        productInterest: input.productInterest ?? null,
        ownerMembershipId: input.ownerMembershipId ?? null,
        version: 1,
        receivedAt: receivedAt.toISOString(),
        createdAt: now.toISOString(),
      },
    };
  }

  const requestHash = requestHashFor(input, normalizedPhone, sourceProvider);
  const actorScope = `USER:${viewer.userId}`;
  const externalLeadId = input.externalLeadId ?? input.sourceExternalId ?? null;
  const database = getDatabase();

  return database.transaction(async (transaction) => {
    const [acquired] = await transaction
      .insert(idempotencyKeys)
      .values({
        organizationId: viewer.organizationId,
        businessUnitId: input.businessUnitId,
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

    const loadLeadCreateReplaySnapshot = async (
      leadId: string,
    ): Promise<LeadCreateReplaySnapshot> => {
      const [row] = await transaction
        .select({
          id: leads.id,
          contactId: leads.contactId,
          pipelineId: leads.pipelineId,
          stageId: leads.stageId,
          stage: pipelineStages.code,
          version: leads.version,
          receivedAt: leads.receivedAt,
          createdAt: leads.createdAt,
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
        .where(
          and(
            eq(leads.id, leadId),
            eq(leads.organizationId, viewer.organizationId),
            eq(leads.businessUnitId, input.businessUnitId),
          ),
        )
        .limit(1);

      if (!row) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_RESULT_MISSING",
          "Hasil permintaan terdahulu tidak dapat dibaca.",
        );
      }

      return {
        id: row.id,
        contactId: row.contactId,
        pipelineId: row.pipelineId,
        stageId: row.stageId,
        stage: row.stage,
        version: row.version,
        receivedAt: row.receivedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      };
    };

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
        const expectedResponseMac = leadCreateResponseMac({
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
          !existing.resultEntityId ||
          existing.responseCode !== 201
        ) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_RESPONSE_INVALID",
            "Respons permintaan terdahulu tidak lengkap atau rosak.",
          );
        }
        return {
          lead: hydrateCreatedLead(
            parseLeadCreateReplaySnapshot(existing.responseSnapshot, existing.resultEntityId),
            input,
            normalizedPhone,
            sourceProvider,
          ),
          replayed: true,
          responseCode: 201,
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

    const activePipelines = await transaction
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(
        and(
          eq(pipelines.organizationId, viewer.organizationId),
          eq(pipelines.businessUnitId, input.businessUnitId),
          eq(pipelines.entityType, "LEAD"),
          eq(pipelines.status, "ACTIVE"),
        ),
      )
      .limit(2);

    if (activePipelines.length === 0) {
      throw new ApiError(
        409,
        "LEAD_PIPELINE_NOT_CONFIGURED",
        "Pipeline lead aktif belum dikonfigurasi.",
      );
    }
    if (activePipelines.length > 1) {
      throw new ApiError(
        409,
        "LEAD_PIPELINE_AMBIGUOUS",
        "Lebih daripada satu pipeline lead aktif dikonfigurasi.",
      );
    }
    const pipelineId = activePipelines[0]!.id;
    const [initialStage] = await transaction
      .select({ id: pipelineStages.id, code: pipelineStages.code })
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.organizationId, viewer.organizationId),
          eq(pipelineStages.businessUnitId, input.businessUnitId),
          eq(pipelineStages.pipelineId, pipelineId),
          eq(pipelineStages.category, "OPEN"),
          eq(pipelineStages.status, "ACTIVE"),
        ),
      )
      .orderBy(asc(pipelineStages.position))
      .limit(1);

    if (!initialStage) {
      throw new ApiError(
        409,
        "LEAD_INITIAL_STAGE_NOT_CONFIGURED",
        "Peringkat awal OPEN belum dikonfigurasi.",
      );
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
            eq(memberships.businessUnitId, input.businessUnitId),
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

    const phoneHash = requestHashForPhone(normalizedPhone);
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${viewer.organizationId}:${Buffer.from(phoneHash).toString("hex")}`}, 0))`,
    );

    const identityCandidates = await transaction
      .select({
        contactId: contactIdentifiers.contactId,
        displayName: contacts.displayName,
        contactStatus: contacts.status,
        verificationStatus: contactIdentifiers.verificationStatus,
      })
      .from(contactIdentifiers)
      .innerJoin(
        contacts,
        and(
          eq(contacts.organizationId, contactIdentifiers.organizationId),
          eq(contacts.id, contactIdentifiers.contactId),
        ),
      )
      .innerJoin(
        contactBusinessUnits,
        and(
          eq(contactBusinessUnits.organizationId, contactIdentifiers.organizationId),
          eq(contactBusinessUnits.contactId, contactIdentifiers.contactId),
          eq(contactBusinessUnits.businessUnitId, input.businessUnitId),
          eq(contactBusinessUnits.relationshipType, "CUSTOMER"),
          eq(contactBusinessUnits.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(contactIdentifiers.organizationId, viewer.organizationId),
          eq(contactIdentifiers.identifierType, "PHONE"),
          eq(contactIdentifiers.valueHash, phoneHash),
          ne(contactIdentifiers.verificationStatus, "REVOKED"),
        ),
      )
      .limit(2)
      .for("update", { of: contactBusinessUnits });

    const identityDecision = decideContactIdentity(identityCandidates, input.name);
    const [organizationIdentityMatch] =
      identityCandidates.length === 0
        ? await transaction
            .select({ id: contactIdentifiers.id })
            .from(contactIdentifiers)
            .where(
              and(
                eq(contactIdentifiers.organizationId, viewer.organizationId),
                eq(contactIdentifiers.identifierType, "PHONE"),
                eq(contactIdentifiers.valueHash, phoneHash),
                ne(contactIdentifiers.verificationStatus, "REVOKED"),
              ),
            )
            .limit(1)
        : [undefined];
    const reviewRequired = identityDecision.reviewRequired || Boolean(organizationIdentityMatch);
    let contactId = identityDecision.contactId;
    if (!contactId) {
      const [contact] = await transaction
        .insert(contacts)
        .values({
          organizationId: viewer.organizationId,
          displayName: input.name,
          status: reviewRequired ? "POSSIBLE_DUPLICATE" : "ACTIVE",
          metadata: reviewRequired
            ? {
                identityReviewRequired: true,
                authorizedIdentityCandidateCount: identityCandidates.length,
                restrictedIdentityMatch: Boolean(organizationIdentityMatch),
              }
            : {},
        })
        .returning({ id: contacts.id });
      if (!contact) {
        throw new ApiError(500, "CONTACT_CREATE_FAILED", "Contact tidak dapat disimpan.");
      }
      contactId = contact.id;

      await transaction.insert(contactIdentifiers).values({
        organizationId: viewer.organizationId,
        contactId,
        identifierType: "PHONE",
        normalizedValue: normalizedPhone,
        valueHash: phoneHash,
        verificationStatus: "UNVERIFIED",
        isPrimary: true,
        source: sourceProvider,
      });
    }

    const [relationship] = await transaction
      .insert(contactBusinessUnits)
      .values({
        organizationId: viewer.organizationId,
        businessUnitId: input.businessUnitId,
        contactId,
        relationshipType: "CUSTOMER",
        purpose: "LEAD_MANAGEMENT",
        status: "ACTIVE",
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [
          contactBusinessUnits.organizationId,
          contactBusinessUnits.businessUnitId,
          contactBusinessUnits.contactId,
          contactBusinessUnits.relationshipType,
        ],
        set: {
          lastSeenAt: now,
        },
        setWhere: eq(contactBusinessUnits.status, "ACTIVE"),
      })
      .returning({
        contactId: contactBusinessUnits.contactId,
        status: contactBusinessUnits.status,
      });

    if (
      !relationship ||
      relationship.contactId !== contactId ||
      relationship.status !== "ACTIVE"
    ) {
      throw new ApiError(
        409,
        "CONTACT_RELATIONSHIP_AUTHORIZATION_CHANGED",
        "Kebenaran hubungan contact telah berubah. Cuba semula.",
      );
    }

    const [lead] = await transaction
      .insert(leads)
      .values({
        organizationId: viewer.organizationId,
        businessUnitId: input.businessUnitId,
        contactId,
        pipelineId,
        stageId: initialStage.id,
        ownerMembershipId: input.ownerMembershipId ?? null,
        assignedByMembershipId: input.ownerMembershipId ? viewer.activeMembershipId : null,
        title: input.productInterest ?? DEFAULT_LEAD_TITLE,
        sourceProvider,
        sourceChannel: input.sourceChannel ?? null,
        externalLeadId,
        duplicateFingerprint: duplicateFingerprint(input.businessUnitId, normalizedPhone),
        providerOccurredAt,
        receivedAt,
        ingestedAt: now,
        assignedAt: input.ownerMembershipId ? now : null,
        attribution: input.attribution ?? {},
      })
      .returning({ id: leads.id, version: leads.version });

    if (!lead) throw new ApiError(500, "LEAD_CREATE_FAILED", "Lead tidak dapat disimpan.");

    await transaction.insert(leadStageHistory).values({
      organizationId: viewer.organizationId,
      businessUnitId: input.businessUnitId,
      leadId: lead.id,
      fromStageId: null,
      toStageId: initialStage.id,
      actorUserId: viewer.userId,
      transitionSource: "API_CREATE",
      reason: "INITIAL_STAGE",
      correlationId: requestId,
    });

    await transaction.insert(auditEvents).values({
      organizationId: viewer.organizationId,
      businessUnitId: input.businessUnitId,
      actorType: "USER",
      actorUserId: viewer.userId,
      action: "LEAD_CREATED",
      targetType: "LEAD",
      targetId: lead.id,
      outcome: "SUCCESS",
      requestId,
      correlationId: requestId,
      changeSummary: {
        pipelineId,
        stageId: initialStage.id,
        stageCode: initialStage.code,
        contactResolution:
          identityDecision.kind === "CREATE_CONTACT" && reviewRequired
            ? "CREATE_POSSIBLE_DUPLICATE"
            : identityDecision.kind,
        ownerMembershipId: input.ownerMembershipId ?? null,
      },
    });

    if (input.ownerMembershipId) {
      await transaction.insert(auditEvents).values({
        organizationId: viewer.organizationId,
        businessUnitId: input.businessUnitId,
        actorType: "USER",
        actorUserId: viewer.userId,
        action: "LEAD_ASSIGNED",
        targetType: "LEAD",
        targetId: lead.id,
        outcome: "SUCCESS",
        requestId,
        correlationId: requestId,
        changeSummary: {
          fromOwnerMembershipId: null,
          toOwnerMembershipId: input.ownerMembershipId,
          assignedByMembershipId: viewer.activeMembershipId,
          assignedAt: now.toISOString(),
          version: lead.version,
        },
      });
    }

    await transaction.insert(outboxEvents).values({
      organizationId: viewer.organizationId,
      businessUnitId: input.businessUnitId,
      eventType: "crm.lead.created",
      eventVersion: 1,
      aggregateType: "LEAD",
      aggregateId: lead.id,
      aggregateVersion: lead.version,
      actorType: "USER",
      actorUserId: viewer.userId,
      correlationId: requestId,
      payload: {
        leadId: lead.id,
        contactId,
        businessUnitId: input.businessUnitId,
        pipelineId,
        stageId: initialStage.id,
        stageCode: initialStage.code,
        sourceProvider,
        version: lead.version,
      },
    });

    if (input.ownerMembershipId) {
      await transaction.insert(outboxEvents).values({
        organizationId: viewer.organizationId,
        businessUnitId: input.businessUnitId,
        eventType: "crm.lead.assigned",
        eventVersion: 1,
        aggregateType: "LEAD",
        aggregateId: lead.id,
        aggregateVersion: lead.version,
        actorType: "USER",
        actorUserId: viewer.userId,
        correlationId: requestId,
        payload: {
          leadId: lead.id,
          businessUnitId: input.businessUnitId,
          ownerMembershipId: input.ownerMembershipId,
          assignedByMembershipId: viewer.activeMembershipId,
          version: lead.version,
        },
      });
    }

    const responseSnapshot = await loadLeadCreateReplaySnapshot(lead.id);
    const responseMac = leadCreateResponseMac({
      organizationId: viewer.organizationId,
      businessUnitId: input.businessUnitId,
      actorScope,
      actorUserId: viewer.userId,
      commandName: IDEMPOTENCY_COMMAND,
      idempotencyKey,
      requestHash,
      status: "COMPLETED",
      resultEntityType: "LEAD",
      resultEntityId: lead.id,
      responseCode: 201,
      responseSnapshot,
    });
    const [completed] = await transaction
      .update(idempotencyKeys)
      .set({
        status: "COMPLETED",
        resultEntityType: "LEAD",
        resultEntityId: lead.id,
        responseCode: 201,
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

    return {
      lead: hydrateCreatedLead(responseSnapshot, input, normalizedPhone, sourceProvider),
      replayed: false,
      responseCode: 201,
    };
  });
}

function requestHashForPhone(normalizedPhone: string): Uint8Array {
  return hashSensitiveLookup(`contact:PHONE:${normalizedPhone}`);
}
