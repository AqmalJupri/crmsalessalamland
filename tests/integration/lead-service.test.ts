import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Viewer } from "@/server/auth/viewer";
import { closeDatabaseConnection } from "@/server/db/client";
import { resetRuntimeConfigForTests } from "@/server/env";
import { createLead, type CreatedLead } from "@/server/leads/create-lead";
import { transitionLeadRecord } from "@/server/leads/transition-lead";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for lead integration tests.");

const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^crm_salam_(test|codex)_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Lead integration tests require an isolated CRM test database.");
}

const hashKey = "integration-auth-hash-key-at-least-32-characters";
const responseMacDomain = "idempotency-response:v1";
const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const ids = {
  organization: randomUUID(),
  businessUnit: randomUUID(),
  businessUnitB: randomUUID(),
  user: randomUUID(),
  membership: randomUUID(),
  membershipB: randomUUID(),
  assigneeUser: randomUUID(),
  assigneeMembership: randomUUID(),
  futureOwnerUser: randomUUID(),
  futureOwnerMembership: randomUUID(),
  expiredOwnerUser: randomUUID(),
  expiredOwnerMembership: randomUUID(),
  suspendedOwnerUser: randomUUID(),
  suspendedOwnerMembership: randomUUID(),
  serviceOwnerUser: randomUUID(),
  serviceOwnerMembership: randomUUID(),
  pipeline: randomUUID(),
  pipelineB: randomUUID(),
  stageNew: randomUUID(),
  stageAssigned: randomUUID(),
  stageNewB: randomUUID(),
};

const viewer: Viewer = {
  userId: ids.user,
  displayName: "Agent Integration",
  organizationId: ids.organization,
  businessUnitId: ids.businessUnit,
  businessUnits: [
    { id: ids.businessUnit, name: "Sales Integration", code: "sales-integration", slug: "sales-integration" },
    { id: ids.businessUnitB, name: "Sales B", code: "sales-b", slug: "sales-b" },
  ],
  businessUnitAccess: [
    {
      id: ids.businessUnit,
      name: "Sales Integration",
      code: "sales-integration",
      slug: "sales-integration",
      membershipIds: [ids.membership],
      capabilities: ["lead.create", "lead.update", "lead.assign", "lead.reopen"],
      capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
    },
    {
      id: ids.businessUnitB,
      name: "Sales B",
      code: "sales-b",
      slug: "sales-b",
      membershipIds: [ids.membershipB],
      capabilities: ["lead.create", "lead.update", "lead.assign", "lead.reopen"],
      capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
    },
  ],
  activeMembershipId: ids.membership,
  membershipIds: [ids.membership],
  capabilities: ["lead.create", "lead.update", "lead.assign", "lead.reopen"],
  capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
  demo: false,
};

const viewerB: Viewer = {
  ...viewer,
  businessUnitId: ids.businessUnitB,
  activeMembershipId: ids.membershipB,
  membershipIds: [ids.membershipB],
};

let firstLead: CreatedLead;

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

function responseMacForTest(input: {
  actorScope: string;
  actorUserId: string | null;
  businessUnitId: string | null;
  idempotencyKey: string;
  organizationId: string;
  requestHash: Uint8Array;
  responseSnapshot: Record<string, unknown>;
  resultEntityId: string;
}): Buffer {
  const envelope = canonicalize({
    actorScope: input.actorScope,
    actorUserId: input.actorUserId,
    businessUnitId: input.businessUnitId,
    commandName: "lead.create",
    idempotencyKey: input.idempotencyKey,
    organizationId: input.organizationId,
    requestHash: Buffer.from(input.requestHash).toString("base64url"),
    responseCode: 201,
    responseSnapshot: input.responseSnapshot,
    resultEntityId: input.resultEntityId,
    resultEntityType: "LEAD",
    status: "COMPLETED",
  });
  return createHmac("sha256", hashKey)
    .update(`${responseMacDomain}:${JSON.stringify(envelope)}`)
    .digest();
}

