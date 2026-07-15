import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests.");
}

const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^crm_salam_(test|codex)_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("TEST_DATABASE_URL must target an isolated crm_salam_test_* or crm_salam_codex_* database.");
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });

const fixture = {
  organizationA: randomUUID(),
  organizationB: randomUUID(),
  businessUnitA: randomUUID(),
  businessUnitB: randomUUID(),
  businessUnitLead: randomUUID(),
  userA: randomUUID(),
  contactA: randomUUID(),
  contactLead: randomUUID(),
  businessUnitMembership: randomUUID(),
  organizationMembership: randomUUID(),
  leadPipeline: randomUUID(),
  leadStage: randomUUID(),
  projectA: randomUUID(),
  lotA: randomUUID(),
};

async function expectSqlState(operation: () => Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await operation();
    throw new Error(`Expected PostgreSQL error ${expectedCode}.`);
  } catch (error) {
    expect(error).toMatchObject({ code: expectedCode });
  }
}

beforeAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  const migration = await readFile(resolve(process.cwd(), "db/migrations/0001_foundation.sql"), "utf8");
  await sql.begin((transaction) => transaction.unsafe(migration));

  await sql`
    insert into organizations (id, code, name)
    values
      (${fixture.organizationA}, 'salam-a', 'Salam A'),
      (${fixture.organizationB}, 'salam-b', 'Salam B')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values
      (${fixture.businessUnitA}, ${fixture.organizationA}, 'sales-a', 'Sales A'),
      (${fixture.businessUnitB}, ${fixture.organizationB}, 'sales-b', 'Sales B'),
      (${fixture.businessUnitLead}, ${fixture.organizationA}, 'lead-guards', 'Lead Guards')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, status)
    values (${fixture.userA}, 'https://identity.example.test|user-a', 'Agent A', 'ACTIVE')
  `;
  await sql`
    insert into contacts (id, organization_id, display_name)
    values
      (${fixture.contactA}, ${fixture.organizationA}, 'Customer A'),
      (${fixture.contactLead}, ${fixture.organizationA}, 'Lead Contact')
  `;
  await sql`
    insert into memberships (id, organization_id, business_unit_id, user_id, status)
    values
      (${fixture.businessUnitMembership}, ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.userA}, 'ACTIVE'),
      (${fixture.organizationMembership}, ${fixture.organizationA}, null, ${fixture.userA}, 'ACTIVE')
  `;
  await sql`
    insert into pipelines (id, organization_id, business_unit_id, entity_type, code, name)
    values (
      ${fixture.leadPipeline}, ${fixture.organizationA}, ${fixture.businessUnitLead},
      'LEAD', 'lead-guards', 'Lead Guards'
    )
  `;
  await sql`
    insert into pipeline_stages (
      id, organization_id, business_unit_id, pipeline_id, code, name, category, position
    ) values (
      ${fixture.leadStage}, ${fixture.organizationA}, ${fixture.businessUnitLead},
      ${fixture.leadPipeline}, 'new', 'New', 'OPEN', 0
    )
  `;
  await sql`
    insert into land_projects (id, organization_id, business_unit_id, code, name)
    values (${fixture.projectA}, ${fixture.organizationA}, ${fixture.businessUnitA}, 'project-a', 'Project A')
  `;
  await sql`
    insert into lots (id, organization_id, business_unit_id, project_id, lot_number)
    values (${fixture.lotA}, ${fixture.organizationA}, ${fixture.businessUnitA}, ${fixture.projectA}, 'A-001')
  `;
});

afterAll(async () => {
  await sql.end();
});

