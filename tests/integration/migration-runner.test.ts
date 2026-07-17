import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for migration tests.");

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(`Migration tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`);
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);

interface ReviewedFixture {
  filename: string;
  checksum: string;
  byteLength: number;
}

function reviewedFixture(filename: string, source: string | Buffer): ReviewedFixture {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
  return {
    filename,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

async function createMigrationDirectory(
  files: readonly { filename: string; source: string | Buffer }[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crm-reviewed-migrations-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    files.map(({ filename, source }) => writeFile(join(directory, filename), source, "utf8")),
  );
  return directory;
}

async function loadProductionModules() {
  vi.resetModules();
  vi.doUnmock("@/server/db/migration-manifest");
  const [manifest, runner] = await Promise.all([
    import("@/server/db/migration-manifest"),
    import("@/server/db/migrate"),
  ]);
  return { manifest, runner };
}

async function loadRunnerWithManifest(reviewed: readonly ReviewedFixture[]) {
  vi.resetModules();
  vi.doMock("@/server/db/migration-manifest", () => ({
    EXPECTED_MIGRATIONS: reviewed,
    validateMigrationDirectoryEntries(entries: readonly string[]) {
      const actual = entries.filter((entry) => entry.endsWith(".sql")).sort();
      const expected = reviewed.map(({ filename }) => filename);
      if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
        throw new Error("Migration directory does not match the reviewed migration manifest.");
      }
      return expected;
    },
    assertMigrationSource(filename: string, source: string) {
      const entry = reviewed.find((migration) => migration.filename === filename);
      if (!entry) throw new Error(`Migration ${filename} is absent from the reviewed manifest.`);
      const checksum = createHash("sha256").update(source).digest("hex");
      if (checksum !== entry.checksum) {
        throw new Error(`Migration ${filename} checksum differs from the reviewed manifest.`);
      }
      return checksum;
    },
  }));
  return import("@/server/db/migrate");
}

beforeEach(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
});

afterEach(async () => {
  vi.doUnmock("@/server/db/migration-manifest");
  vi.doUnmock("postgres");
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
});

