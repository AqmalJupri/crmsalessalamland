import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAuthorizedBusinessScope } from "@/domain/business-units/read-scope";
import { closeDatabaseConnection } from "@/server/db/client";
import { resetRuntimeConfigForTests } from "@/server/env";
import { getViewer } from "@/server/auth/viewer";

const sessionToken = "viewer-business-scope-integration-session-token";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "crm_session"
      ? { name, value: sessionToken }
      : undefined,
  }),
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for viewer business-scope integration tests.");
}

const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^crm_salam_(test|codex)_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Viewer business-scope integration tests require an isolated CRM test database.");
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const ids = {
  organization: randomUUID(),
  user: randomUUID(),
  salam: randomUUID(),
  bumi: randomUUID(),
  barakah: randomUUID(),
  salamMembership: randomUUID(),
  bumiMembership: randomUUID(),
  barakahMembership: randomUUID(),
  salamLeadReader: randomUUID(),
  bumiTaskReader: randomUUID(),
};

beforeAll(async () => {
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: "viewer-business-scope-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "crm-viewer-scope-integration",
    OIDC_CLIENT_SECRET: "viewer-scope-integration-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();

  await sql.unsafe("drop schema if exists public cascade; create schema public");
  const migration = await readFile(resolve(process.cwd(), "db/migrations/0001_foundation.sql"), "utf8");
  await sql.begin((transaction) => transaction.unsafe(migration));

  await sql`
    insert into organizations (id, code, name)
    values (${ids.organization}, 'viewer-scope', 'Viewer Scope Integration')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values
      (${ids.salam}, ${ids.organization}, 'salam-land', 'Salam Land'),
      (${ids.bumi}, ${ids.organization}, 'bumi-hayat', 'Bumi Hayat Printing'),
      (${ids.barakah}, ${ids.organization}, 'barakah-emas', 'Barakah Emas')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, user_type, status)
    values (${ids.user}, 'viewer-scope-agent', 'Viewer Scope Agent', 'HUMAN', 'ACTIVE')
  `;
  await sql`
    insert into memberships (id, organization_id, business_unit_id, user_id, status)
    values
      (${ids.salamMembership}, ${ids.organization}, ${ids.salam}, ${ids.user}, 'ACTIVE'),
      (${ids.bumiMembership}, ${ids.organization}, ${ids.bumi}, ${ids.user}, 'ACTIVE'),
      (${ids.barakahMembership}, ${ids.organization}, ${ids.barakah}, ${ids.user}, 'ACTIVE')
  `;
  await sql`
    insert into capabilities (key, description)
    values
      ('lead.read', 'Read leads'),
      ('task.read', 'Read tasks')
  `;
  await sql`
    insert into roles (id, organization_id, key, name)
    values
      (${ids.salamLeadReader}, ${ids.organization}, 'salam-lead-reader', 'Salam Lead Reader'),
      (${ids.bumiTaskReader}, ${ids.organization}, 'bumi-task-reader', 'Bumi Task Reader')
  `;
  await sql`
    insert into role_capabilities (organization_id, role_id, capability_key)
    values
      (${ids.organization}, ${ids.salamLeadReader}, 'lead.read'),
      (${ids.organization}, ${ids.bumiTaskReader}, 'task.read')
  `;
  await sql`
    insert into membership_roles (organization_id, membership_id, role_id)
    values
      (${ids.organization}, ${ids.salamMembership}, ${ids.salamLeadReader}),
      (${ids.organization}, ${ids.bumiMembership}, ${ids.bumiTaskReader})
  `;
  await sql`
    insert into sessions (
      organization_id, active_business_unit_id, user_id, token_hash, expires_at
    ) values (
      ${ids.organization}, ${ids.salam}, ${ids.user},
      ${createHash("sha256").update(sessionToken).digest()}, now() + interval '1 hour'
    )
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("viewer per-business-unit capability derivation", () => {
  it("does not project Salam lead.read authority into Bumi Hayat or Barakah Emas", async () => {
    const viewer = await getViewer();
    expect(viewer).not.toBeNull();
    if (!viewer) throw new Error("Expected an authenticated viewer.");

    const accessByCode = new Map(viewer.businessUnitAccess.map((unit) => [unit.code, unit]));
    expect(accessByCode.get("salam-land")?.capabilities).toEqual(["lead.read"]);
    expect(accessByCode.get("bumi-hayat")?.capabilities).toEqual(["task.read"]);
    expect(accessByCode.get("barakah-emas")?.capabilities).toEqual([]);
    expect(viewer.capabilities).toEqual(["lead.read"]);

    expect(resolveAuthorizedBusinessScope(viewer, "all", "crm", "lead.read"))
      .toMatchObject({ kind: "ALL", unitIds: [ids.salam] });
    expect(() => resolveAuthorizedBusinessScope(viewer, "bumi-hayat", "crm", "lead.read"))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED_SCOPE" }));
    expect(() => resolveAuthorizedBusinessScope(viewer, "barakah-emas", "crm", "lead.read"))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED_SCOPE" }));
  });
});