describe("production database invariants", () => {
  it("rejects a cross-tenant relationship even when both records exist", async () => {
    await expectSqlState(
      () =>
        sql`
          insert into contact_business_units (
            organization_id, business_unit_id, contact_id, purpose
          ) values (
            ${fixture.organizationA}, ${fixture.businessUnitB}, ${fixture.contactA}, 'SALES'
          )
        `,
      "23503",
    );
  });

  it("allows only one active allocation for a lot", async () => {
    await sql`
      insert into lot_allocations (
        organization_id, business_unit_id, lot_id, allocation_kind, allocated_by_user_id
      ) values (
        ${fixture.organizationA}, ${fixture.businessUnitA}, ${fixture.lotA}, 'HOLD', ${fixture.userA}
      )
    `;

    await expectSqlState(
      () =>
        sql`
          insert into lot_allocations (
            organization_id, business_unit_id, lot_id, allocation_kind, allocated_by_user_id
          ) values (
            ${fixture.organizationA}, ${fixture.businessUnitA}, ${fixture.lotA}, 'RESERVATION', ${fixture.userA}
          )
        `,
      "23505",
    );
  });

  it("allows only one active pipeline per entity type in a business unit", async () => {
    await sql`
      insert into pipelines (organization_id, business_unit_id, entity_type, code, name)
      values (${fixture.organizationA}, ${fixture.businessUnitA}, 'LEAD', 'lead-primary', 'Lead Primary')
    `;

    await expectSqlState(
      () => sql`
        insert into pipelines (organization_id, business_unit_id, entity_type, code, name)
        values (${fixture.organizationA}, ${fixture.businessUnitA}, 'LEAD', 'lead-secondary', 'Lead Secondary')
      `,
      "23505",
    );
  });

  it("increments versions in the database instead of trusting callers", async () => {
    const [before] = await sql<{ version: string }[]>`
      select version from contacts where id = ${fixture.contactA}
    `;
    const [after] = await sql<{ version: string }[]>`
      update contacts set display_name = 'Customer A Updated'
      where id = ${fixture.contactA}
      returning version
    `;

    expect(Number(before?.version)).toBe(1);
    expect(Number(after?.version)).toBe(2);
  });

  it("enforces complete lead assignment provenance and accepts an org-wide authorizer", async () => {
    await expectSqlState(
      () => sql`
        insert into leads (
          organization_id, business_unit_id, contact_id, pipeline_id, stage_id,
          owner_membership_id, title, source_provider, received_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.contactLead},
          ${fixture.leadPipeline}, ${fixture.leadStage}, ${fixture.businessUnitMembership},
          'Missing provenance', 'website', now()
        )
      `,
      "23514",
    );

    await expectSqlState(
      () => sql`
        insert into leads (
          organization_id, business_unit_id, contact_id, pipeline_id, stage_id,
          assigned_by_membership_id, assigned_at, title, source_provider, received_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.contactLead},
          ${fixture.leadPipeline}, ${fixture.leadStage}, ${fixture.organizationMembership}, now(),
          'Ownerless provenance', 'website', now()
        )
      `,
      "23514",
    );

    await expect(
      sql`
        insert into leads (
          organization_id, business_unit_id, contact_id, pipeline_id, stage_id,
          owner_membership_id, assigned_by_membership_id, assigned_at,
          title, source_provider, received_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.contactLead},
          ${fixture.leadPipeline}, ${fixture.leadStage}, ${fixture.businessUnitMembership},
          ${fixture.organizationMembership}, now(), 'Complete provenance', 'website', now()
        )
      `,
    ).resolves.toBeDefined();
  });

  it("enforces canonical provider keys at the database boundary", async () => {
    await expectSqlState(
      () => sql`
        insert into leads (
          organization_id, business_unit_id, contact_id, pipeline_id, stage_id,
          title, source_provider, received_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.contactLead},
          ${fixture.leadPipeline}, ${fixture.leadStage}, 'Unsafe provider', 'Meta', now()
        )
      `,
      "23514",
    );

    await expect(
      sql`
        insert into leads (
          organization_id, business_unit_id, contact_id, pipeline_id, stage_id,
          title, source_provider, received_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.contactLead},
          ${fixture.leadPipeline}, ${fixture.leadStage},
          'Canonical provider', 'meta.lead_ads', now()
        )
      `,
    ).resolves.toBeDefined();
  });

  it("defines the idempotency response MAC as binary data", async () => {
    const [column] = await sql<{ data_type: string; is_nullable: string }[]>`
      select data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'idempotency_keys'
        and column_name = 'response_mac'
    `;

    expect(column).toEqual({ data_type: "bytea", is_nullable: "YES" });
  });

  it("requires exactly one 32-byte response MAC only for completed idempotency rows", async () => {
    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_snapshot,
          completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:mac', ${fixture.userA}, 'lead.create',
          'completed-without-mac', ${Buffer.alloc(32, 30)}, 'COMPLETED', 201,
          '{"id":"snapshot"}'::jsonb, now(), now() + interval '1 hour'
        )
      `,
      "23514",
    );
    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_snapshot,
          response_mac, completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:mac', ${fixture.userA}, 'lead.create',
          'completed-short-mac', ${Buffer.alloc(32, 31)}, 'COMPLETED', 201,
          '{"id":"snapshot"}'::jsonb, ${Buffer.alloc(31, 31)}, now(), now() + interval '1 hour'
        )
      `,
      "23514",
    );
    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, response_mac, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:mac', ${fixture.userA}, 'lead.create',
          'in-progress-with-mac', ${Buffer.alloc(32, 32)}, ${Buffer.alloc(32, 32)},
          now() + interval '1 hour'
        )
      `,
      "23514",
    );
    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, error_code, response_mac,
          completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:mac', ${fixture.userA}, 'lead.create',
          'failed-with-mac', ${Buffer.alloc(32, 33)}, 'FAILED', 'CREATE_FAILED',
          ${Buffer.alloc(32, 33)}, now(), now() + interval '1 hour'
        )
      `,
      "23514",
    );

    await expect(
      sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_snapshot,
          response_mac, completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:mac', ${fixture.userA}, 'lead.create',
          'completed-valid-mac', ${Buffer.alloc(32, 34)}, 'COMPLETED', 201,
          '{"id":"snapshot"}'::jsonb, ${Buffer.alloc(32, 34)}, now(),
          now() + interval '1 hour'
        )
      `,
    ).resolves.toBeDefined();
  });

  it("allows only object-shaped idempotency response snapshots", async () => {
    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_snapshot,
          response_mac, completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'invalid-snapshot', ${Buffer.alloc(32, 1)}, 'COMPLETED', 201, '[]'::jsonb,
          ${Buffer.alloc(32, 1)}, now(), now() + interval '1 hour'
        )
      `,
      "23514",
    );

    await expect(
      sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_snapshot,
          response_mac, completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'object-snapshot', ${Buffer.alloc(32, 2)}, 'COMPLETED', 201,
          '{"id":"snapshot"}'::jsonb, ${Buffer.alloc(32, 2)}, now(),
          now() + interval '1 hour'
        )
      `,
    ).resolves.toBeDefined();
  });

  it("enforces idempotency status, response, and error lifecycle consistency", async () => {
    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, response_snapshot, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'in-progress-with-response', ${Buffer.alloc(32, 3)}, '{"id":"early"}'::jsonb,
          now() + interval '1 hour'
        )
      `,
      "23514",
    );

    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_mac,
          completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'completed-without-response', ${Buffer.alloc(32, 4)}, 'COMPLETED', 201,
          ${Buffer.alloc(32, 4)}, now(), now() + interval '1 hour'
        )
      `,
      "23514",
    );

    await expectSqlState(
      () => sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, error_code, response_snapshot,
          completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'failed-with-response', ${Buffer.alloc(32, 5)}, 'FAILED', 'CREATE_FAILED',
          '{"id":"unexpected"}'::jsonb, now(), now() + interval '1 hour'
        )
      `,
      "23514",
    );

    await expect(
      sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, response_code, response_snapshot,
          response_mac, completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'completed-consistent', ${Buffer.alloc(32, 6)}, 'COMPLETED', 201,
          '{"id":"snapshot"}'::jsonb, ${Buffer.alloc(32, 6)}, now(),
          now() + interval '1 hour'
        )
      `,
    ).resolves.toBeDefined();

    await expect(
      sql`
        insert into idempotency_keys (
          organization_id, actor_scope, actor_user_id, command_name,
          idempotency_key, request_hash, status, error_code, completed_at, expires_at
        ) values (
          ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
          'failed-consistent', ${Buffer.alloc(32, 7)}, 'FAILED', 'CREATE_FAILED', now(),
          now() + interval '1 hour'
        )
      `,
    ).resolves.toBeDefined();
  });

  it("freezes every idempotency acquisition-envelope field and allows monotonic expiry housekeeping", async () => {
    const id = randomUUID();
    await sql`
      insert into idempotency_keys (
        id, organization_id, actor_scope, actor_user_id, command_name,
        idempotency_key, request_hash, locked_at, expires_at
      ) values (
        ${id}, ${fixture.organizationA}, 'USER:envelope', ${fixture.userA}, 'lead.create',
        'acquisition-envelope', ${Buffer.alloc(32, 10)}, now(), now() + interval '1 hour'
      )
    `;

    const envelopeMutations = [
      () => sql`update idempotency_keys set id = ${randomUUID()} where id = ${id}`,
      () => sql`update idempotency_keys set organization_id = ${fixture.organizationB} where id = ${id}`,
      () => sql`update idempotency_keys set business_unit_id = ${fixture.businessUnitA} where id = ${id}`,
      () => sql`update idempotency_keys set actor_scope = 'USER:rewritten' where id = ${id}`,
      () => sql`update idempotency_keys set actor_user_id = null where id = ${id}`,
      () => sql`update idempotency_keys set command_name = 'lead.rewritten' where id = ${id}`,
      () => sql`update idempotency_keys set idempotency_key = 'rewritten-key' where id = ${id}`,
      () => sql`update idempotency_keys set request_hash = ${Buffer.alloc(32, 11)} where id = ${id}`,
      () => sql`update idempotency_keys set locked_at = locked_at + interval '1 second' where id = ${id}`,
      () => sql`update idempotency_keys set created_at = created_at - interval '1 second' where id = ${id}`,
    ];
    for (const mutation of envelopeMutations) {
      await expectSqlState(mutation, "55000");
    }

    await expectSqlState(
      () => sql`
        update idempotency_keys
        set expires_at = created_at + interval '1 second'
        where id = ${id}
      `,
      "55000",
    );

    const [housekeeping] = await sql<{ expires_at: Date; version: string; updated_at: Date }[]>`
      update idempotency_keys set expires_at = expires_at + interval '1 hour'
      where id = ${id}
      returning expires_at, version, updated_at
    `;
    expect(housekeeping?.expires_at).toBeInstanceOf(Date);
    expect(housekeeping?.updated_at).toBeInstanceOf(Date);
    expect(Number(housekeeping?.version)).toBe(2);
  });

  it("blocks unexpired idempotency deletion and permits expired-row purge", async () => {
    const inProgressId = randomUUID();
    const terminalId = randomUUID();
    const expiredId = randomUUID();
    await sql`
      insert into idempotency_keys (
        id, organization_id, actor_scope, actor_user_id, command_name,
        idempotency_key, request_hash, locked_at, expires_at
      ) values (
        ${inProgressId}, ${fixture.organizationA}, 'USER:delete', ${fixture.userA}, 'lead.create',
        'unexpired-in-progress', ${Buffer.alloc(32, 12)}, now(), now() + interval '1 hour'
      )
    `;
    await sql`
      insert into idempotency_keys (
        id, organization_id, actor_scope, actor_user_id, command_name,
        idempotency_key, request_hash, status, error_code, locked_at, completed_at, expires_at
      ) values (
        ${terminalId}, ${fixture.organizationA}, 'USER:delete', ${fixture.userA}, 'lead.create',
        'unexpired-failed', ${Buffer.alloc(32, 13)}, 'FAILED', 'CREATE_FAILED',
        now(), now(), now() + interval '1 hour'
      )
    `;
    await sql`
      insert into idempotency_keys (
        id, organization_id, actor_scope, actor_user_id, command_name,
        idempotency_key, request_hash, status, error_code, locked_at,
        completed_at, expires_at, created_at, updated_at
      ) values (
        ${expiredId}, ${fixture.organizationA}, 'USER:delete', ${fixture.userA}, 'lead.create',
        'expired-failed', ${Buffer.alloc(32, 14)}, 'FAILED', 'CREATE_FAILED',
        now() - interval '2 hours', now() - interval '90 minutes', now() - interval '1 hour',
        now() - interval '2 hours', now() - interval '2 hours'
      )
    `;

    await expectSqlState(
      () => sql`
        update idempotency_keys
        set expires_at = created_at + interval '1 second'
        where id = ${inProgressId}
      `,
      "55000",
    );
    await expectSqlState(
      () => sql`delete from idempotency_keys where id = ${inProgressId}`,
      "55000",
    );
    await expectSqlState(
      () => sql`delete from idempotency_keys where id = ${terminalId}`,
      "55000",
    );

    const purged = await sql<{ id: string }[]>`
      delete from idempotency_keys where id = ${expiredId} returning id
    `;
    expect(purged).toEqual([{ id: expiredId }]);
  });

  it("blocks bulk truncation of idempotency records", async () => {
    await expectSqlState(() => sql`truncate table idempotency_keys`, "55000");
  });

  it("makes terminal idempotency decisions immutable while allowing expiry housekeeping", async () => {
    const completedId = randomUUID();
    const failedId = randomUUID();
    const resultId = randomUUID();
    await sql`
      insert into idempotency_keys (
        id, organization_id, actor_scope, actor_user_id, command_name,
        idempotency_key, request_hash, status, result_entity_type, result_entity_id,
        response_code, response_snapshot, response_mac, completed_at, expires_at
      ) values (
        ${completedId}, ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
        'completed-immutable', ${Buffer.alloc(32, 20)}, 'COMPLETED', 'LEAD', ${resultId},
        201, ${sql.json({ id: resultId })}, ${Buffer.alloc(32, 20)}, now(),
        now() + interval '1 hour'
      )
    `;
    await sql`
      insert into idempotency_keys (
        id, organization_id, actor_scope, actor_user_id, command_name,
        idempotency_key, request_hash, status, error_code, completed_at, expires_at
      ) values (
        ${failedId}, ${fixture.organizationA}, 'USER:test', ${fixture.userA}, 'lead.create',
        'failed-immutable', ${Buffer.alloc(32, 21)}, 'FAILED', 'CREATE_FAILED',
        now(), now() + interval '1 hour'
      )
    `;

    const completedMutations = [
      () => sql`update idempotency_keys set request_hash = ${Buffer.alloc(32, 22)} where id = ${completedId}`,
      () => sql`update idempotency_keys set result_entity_type = 'CONTACT' where id = ${completedId}`,
      () => sql`update idempotency_keys set result_entity_id = ${randomUUID()} where id = ${completedId}`,
      () => sql`update idempotency_keys set response_code = 202 where id = ${completedId}`,
      () => sql`update idempotency_keys set response_snapshot = ${sql.json({ id: randomUUID() })} where id = ${completedId}`,
      () => sql`update idempotency_keys set response_mac = ${Buffer.alloc(32, 23)} where id = ${completedId}`,
      () => sql`update idempotency_keys set completed_at = now() + interval '1 minute' where id = ${completedId}`,
      () => sql`
        update idempotency_keys
        set status = 'FAILED', response_code = null, response_snapshot = null,
            result_entity_type = null, result_entity_id = null, error_code = 'REWRITTEN'
        where id = ${completedId}
      `,
    ];
    for (const mutation of completedMutations) {
      await expectSqlState(mutation, "55000");
    }

    await expectSqlState(
      () => sql`update idempotency_keys set error_code = 'REWRITTEN' where id = ${failedId}`,
      "55000",
    );
    await expectSqlState(
      () => sql`
        update idempotency_keys
        set status = 'IN_PROGRESS', error_code = null, completed_at = null
        where id = ${failedId}
      `,
      "55000",
    );

    const [housekeeping] = await sql<{ expires_at: Date; version: string }[]>`
      update idempotency_keys set expires_at = expires_at + interval '1 hour'
      where id = ${completedId}
      returning expires_at, version
    `;
    expect(housekeeping?.expires_at).toBeInstanceOf(Date);
    expect(Number(housekeeping?.version)).toBeGreaterThan(1);
  });

  it("blocks mutation of append-only audit evidence", async () => {
    const auditId = randomUUID();
    await sql`
      insert into audit_events (
        id, organization_id, actor_type, actor_user_id, action, target_type, target_id, outcome
      ) values (
        ${auditId}, ${fixture.organizationA}, 'USER', ${fixture.userA},
        'contact.created', 'contact', ${fixture.contactA}, 'SUCCESS'
      )
    `;

    await expectSqlState(
      () => sql`update audit_events set reason = 'rewritten' where id = ${auditId}`,
      "55000",
    );
  });

  it("requires a refund maker distinct from the checker for approved states", async () => {
    const paymentId = randomUUID();
    const checkerId = randomUUID();
    await sql`
      insert into users (id, auth_subject, display_name, status)
      values (${checkerId}, ${`https://identity.example.test|checker-${checkerId}`}, 'Refund Checker', 'ACTIVE')
    `;
    await sql`
      insert into payments (
        id, organization_id, business_unit_id, payment_number, contact_id,
        status, method, amount, settled_at
      ) values (
        ${paymentId}, ${fixture.organizationA}, ${fixture.businessUnitA},
        ${`PAY-${paymentId}`}, ${fixture.contactA}, 'SETTLED', 'BANK', 100, now()
      )
    `;

    await expectSqlState(
      () => sql`
        insert into refunds (
          organization_id, business_unit_id, payment_id, refund_number,
          status, amount, reason, requested_by_user_id, approved_by_user_id, approved_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitA}, ${paymentId},
          ${`REF-NULL-${paymentId}`}, 'APPROVED', 10, 'Approved without maker',
          null, ${checkerId}, now()
        )
      `,
      "23514",
    );
    await expectSqlState(
      () => sql`
        insert into refunds (
          organization_id, business_unit_id, payment_id, refund_number,
          status, amount, reason, requested_by_user_id, approved_by_user_id, approved_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitA}, ${paymentId},
          ${`REF-SAME-${paymentId}`}, 'APPROVED', 10, 'Maker equals checker',
          ${checkerId}, ${checkerId}, now()
        )
      `,
      "23514",
    );
    await expect(
      sql`
        insert into refunds (
          organization_id, business_unit_id, payment_id, refund_number,
          status, amount, reason, requested_by_user_id, approved_by_user_id, approved_at
        ) values (
          ${fixture.organizationA}, ${fixture.businessUnitA}, ${paymentId},
          ${`REF-VALID-${paymentId}`}, 'APPROVED', 10, 'Valid maker checker pair',
          ${fixture.userA}, ${checkerId}, now()
        )
      `,
    ).resolves.toBeDefined();
  });

  it("blocks lead-history rewrites and audit deletion or truncation", async () => {
    const leadId = randomUUID();
    const historyId = randomUUID();
    const auditId = randomUUID();
    await sql`
      insert into leads (
        id, organization_id, business_unit_id, contact_id, pipeline_id, stage_id,
        title, source_provider, received_at
      ) values (
        ${leadId}, ${fixture.organizationA}, ${fixture.businessUnitLead}, ${fixture.contactLead},
        ${fixture.leadPipeline}, ${fixture.leadStage}, 'History guard', 'website', now()
      )
    `;
    await sql`
      insert into lead_stage_history (
        id, organization_id, business_unit_id, lead_id, to_stage_id, transition_source
      ) values (
        ${historyId}, ${fixture.organizationA}, ${fixture.businessUnitLead},
        ${leadId}, ${fixture.leadStage}, 'TEST'
      )
    `;
    await sql`
      insert into audit_events (
        id, organization_id, actor_type, actor_user_id, action, target_type, target_id, outcome
      ) values (
        ${auditId}, ${fixture.organizationA}, 'USER', ${fixture.userA},
        'lead.created', 'lead', ${leadId}, 'SUCCESS'
      )
    `;

    await expectSqlState(
      () => sql`update lead_stage_history set reason = 'rewritten' where id = ${historyId}`,
      "55000",
    );
    await expectSqlState(
      () => sql`delete from lead_stage_history where id = ${historyId}`,
      "55000",
    );
    await expectSqlState(() => sql`truncate table lead_stage_history`, "55000");
    await expectSqlState(() => sql`delete from audit_events where id = ${auditId}`, "55000");
    await expectSqlState(() => sql`truncate table audit_events`, "55000");
  });
});