describe("production migration runner", () => {
  it("applies the reviewed set once and preserves the ledger on exact replay", async () => {
    const { manifest, runner } = await loadProductionModules();
    await runner.runMigrations(databaseUrl);
    const firstLedger = await sql<{
      filename: string;
      checksum: string;
      applied_at: Date;
    }[]>`
      select filename, checksum, applied_at from schema_migrations order by filename
    `;
    expect(firstLedger.map(({ filename, checksum }) => ({ filename, checksum }))).toEqual(
      manifest.EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({ filename, checksum })),
    );

    await runner.runMigrations(databaseUrl);
    const replayedLedger = await sql<{
      filename: string;
      checksum: string;
      applied_at: Date;
    }[]>`
      select filename, checksum, applied_at from schema_migrations order by filename
    `;
    expect(replayedLedger).toEqual(firstLedger);
  });

  it("serializes concurrent runners into one exact reviewed ledger", async () => {
    const { manifest, runner } = await loadProductionModules();
    await Promise.all([
      runner.runMigrations(databaseUrl),
      runner.runMigrations(databaseUrl),
    ]);
    const ledger = await sql<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations order by filename
    `;
    expect(ledger).toEqual(
      manifest.EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({ filename, checksum })),
    );
  });

  it("rejects changed or non-prefix ledger history", async () => {
    const { manifest, runner } = await loadProductionModules();
    await runner.runMigrations(databaseUrl);
    await sql`
      update schema_migrations set checksum = ${"0".repeat(64)}
      where filename = ${manifest.EXPECTED_MIGRATIONS[0]!.filename}
    `;
    await expect(runner.runMigrations(databaseUrl)).rejects.toThrow(/changed|prefix/i);

    await sql.unsafe("drop schema if exists public cascade; create schema public");
    await sql`
      create table schema_migrations (
        filename text primary key,
        checksum char(64) not null,
        applied_at timestamptz not null default now()
      )
    `;
    const last = manifest.EXPECTED_MIGRATIONS.at(-1)!;
    await sql`
      insert into schema_migrations (filename, checksum) values (${last.filename}, ${last.checksum})
    `;
    await expect(runner.runMigrations(databaseUrl)).rejects.toThrow(/prefix/i);
    const rows = await sql<{ filename: string }[]>`
      select filename from schema_migrations order by filename
    `;
    expect(rows).toEqual([{ filename: last.filename }]);
  });

  it("rolls back a manifest-verified migration and its ledger row atomically", async () => {
    const firstSource = "create table synthetic_first_marker (id integer primary key);\n";
    const secondSource = [
      "create table synthetic_second_marker (id integer primary key);",
      "do $$ begin raise exception 'synthetic migration failure'; end $$;",
      "",
    ].join("\n");
    const reviewed = [
      reviewedFixture("0001_synthetic_first.sql", firstSource),
      reviewedFixture("0002_synthetic_failure.sql", secondSource),
    ];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source: firstSource },
      { filename: reviewed[1]!.filename, source: secondSource },
    ]);
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(
      /synthetic migration failure/i,
    );
    const [firstTable] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.synthetic_first_marker') is not null as exists
    `;
    expect(firstTable?.exists).toBe(true);
    const firstLedger = await sql<{ count: string }[]>`
      select count(*)::text as count
      from schema_migrations
      where filename = ${reviewed[0]!.filename}
    `;
    expect(firstLedger[0]?.count).toBe("1");
    const [secondTable] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.synthetic_second_marker') is not null as exists
    `;
    expect(secondTable?.exists).toBe(false);
    const secondLedger = await sql<{ count: string }[]>`
      select count(*)::text as count
      from schema_migrations
      where filename = ${reviewed[1]!.filename}
    `;
    expect(secondLedger[0]?.count).toBe("0");
  });

  it("verifies every reviewed file before the first database mutation", async () => {
    const firstSource = "create table synthetic_prevalidation_marker (id integer primary key);\n";
    const reviewedSecondSource = "select 2;\n";
    const changedSecondSource = "select 3;\n";
    const reviewed = [
      reviewedFixture("0001_synthetic_first.sql", firstSource),
      reviewedFixture("0002_synthetic_second.sql", reviewedSecondSource),
    ];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source: firstSource },
      { filename: reviewed[1]!.filename, source: changedSecondSource },
    ]);
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(/checksum/i);
    const [firstTable] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.synthetic_prevalidation_marker') is not null as exists
    `;
    expect(firstTable?.exists).toBe(false);
    const [ledger] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.schema_migrations') is not null as exists
    `;
    expect(ledger?.exists).toBe(false);
  });

  it("rejects a byte-length mismatch during whole-directory prevalidation", async () => {
    const source = "create table synthetic_length_marker (id integer primary key);\n";
    const entry = reviewedFixture("0001_synthetic_length.sql", source);
    const reviewed = [{ ...entry, byteLength: entry.byteLength + 1 }];
    const directory = await createMigrationDirectory([{ filename: entry.filename, source }]);
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(/byte length/i);
    const [marker] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.synthetic_length_marker') is not null as exists
    `;
    expect(marker?.exists).toBe(false);
    const [ledger] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.schema_migrations') is not null as exists
    `;
    expect(ledger?.exists).toBe(false);
  });

  it("pins migration locking, ledger reads, and apply transactions to one reserved session", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_reserved_session.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("").includes("pg_advisory_unlock") ? [{ unlocked: true }] : []), {
      unsafe: vi.fn(async (statement: string) => {
        void statement;
        return [];
      }),
      release: vi.fn(),
    });
    const directPoolQuery = vi.fn(async () => {
      throw new Error("direct pool query used");
    });
    const pool = Object.assign(directPoolQuery, {
      unsafe: directPoolQuery,
      begin: directPoolQuery,
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool) }));
    const runner = await loadRunnerWithManifest(reviewed);

    await runner.runMigrations(databaseUrl, directory);

    expect(pool.reserve).toHaveBeenCalledOnce();
    expect(directPoolQuery).not.toHaveBeenCalled();
    expect(reserved.unsafe.mock.calls.map(([statement]) => statement)).toEqual(
      expect.arrayContaining(["begin", source, "commit"]),
    );
    expect(reserved.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("releases the reserved session and closes the pool after a reserved-session failure", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_reserved_failure.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    const connectionFailure = new Error("reserved connection closed");
    let notifyConnectionClosed: (() => void) | undefined;
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
      void strings;
      return [];
    }), {
      unsafe: vi.fn(async () => {
        notifyConnectionClosed?.();
        throw connectionFailure;
      }),
      begin: vi.fn(),
      release: vi.fn(),
    });
    const directPoolQuery = vi.fn();
    const pool = Object.assign(directPoolQuery, {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    vi.doMock("postgres", () => ({
      default: vi.fn((_connectionUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        notifyConnectionClosed = () => options.onclose?.(1);
        return pool;
      }),
    }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(
      /reserved connection closed/i,
    );
    expect(reserved.release).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("does not touch the reserved handle when setup rejects before delayed onclose", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_setup_rejects_first.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    const setupFailure = Object.assign(new Error("setup socket failed before close callback"), {
      code: "ECONNRESET",
    });
    let notifyConnectionClosed: (() => void) | undefined;
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
      void strings;
      return [];
    }), {
      unsafe: vi.fn(async () => {
        throw setupFailure;
      }),
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => {
        await Promise.resolve();
        notifyConnectionClosed?.();
      }),
    });
    vi.doMock("postgres", () => ({
      default: vi.fn((_connectionUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        notifyConnectionClosed = () => options.onclose?.(1);
        return pool;
      }),
    }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toBe(setupFailure);
    expect(
      reserved.mock.calls.some(([strings]) => strings.join("").includes("pg_advisory_unlock")),
    ).toBe(false);
    expect(reserved.release).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it("fails closed when the reserved session closes after commit but before release", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_close_after_commit.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    let notifyConnectionClosed: (() => void) | undefined;
    const reservedUnsafe = vi.fn(async (statement: string) => {
      if (statement === "commit") notifyConnectionClosed?.();
      return [];
    });
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
      void strings;
      return [];
    }), {
      unsafe: reservedUnsafe,
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    vi.doMock("postgres", () => ({
      default: vi.fn((_connectionUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        notifyConnectionClosed = () => options.onclose?.(1);
        return pool;
      }),
    }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(
      /reserved migration session closed/i,
    );
    expect(reserved.release).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("preserves a rejected COMMIT and never submits rollback after session close", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_lost_commit_response.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    const commitFailure = new Error("commit response lost with reserved session");
    let notifyConnectionClosed: (() => void) | undefined;
    const reservedUnsafe = vi.fn(async (statement: string) => {
      if (statement === "commit") {
        notifyConnectionClosed?.();
        throw commitFailure;
      }
      return [];
    });
    const reserved = Object.assign(vi.fn(async () => []), {
      unsafe: reservedUnsafe,
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    vi.doMock("postgres", () => ({
      default: vi.fn((_connectionUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        notifyConnectionClosed = () => options.onclose?.(1);
        return pool;
      }),
    }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toBe(commitFailure);
    expect(reservedUnsafe.mock.calls.map(([statement]) => statement)).not.toContain("rollback");
    expect(reserved.release).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("does not touch the reserved handle when COMMIT rejects before delayed onclose", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_commit_rejects_first.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    const commitFailure = Object.assign(new Error("commit socket failed before close callback"), {
      code: "CONNECTION_CLOSED",
    });
    let notifyConnectionClosed: (() => void) | undefined;
    const reservedUnsafe = vi.fn(async (statement: string) => {
      if (statement === "commit") throw commitFailure;
      return [];
    });
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
      void strings;
      return [];
    }), {
      unsafe: reservedUnsafe,
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => {
        await Promise.resolve();
        notifyConnectionClosed?.();
      }),
    });
    vi.doMock("postgres", () => ({
      default: vi.fn((_connectionUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        notifyConnectionClosed = () => options.onclose?.(1);
        return pool;
      }),
    }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toBe(commitFailure);
    expect(reservedUnsafe.mock.calls.map(([statement]) => statement)).not.toContain("rollback");
    expect(
      reserved.mock.calls.some(([strings]) => strings.join("").includes("pg_advisory_unlock")),
    ).toBe(false);
    expect(reserved.release).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it("fails closed when the reserved session closes during advisory unlock", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_close_during_unlock.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    let notifyConnectionClosed: (() => void) | undefined;
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("pg_advisory_unlock")) {
        notifyConnectionClosed?.();
        return [{ unlocked: true }];
      }
      return [];
    }), {
      unsafe: vi.fn(async () => []),
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    vi.doMock("postgres", () => ({
      default: vi.fn((_connectionUrl: string, options: { onclose?: (connectionId: number) => void }) => {
        notifyConnectionClosed = () => options.onclose?.(1);
        return pool;
      }),
    }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(
      /reserved migration session closed/i,
    );
    expect(reserved.release).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("fails closed when the reserved session no longer owns the advisory lock", async () => {
    const source = "select 1;\n";
    const reviewed = [reviewedFixture("0001_lock_ownership.sql", source)];
    const directory = await createMigrationDirectory([
      { filename: reviewed[0]!.filename, source },
    ]);
    const reserved = Object.assign(vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("").includes("pg_advisory_unlock") ? [{ unlocked: false }] : []), {
      unsafe: vi.fn(async () => []),
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool) }));
    const runner = await loadRunnerWithManifest(reviewed);

    await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(/lock ownership/i);
    expect(reserved.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rejects symlinked and non-regular migration entries", async () => {
    const source = "select 1;\n";
    const symlinkEntry = reviewedFixture("0001_symlink.sql", source);
    const symlinkDirectory = await createMigrationDirectory([
      { filename: "reviewed-target.txt", source },
    ]);
    await symlink("reviewed-target.txt", join(symlinkDirectory, symlinkEntry.filename));
    const symlinkRunner = await loadRunnerWithManifest([symlinkEntry]);
    await expect(symlinkRunner.runMigrations(databaseUrl, symlinkDirectory)).rejects.toThrow(
      /regular repository file/i,
    );

    const directoryEntry = reviewedFixture("0001_directory.sql", source);
    const directory = await createMigrationDirectory([]);
    await mkdir(join(directory, directoryEntry.filename));
    const directoryRunner = await loadRunnerWithManifest([directoryEntry]);
    await expect(directoryRunner.runMigrations(databaseUrl, directory)).rejects.toThrow(
      /regular repository file/i,
    );
  });

  it("rejects a FIFO migration entry without waiting for a writer", async () => {
    if (process.platform === "win32") return;

    const source = "select 1;\n";
    const entry = reviewedFixture("0001_fifo.sql", source);
    const directory = await createMigrationDirectory([]);
    const fifoPath = join(directory, entry.filename);
    await execFile("mkfifo", [fifoPath]);
    const runner = await loadRunnerWithManifest([entry]);
    let fallbackWriter: Promise<void> | undefined;
    const fallback = setTimeout(() => {
      fallbackWriter = writeFile(fifoPath, source).catch(() => undefined);
    }, 1_000);

    try {
      await expect(runner.runMigrations(databaseUrl, directory)).rejects.toThrow(
        /regular repository file/i,
      );
    } finally {
      clearTimeout(fallback);
      await fallbackWriter;
    }
    expect(fallbackWriter, "FIFO open waited for a writer").toBeUndefined();
  });

  it("rejects reviewed bytes that are not canonical UTF-8 SQL", async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
    const invalidEntry = reviewedFixture("0001_invalid_utf8.sql", invalidUtf8);
    const invalidDirectory = await createMigrationDirectory([
      { filename: invalidEntry.filename, source: invalidUtf8 },
    ]);
    const invalidRunner = await loadRunnerWithManifest([invalidEntry]);
    await expect(invalidRunner.runMigrations(databaseUrl, invalidDirectory)).rejects.toThrow();

    const bomSource = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("select 1;\n")]);
    const bomEntry = reviewedFixture("0001_bom.sql", bomSource);
    const bomDirectory = await createMigrationDirectory([
      { filename: bomEntry.filename, source: bomSource },
    ]);
    const bomRunner = await loadRunnerWithManifest([bomEntry]);
    await expect(bomRunner.runMigrations(databaseUrl, bomDirectory)).rejects.toThrow(/bom/i);
  });
});
