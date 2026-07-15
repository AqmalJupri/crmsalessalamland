import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";
import { runMigrations } from "@/server/db/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for migration tests.");

const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/^crm_salam_(test|codex)_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Migration integration tests require an isolated CRM test database.");
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });

beforeAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
});

afterAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
});

describe("production migration runner", () => {
  it("applies once, no-ops on replay, and rejects a changed ledger checksum", async () => {
    await runMigrations(databaseUrl);
    const firstLedger = await sql<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations order by filename
    `;
    expect(firstLedger).toEqual(EXPECTED_MIGRATIONS.map((migration) => ({ ...migration })));

    await runMigrations(databaseUrl);
    const countRows = await sql<{ count: string }[]>`
      select count(*)::text as count from schema_migrations
    `;
    expect(countRows[0]?.count).toBe(String(EXPECTED_MIGRATIONS.length));

    await sql`update schema_migrations set checksum = ${"0".repeat(64)}`;
    await expect(runMigrations(databaseUrl)).rejects.toThrow(/has changed/i);
  });
});
