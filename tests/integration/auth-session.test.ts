import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabaseConnection } from "@/server/db/client";
import { resetRuntimeConfigForTests } from "@/server/env";
import { establishOidcSession } from "@/server/auth/session";
import { getViewer } from "@/server/auth/viewer";
import { GET as oidcCallback } from "@/app/api/v1/auth/oidc/callback/route";

interface WrittenCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

const cookieValues = new Map<string, string>();
const writtenCookies: WrittenCookie[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieValues.set(name, value);
      writtenCookies.push({ name, value, options });
    },
    delete: (name: string) => cookieValues.delete(name),
  }),
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for auth integration tests.");

const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^crm_salam_(test|codex)_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Auth integration tests require an isolated CRM test database.");
}

const hashKey = "auth-integration-hash-key-at-least-32-characters";
const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const ids = {
  organization: randomUUID(),
  businessUnit: randomUUID(),
  activeUser: randomUUID(),
  activeMembership: randomUUID(),
  organizationMembership: randomUUID(),
  suspendedUser: randomUUID(),
  suspendedMembership: randomUUID(),
  serviceUser: randomUUID(),
  serviceMembership: randomUUID(),
  leadUpdaterRole: randomUUID(),
};
const activeSubject = "https://identity.example.test#active-agent";
const suspendedSubject = "https://identity.example.test#suspended-agent";

beforeAll(async () => {
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: hashKey,
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "crm-auth-integration",
    OIDC_CLIENT_SECRET: "auth-integration-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();

  await sql.unsafe("drop schema if exists public cascade; create schema public");
  const migration = await readFile(resolve(process.cwd(), "db/migrations/0001_foundation.sql"), "utf8");
  await sql.begin((transaction) => transaction.unsafe(migration));

  await sql`
    insert into organizations (id, code, name)
    values (${ids.organization}, 'auth-integration', 'Auth Integration')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values (${ids.businessUnit}, ${ids.organization}, 'auth-sales', 'Auth Sales')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, user_type, status)
    values
      (${ids.activeUser}, ${activeSubject}, 'Active Agent', 'HUMAN', 'ACTIVE'),
      (${ids.suspendedUser}, ${suspendedSubject}, 'Suspended Agent', 'HUMAN', 'ACTIVE'),
      (${ids.serviceUser}, 'service:automation', 'Automation', 'SERVICE', 'ACTIVE')
  `;
  await sql`
    insert into memberships (id, organization_id, business_unit_id, user_id, status)
    values
      (${ids.activeMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.activeUser}, 'ACTIVE'),
      (${ids.organizationMembership}, ${ids.organization}, null, ${ids.activeUser}, 'ACTIVE'),
      (${ids.suspendedMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.suspendedUser}, 'SUSPENDED'),
      (${ids.serviceMembership}, ${ids.organization}, ${ids.businessUnit}, ${ids.serviceUser}, 'ACTIVE')
  `;
  await sql`
    insert into capabilities (key, description)
    values ('lead.update', 'Update leads within an explicit record scope')
  `;
  await sql`
    insert into roles (id, organization_id, key, name)
    values (${ids.leadUpdaterRole}, ${ids.organization}, 'scoped-lead-updater', 'Scoped Lead Updater')
  `;
  await sql`
    insert into role_capabilities (organization_id, role_id, capability_key, constraints)
    values (
      ${ids.organization}, ${ids.leadUpdaterRole}, 'lead.update',
      ${sql.json({ recordScope: "OWN" })}
    )
  `;
  await sql`
    insert into membership_roles (organization_id, membership_id, role_id)
    values (${ids.organization}, ${ids.activeMembership}, ${ids.leadUpdaterRole})
  `;
});