beforeAll(async () => {
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: hashKey,
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "crm-integration",
    OIDC_CLIENT_SECRET: "integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();

  await sql.unsafe("drop schema if exists public cascade; create schema public");
  const migration = await readFile(resolve(process.cwd(), "db/migrations/0001_foundation.sql"), "utf8");
  await sql.begin((transaction) => transaction.unsafe(migration));

  await sql`
    insert into organizations (id, code, name)
    values (${ids.organization}, 'salam-integration', 'Salam Integration')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values
      (${ids.businessUnit}, ${ids.organization}, 'sales-integration', 'Sales Integration'),
      (${ids.businessUnitB}, ${ids.organization}, 'sales-b', 'Sales B')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, user_type, status)
    values
      (${ids.user}, 'https://identity.example.test|agent', 'Agent Integration', 'HUMAN', 'ACTIVE'),
      (${ids.assigneeUser}, 'https://identity.example.test|assignee', 'Assignee', 'HUMAN', 'ACTIVE'),
      (${ids.futureOwnerUser}, 'https://identity.example.test|future-owner', 'Future Owner', 'HUMAN', 'ACTIVE'),
      (${ids.expiredOwnerUser}, 'https://identity.example.test|expired-owner', 'Expired Owner', 'HUMAN', 'ACTIVE'),
      (${ids.suspendedOwnerUser}, 'https://identity.example.test|suspended-owner', 'Suspended Owner', 'HUMAN', 'SUSPENDED'),
      (${ids.serviceOwnerUser}, 'service:lead-owner', 'Service Owner', 'SERVICE', 'ACTIVE')
  `;
  await sql`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from, valid_until
    )
    values
      (${ids.membership}, ${ids.organization}, ${ids.businessUnit}, ${ids.user}, 'ACTIVE', now() - interval '1 day', null),
      (${ids.membershipB}, ${ids.organization}, ${ids.businessUnitB}, ${ids.user}, 'ACTIVE', now() - interval '1 day', null),
      (${ids.assigneeMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.assigneeUser}, 'ACTIVE', now() - interval '1 day', null),
      (${ids.futureOwnerMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.futureOwnerUser}, 'ACTIVE', now() + interval '1 day', null),
      (${ids.expiredOwnerMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.expiredOwnerUser}, 'ACTIVE', now() - interval '2 days', now() - interval '1 day'),
      (${ids.suspendedOwnerMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.suspendedOwnerUser}, 'ACTIVE', now() - interval '1 day', null),
      (${ids.serviceOwnerMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.serviceOwnerUser}, 'ACTIVE', now() - interval '1 day', null)
  `;
  await sql`
    insert into pipelines (id, organization_id, business_unit_id, entity_type, code, name)
    values
      (${ids.pipeline}, ${ids.organization}, ${ids.businessUnit}, 'LEAD', 'lead-default', 'Lead Default'),
      (${ids.pipelineB}, ${ids.organization}, ${ids.businessUnitB}, 'LEAD', 'lead-default', 'Lead Default B')
  `;
  await sql`
    insert into pipeline_stages (
      id, organization_id, business_unit_id, pipeline_id, code, name, category, position
    ) values
      (${ids.stageNew}, ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, 'new', 'Baharu', 'OPEN', 0),
      (${ids.stageAssigned}, ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, 'assigned', 'Ditugaskan', 'OPEN', 1),
      (${ids.stageNewB}, ${ids.organization}, ${ids.businessUnitB}, ${ids.pipelineB}, 'new', 'Baharu', 'OPEN', 0)
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("lead application service", () => {
  it("rejects a write outside the viewer's active business-unit context", async () => {
    await expect(
      createLead(
        viewer,
        {
          businessUnitId: ids.businessUnitB,
          name: "Cross Scope Lead",
          phone: "0198765432",
          source: "Website",
        },
        "lead-service-cross-scope-001",
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "BUSINESS_UNIT_CONTEXT_REQUIRED", status: 403 });
  });

  it("canonicalizes provider identity inside the service and closes case-based uniqueness bypasses", async () => {
    const externalLeadId = "meta-canonical-001";
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Canonical Provider One",
        phone: "0112345678",
        source: " Meta ",
        externalLeadId,
      },
      "lead-provider-canonical-001",
      randomUUID(),
    );

    expect(created.lead.source).toBe("meta");
    const [stored] = await sql<{ source_provider: string }[]>`
      select source_provider from leads where id = ${created.lead.id}
    `;
    expect(stored?.source_provider).toBe("meta");

    await expect(
      createLead(
        viewer,
        {
          businessUnitId: ids.businessUnit,
          name: "Canonical Provider Two",
          phone: "0112345679",
          sourceProvider: "meta",
          externalLeadId,
        },
        "lead-provider-canonical-002",
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint_name: "leads_provider_external_unique" },
    });
  });

  it("owns receivedAt at the service boundary even if an internal caller supplies it", async () => {
    const callerReceivedAt = "2020-01-01T00:00:00.000Z";
    const before = Date.now();
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Server Received Time",
        phone: "0112345680",
        source: "website",
        receivedAt: callerReceivedAt,
      } as Parameters<typeof createLead>[1] & { receivedAt: string },
      "lead-server-received-at",
      randomUUID(),
    );
    const after = Date.now();
    const receivedAt = Date.parse(created.lead.receivedAt);

    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(receivedAt).toBeLessThanOrEqual(after);
    expect(created.lead.receivedAt).not.toBe(callerReceivedAt);

    const [stored] = await sql<{ received_at: Date }[]>`
      select received_at from leads where id = ${created.lead.id}
    `;
    expect(stored?.received_at.toISOString()).toBe(created.lead.receivedAt);
  });

  it("rejects owners whose membership or joined user is not effective and human at command time", async () => {
    const invalidOwners = [
      ["future", ids.futureOwnerMembership],
      ["expired", ids.expiredOwnerMembership],
      ["suspended-user", ids.suspendedOwnerMembership],
      ["service-user", ids.serviceOwnerMembership],
    ] as const;

    for (const [index, [label, ownerMembershipId]] of invalidOwners.entries()) {
      await expect(
        createLead(
          viewer,
          {
            businessUnitId: ids.businessUnit,
            name: `Invalid Owner ${label}`,
            phone: `01800000${index + 10}`,
            source: "website",
            ownerMembershipId,
          },
          `lead-invalid-owner-${label}`,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "OWNER_MEMBERSHIP_INVALID", status: 422 });
    }
  });

  it("revalidates owner effectiveness during assignment transitions", async () => {
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Transition Owner Validation",
        phone: "0180000020",
        source: "website",
      },
      "lead-transition-owner-validation",
      randomUUID(),
    );

    await expect(
      transitionLeadRecord(
        viewer,
        created.lead.id,
        {
          businessUnitId: ids.businessUnit,
          version: created.lead.version,
          stage: created.lead.stage,
          ownerMembershipId: ids.expiredOwnerMembership,
          reason: "Manual assignment",
        },
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "OWNER_MEMBERSHIP_INVALID", status: 422 });
  });

  it("records initial assignment provenance and a separate PII-free assignment signal", async () => {
    const requestId = randomUUID();
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Initial Assignment Evidence",
        phone: "0180000030",
        source: "website",
        ownerMembershipId: ids.assigneeMembership,
      },
      "lead-initial-assignment-evidence",
      requestId,
    );

    const [stored] = await sql<{
      owner_membership_id: string | null;
      assigned_by_membership_id: string | null;
      assigned_at: Date | null;
    }[]>`
      select owner_membership_id, assigned_by_membership_id, assigned_at
      from leads where id = ${created.lead.id}
    `;
    expect(stored).toMatchObject({
      owner_membership_id: ids.assigneeMembership,
      assigned_by_membership_id: viewer.activeMembershipId,
    });
    expect(stored?.assigned_at).toBeInstanceOf(Date);

    const outbox = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
      select event_type, payload from outbox_events
      where aggregate_id = ${created.lead.id} and correlation_id = ${requestId}
      order by created_at, id
    `;
    expect(outbox.map((event) => event.event_type).sort()).toEqual([
      "crm.lead.assigned",
      "crm.lead.created",
    ]);
    expect(outbox.find((event) => event.event_type === "crm.lead.assigned")?.payload).toMatchObject({
      leadId: created.lead.id,
      businessUnitId: ids.businessUnit,
      ownerMembershipId: ids.assigneeMembership,
      assignedByMembershipId: viewer.activeMembershipId,
      version: 1,
    });
    expect(JSON.stringify(outbox)).not.toContain("Initial Assignment Evidence");
    expect(JSON.stringify(outbox)).not.toContain("0180000030");

    const audit = await sql<{ action: string; change_summary: Record<string, unknown> }[]>`
      select action, change_summary from audit_events
      where target_id = ${created.lead.id} and correlation_id = ${requestId}
      order by created_at, id
    `;
    expect(audit.map((event) => event.action).sort()).toEqual(["LEAD_ASSIGNED", "LEAD_CREATED"]);
  });

  it("requires assignment reasons and clears provenance when unassigning", async () => {
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Assignment Reason Guard",
        phone: "0180000031",
        source: "website",
        ownerMembershipId: ids.assigneeMembership,
      },
      "lead-assignment-reason-guard",
      randomUUID(),
    );

    await expect(
      transitionLeadRecord(
        viewer,
        created.lead.id,
        {
          businessUnitId: ids.businessUnit,
          version: created.lead.version,
          stage: created.lead.stage,
          ownerMembershipId: ids.membership,
        },
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_REASON_REQUIRED", status: 422 });

    await expect(
      transitionLeadRecord(
        viewer,
        created.lead.id,
        {
          businessUnitId: ids.businessUnit,
          version: created.lead.version,
          stage: created.lead.stage,
          ownerMembershipId: null,
          reason: "   ",
        },
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "ASSIGNMENT_REASON_REQUIRED", status: 422 });

    const requestId = randomUUID();
    const unassigned = await transitionLeadRecord(
      viewer,
      created.lead.id,
      {
        businessUnitId: ids.businessUnit,
        version: created.lead.version,
        stage: created.lead.stage,
        ownerMembershipId: null,
        reason: "Returned to shared queue",
      },
      requestId,
      randomUUID(),
    );
    expect(unassigned).toMatchObject({ changed: true, lead: { ownerMembershipId: null, version: 2 } });

    const [stored] = await sql<{
      owner_membership_id: string | null;
      assigned_by_membership_id: string | null;
      assigned_at: Date | null;
    }[]>`
      select owner_membership_id, assigned_by_membership_id, assigned_at
      from leads where id = ${created.lead.id}
    `;
    expect(stored).toEqual({
      owner_membership_id: null,
      assigned_by_membership_id: null,
      assigned_at: null,
    });

    const [assignmentEvent] = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
      select event_type, payload from outbox_events
      where aggregate_id = ${created.lead.id} and correlation_id = ${requestId}
    `;
    expect(assignmentEvent).toMatchObject({
      event_type: "crm.lead.unassigned",
      payload: {
        leadId: created.lead.id,
        previousOwnerMembershipId: ids.assigneeMembership,
        ownerMembershipId: null,
        assignedByMembershipId: viewer.activeMembershipId,
        version: 2,
      },
    });

    const [assignmentAudit] = await sql<{ action: string }[]>`
      select action from audit_events
      where target_id = ${created.lead.id} and correlation_id = ${requestId}
    `;
    expect(assignmentAudit?.action).toBe("LEAD_UNASSIGNED");
  });

  it("allows an initial owner assignment without a reassignment reason", async () => {
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Initial Assignment Later",
        phone: "0180000032",
        source: "website",
      },
      "lead-initial-assignment-later",
      randomUUID(),
    );

    await expect(
      transitionLeadRecord(
        viewer,
        created.lead.id,
        {
          businessUnitId: ids.businessUnit,
          version: created.lead.version,
          stage: created.lead.stage,
          ownerMembershipId: ids.assigneeMembership,
        },
        randomUUID(),
        randomUUID(),
      ),
    ).resolves.toMatchObject({
      changed: true,
      lead: { ownerMembershipId: ids.assigneeMembership, version: 2 },
    });
  });

  it("creates one durable lead and replays the same idempotent result", async () => {
    const input = {
      businessUnitId: ids.businessUnit,
      name: "Aisyah Rahman",
      phone: "012-345 6789",
      source: "Website",
      productInterest: "Lot A-101",
    };
    const key = "lead-service-create-001";
    const created = await createLead(viewer, input, key, randomUUID());
    const replayed = await createLead(viewer, input, key, randomUUID());
    firstLead = created.lead;

    expect(created.replayed).toBe(false);
    expect(replayed).toMatchObject({ replayed: true, lead: { id: created.lead.id } });

    const [evidence] = await sql<{
      leads: string;
      history: string;
      audit: string;
      outbox: string;
      idempotency: string;
    }[]>`
      select
        (select count(*) from leads where id = ${created.lead.id})::text as leads,
        (select count(*) from lead_stage_history where lead_id = ${created.lead.id})::text as history,
        (select count(*) from audit_events where target_id = ${created.lead.id})::text as audit,
        (select count(*) from outbox_events where aggregate_id = ${created.lead.id})::text as outbox,
        (select count(*) from idempotency_keys where result_entity_id = ${created.lead.id})::text as idempotency
    `;
    expect(evidence).toEqual({ leads: "1", history: "1", audit: "1", outbox: "1", idempotency: "1" });

    const [identifier] = await sql<{ value_hash: Uint8Array }[]>`
      select value_hash from contact_identifiers where contact_id = ${created.lead.contactId}
    `;
    const expectedHmac = createHmac("sha256", hashKey)
      .update("contact:PHONE:+60123456789")
      .digest();
    const unsafePlainHash = createHash("sha256").update("contact:PHONE:+60123456789").digest();
    expect(Buffer.from(identifier!.value_hash)).toEqual(expectedHmac);
    expect(Buffer.from(identifier!.value_hash)).not.toEqual(unsafePlainHash);
  });

  it("creates a review candidate instead of merging a shared phone", async () => {
    const result = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Hakim Rahman",
        phone: "+60123456789",
        source: "Referral",
      },
      "lead-service-create-002",
      randomUUID(),
    );

    expect(result.lead.contactId).not.toBe(firstLead.contactId);
    const [contact] = await sql<{ status: string }[]>`
      select status from contacts where id = ${result.lead.contactId}
    `;
    expect(contact?.status).toBe("POSSIBLE_DUPLICATE");
  });

  it("detects but does not link a verified contact across business units", async () => {
    const original = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Sofia Ismail",
        phone: "0145678901",
        source: "Website",
      },
      "lead-service-cross-bu-001",
      randomUUID(),
    );
    await sql`
      update contact_identifiers
      set verification_status = 'VERIFIED', verified_at = now()
      where contact_id = ${original.lead.contactId} and identifier_type = 'PHONE'
    `;

    const target = await createLead(
      viewerB,
      {
        businessUnitId: ids.businessUnitB,
        name: "Sofia Ismail",
        phone: "+60145678901",
        source: "Referral",
      },
      "lead-service-cross-bu-002",
      randomUUID(),
    );

    expect(target.lead.contactId).not.toBe(original.lead.contactId);
    const [evidence] = await sql<{ target_status: string; unauthorized_links: string }[]>`
      select
        (select status from contacts where id = ${target.lead.contactId}) as target_status,
        (
          select count(*) from contact_business_units
          where contact_id = ${original.lead.contactId}
            and business_unit_id = ${ids.businessUnitB}
        )::text as unauthorized_links
    `;
    expect(evidence).toEqual({ target_status: "POSSIBLE_DUPLICATE", unauthorized_links: "0" });
  });

  it("rejects an explicit cross-unit transition before creating any durable mutation", async () => {
    const target = await createLead(
      viewerB,
      {
        businessUnitId: ids.businessUnitB,
        name: "Cross Unit Transition Guard",
        phone: "0175550188",
        source: "website",
      },
      "lead-cross-unit-transition-source-001",
      randomUUID(),
    );
    const key = "lead-cross-unit-transition-denied-001";
    const [before] = await sql<{
      stage_id: string;
      owner_membership_id: string | null;
      version: string;
    }[]>`
      select stage_id, owner_membership_id, version::text
      from leads where id = ${target.lead.id}
    `;

    await expect(
      transitionLeadRecord(
        viewer,
        target.lead.id,
        {
          businessUnitId: ids.businessUnitB,
          version: target.lead.version,
          stage: target.lead.stage,
        },
        randomUUID(),
        key,
      ),
    ).rejects.toMatchObject({ code: "BUSINESS_UNIT_FORBIDDEN", status: 403 });

    const [after] = await sql<{
      stage_id: string;
      owner_membership_id: string | null;
      version: string;
    }[]>`
      select stage_id, owner_membership_id, version::text
      from leads where id = ${target.lead.id}
    `;
    const [idempotency] = await sql<{ count: string }[]>`
      select count(*)::text as count
      from idempotency_keys
      where organization_id = ${ids.organization}
        and command_name = 'lead.transition'
        and idempotency_key = ${key}
    `;
    expect(after).toEqual(before);
    expect(idempotency?.count).toBe("0");
  });

  it("does not reactivate or reuse a contact whose business-unit relationship becomes restricted", async () => {
    const input = {
      businessUnitId: ids.businessUnit,
      name: "Relationship Race Guard",
      phone: "0175550199",
      source: "website",
    };
    const original = await createLead(
      viewer,
      input,
      "lead-relationship-race-source-001",
      randomUUID(),
    );
    await sql`
      update contact_identifiers
      set verification_status = 'VERIFIED', verified_at = now()
      where contact_id = ${original.lead.contactId} and identifier_type = 'PHONE'
    `;

    let announceRestriction!: (pid: number) => void;
    const restrictionHeld = new Promise<number>((resolve) => {
      announceRestriction = resolve;
    });
    let releaseRestriction!: () => void;
    const mayReleaseRestriction = new Promise<void>((resolve) => {
      releaseRestriction = resolve;
    });
    const restrictor = sql.begin(async (transaction) => {
      const [session] = await transaction<{ pid: number }[]>`
        select pg_backend_pid()::integer as pid
      `;
      await transaction`
        update contact_business_units
        set status = 'RESTRICTED'
        where organization_id = ${ids.organization}
          and business_unit_id = ${ids.businessUnit}
          and contact_id = ${original.lead.contactId}
          and relationship_type = 'CUSTOMER'
      `;
      announceRestriction(session!.pid);
      await mayReleaseRestriction;
    });
    const restrictorPid = await restrictionHeld;

    const attempt = createLead(
      viewer,
      input,
      "lead-relationship-race-target-001",
      randomUUID(),
    ).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    const observer = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
    let lockWaitObserved = false;
    try {
      const deadline = Date.now() + 2_000;
      while (!lockWaitObserved && Date.now() < deadline) {
        const [wait] = await observer<{ waiting: boolean }[]>`
          select exists (
            select 1 from pg_stat_activity activity
            where activity.datname = current_database()
              and activity.pid <> pg_backend_pid()
              and ${restrictorPid} = any(pg_blocking_pids(activity.pid))
          ) as waiting
        `;
        lockWaitObserved = wait?.waiting ?? false;
        if (!lockWaitObserved) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseRestriction();
      await restrictor;
      await observer.end();
    }
    expect(lockWaitObserved).toBe(true);

    const outcome = await attempt;
    expect(outcome.status).toBe("fulfilled");
    if (outcome.status !== "fulfilled") throw outcome.error;
    expect(outcome.value.lead.contactId).not.toBe(original.lead.contactId);

    const [evidence] = await sql<{
      original_relationship_status: string;
      new_leads_on_original: string;
      target_status: string;
    }[]>`
      select
        (
          select status from contact_business_units
          where organization_id = ${ids.organization}
            and business_unit_id = ${ids.businessUnit}
            and contact_id = ${original.lead.contactId}
            and relationship_type = 'CUSTOMER'
        ) as original_relationship_status,
        (
          select count(*) from leads
          where contact_id = ${original.lead.contactId} and id <> ${original.lead.id}
        )::text as new_leads_on_original,
        (
          select status from contacts where id = ${outcome.value.lead.contactId}
        ) as target_status
    `;
    expect(evidence).toEqual({
      original_relationship_status: "RESTRICTED",
      new_leads_on_original: "0",
      target_status: "POSSIBLE_DUPLICATE",
    });
  });

  it("collapses concurrent retries with the same idempotency key", async () => {
    const input = {
      businessUnitId: ids.businessUnit,
      name: "Concurrent Lead",
      phone: "0134567890",
      source: "Meta",
      sourceExternalId: "meta-concurrent-001",
    };
    const [left, right] = await Promise.all([
      createLead(viewer, input, "lead-service-concurrent-001", randomUUID()),
      createLead(viewer, input, "lead-service-concurrent-001", randomUUID()),
    ]);

    expect(left.lead.id).toBe(right.lead.id);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    const [count] = await sql<{ count: string }[]>`
      select count(*)::text as count from leads where external_lead_id = 'meta-concurrent-001'
    `;
    expect(count?.count).toBe("1");
  });

  it("rejects unconfigured stage edges, then applies a configured optimistic transition", async () => {
    await expect(
      transitionLeadRecord(
        viewer,
        firstLead.id,
        { businessUnitId: ids.businessUnit, version: firstLead.version, stage: "assigned", ownerMembershipId: ids.membership },
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "LEAD_TRANSITION_NOT_CONFIGURED" });

    await sql`
      insert into pipeline_stage_transitions (
        organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, ${ids.stageNew}, ${ids.stageAssigned}
      )
    `;

    const result = await transitionLeadRecord(
      viewer,
      firstLead.id,
      { businessUnitId: ids.businessUnit, version: firstLead.version, stage: "assigned", ownerMembershipId: ids.membership },
      randomUUID(),
      randomUUID(),
    );
    expect(result).toMatchObject({ changed: true, lead: { stage: "assigned", version: 2 } });

    const [evidence] = await sql<{ version: string; history: string }[]>`
      select
        lead.version::text as version,
        (select count(*) from lead_stage_history where lead_id = lead.id)::text as history
      from leads lead where lead.id = ${firstLead.id}
    `;
    expect(evidence).toEqual({ version: "2", history: "2" });
  });

  it("emits distinct stage and assignment evidence when both change", async () => {
    await sql`
      insert into pipeline_stage_transitions (
        organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, ${ids.stageNew}, ${ids.stageAssigned}
      ) on conflict do nothing
    `;
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Combined Transition Evidence",
        phone: "0180000040",
        source: "website",
      },
      "lead-combined-transition-evidence",
      randomUUID(),
    );
    const requestId = randomUUID();

    const transitioned = await transitionLeadRecord(
      viewer,
      created.lead.id,
      {
        businessUnitId: ids.businessUnit,
        version: created.lead.version,
        stage: "assigned",
        ownerMembershipId: ids.assigneeMembership,
      },
      requestId,
      randomUUID(),
    );
    expect(transitioned).toMatchObject({ changed: true, lead: { stage: "assigned", version: 2 } });

    const outbox = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
      select event_type, payload from outbox_events
      where aggregate_id = ${created.lead.id} and correlation_id = ${requestId}
    `;
    expect(outbox.map((event) => event.event_type).sort()).toEqual([
      "crm.lead.assigned",
      "crm.lead.stage_changed",
    ]);
    expect(JSON.stringify(outbox)).not.toContain("Combined Transition Evidence");
    expect(JSON.stringify(outbox)).not.toContain("0180000040");

    const audit = await sql<{ action: string }[]>`
      select action from audit_events
      where target_id = ${created.lead.id} and correlation_id = ${requestId}
    `;
    expect(audit.map((event) => event.action).sort()).toEqual([
      "LEAD_ASSIGNED",
      "LEAD_STAGE_CHANGED",
    ]);
  });

  it("preserves assignment provenance when a stage command repeats the same owner", async () => {
    await sql`
      insert into pipeline_stage_transitions (
        organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, ${ids.stageNew}, ${ids.stageAssigned}
      ) on conflict do nothing
    `;
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Preserved Assignment Provenance",
        phone: "0180000041",
        source: "website",
        ownerMembershipId: ids.assigneeMembership,
      },
      "lead-preserve-assignment-provenance",
      randomUUID(),
    );
    const originalAssignedAt = new Date("2026-01-01T00:00:00.000Z");
    const [before] = await sql<{
      version: string;
      assigned_by_membership_id: string;
      assigned_at: Date;
    }[]>`
      update leads set assigned_at = ${originalAssignedAt}
      where id = ${created.lead.id}
      returning version, assigned_by_membership_id, assigned_at
    `;

    await transitionLeadRecord(
      viewer,
      created.lead.id,
      {
        businessUnitId: ids.businessUnit,
        version: Number(before!.version),
        stage: "assigned",
        ownerMembershipId: ids.assigneeMembership,
      },
      randomUUID(),
      randomUUID(),
    );

    const [after] = await sql<{
      assigned_by_membership_id: string;
      assigned_at: Date;
    }[]>`
      select assigned_by_membership_id, assigned_at from leads where id = ${created.lead.id}
    `;
    expect(after).toEqual({
      assigned_by_membership_id: before!.assigned_by_membership_id,
      assigned_at: originalAssignedAt,
    });
  });

  it("replays the immutable created response after mutable lead state changes", async () => {
    await sql`
      insert into pipeline_stage_transitions (
        organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, ${ids.stageNew}, ${ids.stageAssigned}
      ) on conflict do nothing
    `;
    const input = {
      businessUnitId: ids.businessUnit,
      name: "Immutable Replay",
      phone: "017-555 0101",
      source: "Meta",
      externalLeadId: "meta-immutable-replay-001",
      productInterest: "Private preference for Nur Aisyah",
      ownerMembershipId: ids.assigneeMembership,
    };
    const key = "lead-immutable-replay-001";
    const created = await createLead(viewer, input, key, randomUUID());

    await transitionLeadRecord(
      viewer,
      created.lead.id,
      { businessUnitId: ids.businessUnit, version: created.lead.version, stage: "assigned" },
      randomUUID(),
      randomUUID(),
    );
    await sql`update contacts set display_name = 'Mutated Contact' where id = ${created.lead.contactId}`;
    await sql`update leads set title = 'Mutated Lead' where id = ${created.lead.id}`;

    const replayed = await createLead(viewer, input, key, randomUUID());
    expect(replayed.replayed).toBe(true);
    expect(created.responseCode).toBe(201);
    expect(replayed.responseCode).toBe(created.responseCode);
    expect(replayed.lead).toEqual(created.lead);

    await expect(
      createLead(viewer, { ...input, name: "Different Payload" }, key, randomUUID()),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH", status: 409 });

    const [evidence] = await sql<{
      request_hash: Uint8Array;
      response_snapshot: Record<string, unknown> | null;
      response_mac: Uint8Array | null;
    }[]>`
      select request_hash, response_snapshot, response_mac from idempotency_keys
      where organization_id = ${ids.organization}
        and actor_scope = ${`USER:${ids.user}`}
        and command_name = 'lead.create'
        and idempotency_key = ${key}
    `;
    const canonicalRequest = JSON.stringify({
      attribution: {},
      businessUnitId: ids.businessUnit,
      externalLeadId: input.externalLeadId,
      name: input.name,
      normalizedPhone: "+60175550101",
      ownerMembershipId: input.ownerMembershipId,
      productInterest: input.productInterest,
      sourceProvider: "meta",
    });
    const expectedRequestHash = createHmac("sha256", hashKey)
      .update(`idempotency:lead.create:${canonicalRequest}`)
      .digest();
    const expectedSnapshot = {
      id: created.lead.id,
      contactId: created.lead.contactId,
      pipelineId: created.lead.pipelineId,
      stageId: created.lead.stageId,
      stage: created.lead.stage,
      version: created.lead.version,
      receivedAt: created.lead.receivedAt,
      createdAt: created.lead.createdAt,
    };
    expect(Buffer.from(evidence!.request_hash)).toEqual(expectedRequestHash);
    expect(evidence?.response_snapshot).toEqual(expectedSnapshot);
    expect(evidence?.response_mac).toBeInstanceOf(Uint8Array);
    expect(evidence?.response_mac).toHaveLength(32);
    expect(Buffer.from(evidence!.response_mac!)).toEqual(
      responseMacForTest({
        actorScope: `USER:${ids.user}`,
        actorUserId: ids.user,
        businessUnitId: ids.businessUnit,
        idempotencyKey: key,
        organizationId: ids.organization,
        requestHash: expectedRequestHash,
        responseSnapshot: expectedSnapshot,
        resultEntityId: created.lead.id,
      }),
    );
    expect(evidence?.response_snapshot).not.toHaveProperty("name");
    expect(evidence?.response_snapshot).not.toHaveProperty("phone");
    expect(evidence?.response_snapshot).not.toHaveProperty("source");
    expect(evidence?.response_snapshot).not.toHaveProperty("productInterest");
    expect(evidence?.response_snapshot).not.toHaveProperty("ownerMembershipId");
    expect(JSON.stringify(evidence?.response_snapshot)).not.toContain(input.name);
    expect(JSON.stringify(evidence?.response_snapshot)).not.toContain("+60175550101");
    expect(JSON.stringify(evidence?.response_snapshot)).not.toContain(input.productInterest);
  });

  it("fails closed when a completed idempotency snapshot identifies another lead", async () => {
    const input = {
      businessUnitId: ids.businessUnit,
      name: "Corrupt Snapshot Guard",
      phone: "0175550102",
      source: "website",
    };
    const originalKey = "lead-corrupt-snapshot-source-001";
    const corruptKey = "lead-corrupt-snapshot-replay-001";
    const created = await createLead(viewer, input, originalKey, randomUUID());
    const [original] = await sql<{ request_hash: Uint8Array }[]>`
      select request_hash from idempotency_keys
      where organization_id = ${ids.organization}
        and actor_scope = ${`USER:${ids.user}`}
        and command_name = 'lead.create'
        and idempotency_key = ${originalKey}
    `;
    const mismatchedSnapshot = {
      id: randomUUID(),
      contactId: created.lead.contactId,
      pipelineId: created.lead.pipelineId,
      stageId: created.lead.stageId,
      stage: created.lead.stage,
      version: created.lead.version,
      receivedAt: created.lead.receivedAt,
      createdAt: created.lead.createdAt,
    };
    const mismatchedResponseMac = responseMacForTest({
      actorScope: `USER:${ids.user}`,
      actorUserId: ids.user,
      businessUnitId: ids.businessUnit,
      idempotencyKey: corruptKey,
      organizationId: ids.organization,
      requestHash: original!.request_hash,
      responseSnapshot: mismatchedSnapshot,
      resultEntityId: created.lead.id,
    });
    await sql`
      insert into idempotency_keys (
        organization_id, business_unit_id, actor_scope, actor_user_id,
        command_name, idempotency_key, request_hash, status,
        result_entity_type, result_entity_id, response_code, response_snapshot,
        response_mac, locked_at, expires_at, completed_at
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${`USER:${ids.user}`}, ${ids.user},
        'lead.create', ${corruptKey}, ${original!.request_hash}, 'COMPLETED',
        'LEAD', ${created.lead.id}, 201, ${sql.json(mismatchedSnapshot)},
        ${mismatchedResponseMac}, now(), now() + interval '1 day', now()
      )
    `;

    await expect(createLead(viewer, input, corruptKey, randomUUID())).rejects.toMatchObject({
      code: "IDEMPOTENCY_RESPONSE_INVALID",
      status: 409,
    });
  });

  it("fails closed when a well-shaped same-lead snapshot has an invalid response MAC", async () => {
    const input = {
      businessUnitId: ids.businessUnit,
      name: "Forged Snapshot Guard",
      phone: "0175550104",
      source: "website",
    };
    const originalKey = "lead-forged-snapshot-source-001";
    const forgedKey = "lead-forged-snapshot-replay-001";
    const created = await createLead(viewer, input, originalKey, randomUUID());
    const [original] = await sql<{ request_hash: Uint8Array }[]>`
      select request_hash from idempotency_keys
      where organization_id = ${ids.organization}
        and actor_scope = ${`USER:${ids.user}`}
        and command_name = 'lead.create'
        and idempotency_key = ${originalKey}
    `;
    const forgedSnapshot = {
      id: created.lead.id,
      contactId: created.lead.contactId,
      pipelineId: created.lead.pipelineId,
      stageId: created.lead.stageId,
      stage: "forged",
      version: created.lead.version,
      receivedAt: created.lead.receivedAt,
      createdAt: created.lead.createdAt,
    };
    await sql`
      insert into idempotency_keys (
        organization_id, business_unit_id, actor_scope, actor_user_id,
        command_name, idempotency_key, request_hash, status,
        result_entity_type, result_entity_id, response_code, response_snapshot,
        response_mac, locked_at, expires_at, completed_at
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${`USER:${ids.user}`}, ${ids.user},
        'lead.create', ${forgedKey}, ${original!.request_hash}, 'COMPLETED',
        'LEAD', ${created.lead.id}, 201, ${sql.json(forgedSnapshot)},
        ${Buffer.alloc(32, 99)}, now(), now() + interval '1 day', now()
      )
    `;

    await expect(createLead(viewer, input, forgedKey, randomUUID())).rejects.toMatchObject({
      code: "IDEMPOTENCY_RESPONSE_INVALID",
      status: 409,
    });
  });

  it("locks before a no-op decision and rejects a version made stale by the lock holder", async () => {
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "No-op Lock Guard",
        phone: "0175550103",
        source: "website",
      },
      "lead-no-op-lock-guard",
      randomUUID(),
    );

    let announceLock!: (pid: number) => void;
    const lockAcquired = new Promise<number>((resolve) => {
      announceLock = resolve;
    });
    let releaseLock!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = sql.begin(async (transaction) => {
      const [session] = await transaction<{ pid: number }[]>`
        select pg_backend_pid()::integer as pid
      `;
      await transaction`select id from leads where id = ${created.lead.id} for update`;
      announceLock(session!.pid);
      await mayRelease;
      await transaction`
        update leads set title = 'Concurrent mutation' where id = ${created.lead.id}
      `;
    });
    const blockerPid = await lockAcquired;

    const attempt = transitionLeadRecord(
      viewer,
      created.lead.id,
      { businessUnitId: ids.businessUnit, version: created.lead.version, stage: created.lead.stage },
      randomUUID(),
      randomUUID(),
    ).then(
      (value) => {
        return { status: "fulfilled" as const, value };
      },
      (error: unknown) => {
        return { status: "rejected" as const, error };
      },
    );

    const observer = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
    let lockWaitObserved = false;
    try {
      const deadline = Date.now() + 2_000;
      while (!lockWaitObserved && Date.now() < deadline) {
        const [wait] = await observer<{ waiting: boolean }[]>`
          select exists (
            select 1 from pg_stat_activity activity
            where activity.datname = current_database()
              and activity.pid <> pg_backend_pid()
              and ${blockerPid} = any(pg_blocking_pids(activity.pid))
          ) as waiting
        `;
        lockWaitObserved = wait?.waiting ?? false;
        if (!lockWaitObserved) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockWaitObserved).toBe(true);
    } finally {
      releaseLock();
      await blocker;
      await observer.end();
    }

    const outcome = await attempt;
    expect(outcome).toMatchObject({
      status: "rejected",
      error: { code: "VERSION_CONFLICT", status: 409 },
    });
  });

  it("fails closed for own-scoped users and permits only explicit business-unit elevation", async () => {
    await sql`
      insert into pipeline_stage_transitions (
        organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, ${ids.stageNew}, ${ids.stageAssigned}
      ) on conflict do nothing
    `;
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Record Scope Guard",
        phone: "0175550191",
        source: "website",
        ownerMembershipId: ids.assigneeMembership,
      },
      "lead-record-scope-guard",
      randomUUID(),
    );
    const ownScopedViewer: Viewer = {
      ...viewer,
      capabilities: ["lead.update"],
      capabilityRecordScopes: { "lead.update": ["OWN"] },
    };

    await expect(
      transitionLeadRecord(
        ownScopedViewer,
        created.lead.id,
        { businessUnitId: ids.businessUnit, version: created.lead.version, stage: "assigned" },
        randomUUID(),
        "lead-record-scope-denied-001",
      ),
    ).rejects.toMatchObject({ code: "LEAD_RECORD_SCOPE_FORBIDDEN", status: 403 });

    const elevated = await transitionLeadRecord(
      viewer,
      created.lead.id,
      { businessUnitId: ids.businessUnit, version: created.lead.version, stage: "assigned" },
      randomUUID(),
      "lead-record-scope-elevated-001",
    );
    expect(elevated).toMatchObject({ changed: true, replayed: false });
  });

  it("replays a committed transition after a lost response without weakening version checks", async () => {
    await sql`
      insert into pipeline_stage_transitions (
        organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.pipeline}, ${ids.stageNew}, ${ids.stageAssigned}
      ) on conflict do nothing
    `;
    const created = await createLead(
      viewer,
      {
        businessUnitId: ids.businessUnit,
        name: "Transition Replay Guard",
        phone: "0175550192",
        source: "website",
      },
      "lead-transition-replay-source-001",
      randomUUID(),
    );
    const key = "lead-transition-replay-001";
    const input = {
      businessUnitId: ids.businessUnit,
      version: created.lead.version,
      stage: "assigned",
      ownerMembershipId: ids.membership,
    };

    const committed = await transitionLeadRecord(
      viewer,
      created.lead.id,
      input,
      randomUUID(),
      key,
    );
    const replayed = await transitionLeadRecord(
      viewer,
      created.lead.id,
      input,
      randomUUID(),
      key,
    );

    expect(committed).toMatchObject({ changed: true, replayed: false });
    expect(replayed).toEqual({ ...committed, replayed: true });
    const [evidence] = await sql<{ history: string; outbox: string }[]>`
      select
        (select count(*) from lead_stage_history where lead_id = ${created.lead.id})::text as history,
        (select count(*) from outbox_events where aggregate_id = ${created.lead.id}
          and event_type = 'crm.lead.stage_changed')::text as outbox
    `;
    expect(evidence).toEqual({ history: "2", outbox: "1" });

    await expect(
      transitionLeadRecord(
        viewer,
        created.lead.id,
        { ...input, ownerMembershipId: ids.assigneeMembership },
        randomUUID(),
        key,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH", status: 409 });
    await expect(
      transitionLeadRecord(
        viewer,
        created.lead.id,
        input,
        randomUUID(),
        "lead-transition-new-key-stale-version",
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });
});
