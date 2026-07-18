import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@/server/db/migrate";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";
import { runMigrationCli } from "@/server/migration/cli";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for migration CLI tests.");

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Migration CLI tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}
const shadowedDatabaseUrl = new URL(databaseUrl);
shadowedDatabaseUrl.searchParams.set(
  "options",
  "-csearch_path=migration_cli_spoof,public",
);
const shadowedConnectionUrl = shadowedDatabaseUrl.toString();

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const ids = {
  organization: "91000000-0000-4000-8000-000000000001",
  businessUnit: "92000000-0000-4000-8000-000000000001",
  user: "93000000-0000-4000-8000-000000000001",
  membership: "94000000-0000-4000-8000-000000000001",
  source: "95000000-0000-4000-8000-000000000001",
  transform: "96000000-0000-4000-8000-000000000001",
  batch: "97000000-0000-4000-8000-000000000001",
} as const;
const digest = Buffer.alloc(32, 0x51);

beforeAll(async () => {
  await sql.unsafe("drop schema if exists migration_cli_spoof cascade");
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql.unsafe(`
    create schema migration_cli_spoof;
    create table migration_cli_spoof.schema_migrations (
      filename text primary key,
      checksum text not null
    );
    create table migration_cli_spoof.migration_sources (
      id uuid primary key,
      status text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table migration_cli_spoof.import_batches (
      id uuid primary key,
      migration_source_id uuid not null,
      status text not null,
      total_row_count bigint not null,
      staged_row_count bigint not null,
      valid_row_count bigint not null,
      rejected_row_count bigint not null,
      quarantined_row_count bigint not null,
      hidden_row_count bigint not null,
      approved_row_count bigint not null,
      imported_row_count bigint not null,
      no_op_row_count bigint not null,
      failure_code text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  for (const migration of EXPECTED_MIGRATIONS) {
    await sql`
      insert into migration_cli_spoof.schema_migrations (filename, checksum)
      values (${migration.filename}, ${migration.checksum})
    `;
  }
  await sql`
    insert into organizations (id, code, name)
    values (${ids.organization}, 'synthetic-cli-org', 'Synthetic CLI Organisation')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values (${ids.businessUnit}, ${ids.organization}, 'synthetic-cli-bu', 'Synthetic CLI Unit')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, status)
    values (${ids.user}, 'synthetic-cli-user', 'Synthetic CLI User', 'ACTIVE')
  `;
  await sql`
    insert into memberships (id, organization_id, business_unit_id, user_id, status)
    values (${ids.membership}, ${ids.organization}, ${ids.businessUnit}, ${ids.user}, 'ACTIVE')
  `;
  await sql`
    insert into migration_sources (
      id, organization_id, business_unit_id, source_key, source_kind, source_mode,
      owner_membership_id, status
    ) values (
      ${ids.source}, ${ids.organization}, ${ids.businessUnit}, 'synthetic-cli-source',
      'NIAGAWAN_CSV', 'ONE_TIME_MIGRATION', ${ids.membership}, 'ACTIVE'
    )
  `;
  await sql`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale
    ) values (
      ${ids.transform}, ${ids.organization}, ${ids.businessUnit}, ${ids.source}, 1,
      'synthetic.v1', 'protected://synthetic-cli/mapping', ${digest},
      'protected://synthetic-cli/release', ${digest}, ${digest},
      'Synthetic CLI integration fixture'
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, failure_code
    ) values (
      ${ids.batch}, ${ids.organization}, ${ids.businessUnit}, ${ids.source}, ${ids.transform},
      'protected://synthetic-cli/do-not-print', ${digest}, 0,
      '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
      'synthetic.v1', 'FAILED', true, 'CUSTOMER_PHONE_60123456789'
    )
  `;
});

afterAll(async () => {
  await sql.unsafe("drop schema if exists migration_cli_spoof cascade");
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
});

describe("migration CLI", () => {
  it("reports the intentional missing-DATABASE_URL error through the package command", () => {
    const environment = { ...process.env };
    delete environment.DATABASE_URL;

    const result = spawnSync("pnpm", ["db:migrate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL is required to run migrations.");
    expect(output).not.toMatch(/TransformError|Top-level await/i);
  });

  it("reads an attested ledger in a bounded transaction without mutating or leaking", async () => {
    const shadowProbe = postgres(shadowedConnectionUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      const [searchPath] = await shadowProbe<{ search_path: string }[]>`
        select pg_catalog.current_setting('search_path') as search_path
      `;
      expect(searchPath?.search_path).toBe("migration_cli_spoof,public");
    } finally {
      await shadowProbe.end();
    }
    const [before] = await sql<{
      sources: string;
      batches: string;
      protected_ref: string;
      failure_code: string;
      batch_version: string;
    }[]>`
      select
        (select count(*)::text from migration_sources) as sources,
        (select count(*)::text from import_batches) as batches,
        protected_artifact_ref as protected_ref,
        failure_code,
        version::text as batch_version
      from import_batches
      where id = ${ids.batch}
    `;
    const ledgerBefore = await sql<{
      filename: string;
      checksum: string;
      applied_at: Date;
    }[]>`
      select filename, checksum, applied_at
      from schema_migrations
      order by filename collate "C"
    `;
    expect(before).toBeDefined();

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runMigrationCli({
      args: ["status"],
      environment: {
        DEPLOYMENT_ENVIRONMENT: "ci",
        NODE_ENV: "test",
        DATABASE_URL: shadowedConnectionUrl,
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const rendered = stdout[0] ?? "";
    const output = JSON.parse(rendered) as {
      state: string;
      counts: { sources: string; batches: string };
      sources: readonly { sourceId: string; state: string }[];
      batches: readonly {
        batchId: string;
        sourceId: string;
        state: string;
        counts: Record<string, string>;
        reasonCodes: readonly string[];
        correlationId: string;
      }[];
    };
    expect(Object.keys(output).sort()).toEqual([
      "batches",
      "counts",
      "sources",
      "state",
      "timestamp",
    ]);
    expect(output.state).toBe("READY");
    expect(output.counts).toMatchObject({
      sources: before!.sources,
      batches: before!.batches,
    });
    expect(output.sources).toContainEqual(
      expect.objectContaining({ sourceId: ids.source, state: "ACTIVE" }),
    );
    expect(output.batches).toContainEqual(
      expect.objectContaining({
        batchId: ids.batch,
        sourceId: ids.source,
        state: "FAILED",
        reasonCodes: ["UNSAFE_REASON_CODE_REDACTED"],
        correlationId: ids.batch,
      }),
    );
    for (const batch of output.batches) {
      expect(Object.values(batch.counts).every((count) => /^\d+$/.test(count))).toBe(true);
    }
    expect(rendered).not.toContain(databaseUrl);
    expect(rendered).not.toContain(before!.protected_ref);
    expect(rendered).not.toContain(before!.failure_code);
    expect(rendered).not.toMatch(/postgresql:|password|secret|email|phone|payment/i);

    const [after] = await sql<{
      protected_ref: string;
      failure_code: string;
      batch_version: string;
    }[]>`
      select protected_artifact_ref as protected_ref, failure_code, version::text as batch_version
      from import_batches
      where id = ${ids.batch}
    `;
    const ledgerAfter = await sql<{
      filename: string;
      checksum: string;
      applied_at: Date;
    }[]>`
      select filename, checksum, applied_at
      from schema_migrations
      order by filename collate "C"
    `;
    expect(after).toEqual({
      protected_ref: before!.protected_ref,
      failure_code: before!.failure_code,
      batch_version: before!.batch_version,
    });
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  it("fails closed with one safe code when the database ledger is not exact", async () => {
    const reviewed = EXPECTED_MIGRATIONS[0];
    expect(reviewed).toBeDefined();
    await sql`
      update schema_migrations
      set checksum = ${"0".repeat(64)}
      where filename = ${reviewed!.filename}
    `;

    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runMigrationCli({
        args: ["status"],
        environment: {
          DEPLOYMENT_ENVIRONMENT: "ci",
          NODE_ENV: "test",
          DATABASE_URL: shadowedConnectionUrl,
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        JSON.stringify({
          state: "DENIED",
          reasonCodes: ["MIGRATION_LEDGER_MISMATCH"],
        }),
      ]);
      expect(stderr.join("")).not.toMatch(/schema_migrations|checksum|postgresql:/i);
    } finally {
      await sql`
        update schema_migrations
        set checksum = ${reviewed!.checksum}
        where filename = ${reviewed!.filename}
      `;
    }

    const [restored] = await sql<{ checksum: string }[]>`
      select checksum from schema_migrations where filename = ${reviewed!.filename}
    `;
    expect(restored?.checksum).toBe(reviewed!.checksum);
  });
});