beforeEach(() => {
  cookieValues.clear();
  writtenCookies.length = 0;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("managed OIDC session establishment", () => {
  it("does not append login attempts for repeated callbacks without a transaction cookie", async () => {
    const [before] = await sql<{ count: string }[]>`
      select count(*)::text as count from auth_login_attempts
    `;

    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(
        await oidcCallback(
          new Request(
            `http://127.0.0.1:3000/api/v1/auth/oidc/callback?code=noise-${attempt}&state=noise-${attempt}`,
          ),
        ),
      );
    }

    const [after] = await sql<{ count: string }[]>`
      select count(*)::text as count from auth_login_attempts
    `;
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(responses.every((response) => response.headers.get("cache-control") === "no-store")).toBe(
      true,
    );
    expect(after?.count).toBe(before?.count);
  });

  it("denies an unknown subject without creating a user or session", async () => {
    const unknownSubject = "https://identity.example.test#unknown";
    await expect(
      establishOidcSession(unknownSubject, { correlationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "ACCESS_NOT_PROVISIONED", status: 403 });

    const [evidence] = await sql<{ unknown_users: string; sessions: string; failures: string }[]>`
      select
        (select count(*) from users where auth_subject = ${unknownSubject})::text as unknown_users,
        (select count(*) from sessions)::text as sessions,
        (select count(*) from auth_login_attempts where outcome = 'FAILURE')::text as failures
    `;
    expect(evidence).toEqual({ unknown_users: "0", sessions: "0", failures: "1" });
    expect(writtenCookies).toEqual([]);
  });

  it("denies a user whose only membership is suspended", async () => {
    await expect(
      establishOidcSession(suspendedSubject, { correlationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "ACTIVE_MEMBERSHIP_REQUIRED", status: 403 });

    const [sessions] = await sql<{ count: string }[]>`
      select count(*)::text as count from sessions where user_id = ${ids.suspendedUser}
    `;
    expect(sessions?.count).toBe("0");
  });

  it("creates one opaque database session and secure cookie contract for an active subject", async () => {
    await establishOidcSession(activeSubject, {
      correlationId: randomUUID(),
      ipAddress: "203.0.113.20",
      userAgent: "CRM integration browser",
    });

    const [session] = await sql<{
      status: string;
      organization_id: string;
      active_business_unit_id: string;
      token_hash: Uint8Array;
    }[]>`
      select status, organization_id, active_business_unit_id, token_hash
      from sessions where user_id = ${ids.activeUser}
    `;
    expect(session).toMatchObject({
      status: "ACTIVE",
      organization_id: ids.organization,
      active_business_unit_id: ids.businessUnit,
    });

    const sessionCookie = writtenCookies.find((cookie) => cookie.name === "crm_session");
    expect(sessionCookie).toMatchObject({
      options: { httpOnly: true, secure: false, sameSite: "lax", path: "/", priority: "high" },
    });
    expect(sessionCookie?.value.length).toBeGreaterThan(32);
    expect(Buffer.from(session!.token_hash)).not.toEqual(Buffer.from(sessionCookie!.value));
    const businessUnitCookie = writtenCookies.find((cookie) => cookie.name === "crm_bu");
    expect(businessUnitCookie).toMatchObject({
      value: ids.businessUnit,
      options: {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        priority: "high",
        expires: expect.any(Date),
      },
    });

    const [attempt] = await sql<{ attempted_identifier_hash: Uint8Array; outcome: string }[]>`
      select attempted_identifier_hash, outcome
      from auth_login_attempts where user_id = ${ids.activeUser}
    `;
    const expectedSubjectHash = createHmac("sha256", hashKey).update(activeSubject).digest();
    expect(attempt?.outcome).toBe("SUCCESS");
    expect(Buffer.from(attempt!.attempted_identifier_hash)).toEqual(expectedSubjectHash);
  });

  it("selects deterministic assignment provenance with business-unit preference and org fallback", async () => {
    await establishOidcSession(activeSubject, { correlationId: randomUUID() });

    expect(await getViewer()).toMatchObject({
      activeMembershipId: ids.activeMembership,
      capabilities: ["lead.update"],
      capabilityRecordScopes: { "lead.update": ["OWN"] },
    });

    await sql`
      update memberships set status = 'SUSPENDED' where id = ${ids.activeMembership}
    `;
    try {
      expect(await getViewer()).toMatchObject({
        activeMembershipId: ids.organizationMembership,
      });
    } finally {
      await sql`update memberships set status = 'ACTIVE' where id = ${ids.activeMembership}`;
    }
  });

  it("rejects an existing browser session after its user becomes a service identity", async () => {
    const token = "service-account-browser-token-that-must-be-rejected";
    await sql`
      insert into sessions (
        organization_id, active_business_unit_id, user_id, token_hash, expires_at
      ) values (
        ${ids.organization}, ${ids.businessUnit}, ${ids.serviceUser},
        ${createHash("sha256").update(token).digest()}, now() + interval '1 hour'
      )
    `;
    cookieValues.set("crm_session", token);

    expect(await getViewer()).toBeNull();
  });
});
