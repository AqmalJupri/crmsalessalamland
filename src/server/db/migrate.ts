import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres, { type ReservedSql } from "postgres";
import {
  EXPECTED_MIGRATIONS,
  validateMigrationDirectoryEntries,
} from "./migration-manifest";

const reviewedMigrationBrand: unique symbol = Symbol("ReviewedMigration");

interface ReviewedMigration {
  readonly [reviewedMigrationBrand]: true;
  readonly filename: string;
  readonly checksum: string;
  readonly byteLength: number;
  readonly bytes: Buffer;
  readonly source: string;
}

async function streamReviewedMigration(
  migrationsDirectory: string,
  expected: (typeof EXPECTED_MIGRATIONS)[number],
): Promise<ReviewedMigration> {
  // Snapshot the frozen manifest entry before the first asynchronous boundary.
  const filename = expected.filename;
  const expectedChecksum = expected.checksum;
  const expectedByteLength = expected.byteLength;
  const migrationPath = resolve(migrationsDirectory, filename);
  let migrationFile: FileHandle | undefined;

  try {
    try {
      migrationFile = await open(
        migrationPath,
        fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
      );
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ELOOP" || code === "EMLINK") {
        throw new Error(`Migration ${filename} must be a regular repository file.`);
      }
      throw error;
    }

    const initialMetadata = await migrationFile.stat();
    if (!initialMetadata.isFile()) {
      throw new Error(`Migration ${filename} must be a regular repository file.`);
    }
    if (initialMetadata.size !== expectedByteLength) {
      throw new Error(`Migration ${filename} byte length differs from the reviewed manifest.`);
    }

    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of migrationFile.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > expectedByteLength) {
        throw new Error(`Migration ${filename} byte length differs from the reviewed manifest.`);
      }
      hash.update(bytes);
      chunks.push(bytes);
    }

    if (byteLength !== expectedByteLength) {
      throw new Error(`Migration ${filename} byte length differs from the reviewed manifest.`);
    }

    const checksum = hash.digest("hex");
    if (checksum !== expectedChecksum) {
      throw new Error(`Migration ${filename} checksum differs from the reviewed manifest.`);
    }

    const bytes = Buffer.concat(chunks, byteLength);
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      throw new Error(`Migration ${filename} must not contain a UTF-8 BOM.`);
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(source, "utf8").equals(bytes)) {
      throw new Error(`Migration ${filename} must use canonical UTF-8 bytes.`);
    }
    return Object.freeze({
      [reviewedMigrationBrand]: true as const,
      filename,
      checksum,
      byteLength,
      bytes,
      source,
    });
  } finally {
    await migrationFile?.close();
  }
}

async function loadReviewedMigrationSet(
  migrationsDirectory: string,
): Promise<readonly ReviewedMigration[]> {
  const filenames = validateMigrationDirectoryEntries(await readdir(migrationsDirectory));
  const reviewed: ReviewedMigration[] = [];

  for (const [index, filename] of filenames.entries()) {
    const expected = EXPECTED_MIGRATIONS[index];
    if (!expected || expected.filename !== filename) {
      throw new Error("Migration directory order differs from the reviewed manifest.");
    }
    reviewed.push(await streamReviewedMigration(migrationsDirectory, expected));
  }

  return Object.freeze(reviewed);
}

async function applyReviewedMigration(
  transaction: ReservedSql,
  migration: ReviewedMigration,
): Promise<void> {
  if (migration[reviewedMigrationBrand] !== true) {
    throw new Error("Only reviewed migration values may be applied.");
  }

  await transaction.unsafe(migration.source);
  await transaction`
    insert into schema_migrations (filename, checksum)
    values (${migration.filename}, ${migration.checksum})
  `;
}

async function applyReviewedMigrationAtomically(
  session: ReservedSql,
  migration: ReviewedMigration,
  markSessionUnusable: () => void,
): Promise<void> {
  // postgres.js types advertise ReservedSql.begin(), but the runtime reserved
  // client exposes only the pinned query surface. Explicit transaction control
  // keeps both SQL bytes and the ledger insert on that same reserved session.
  try {
    await session.unsafe("begin");
    await applyReviewedMigration(session, migration);
    await session.unsafe("commit");
  } catch (error: unknown) {
    // A rejected query can arrive before postgres.js emits onclose. Never send
    // follow-up SQL through a reserved handle whose transaction outcome is no
    // longer trustworthy; ending this runner-owned pool rolls it back server-side.
    markSessionUnusable();
    throw error;
  }
}

export async function runMigrations(
  connectionUrl: string,
  migrationsDirectory = resolve(process.cwd(), "db/migrations"),
): Promise<void> {
  // Verify and retain every byte before opening a database connection. A later
  // directory change cannot alter the exact values applied in this invocation.
  const reviewedMigrations = await loadReviewedMigrationSet(migrationsDirectory);
  let reserved: ReservedSql | undefined;
  let reservedSessionClosed = false;
  let reservedSessionUsable = true;
  let reservedReleasedNormally = false;
  const sql = postgres(connectionUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => undefined,
    onclose: () => {
      if (reserved && !reservedReleasedNormally) {
        reservedSessionClosed = true;
        reservedSessionUsable = false;
      }
    },
  });
  let advisoryLockHeld = false;
  let primaryError: unknown;

  try {
    reserved = await sql.reserve();
    await reserved.unsafe("set lock_timeout = '10s'");
    await reserved.unsafe("set statement_timeout = '5min'");
    await reserved`select pg_advisory_lock(hashtext('crm-salam-fortress:migrations'))`;
    advisoryLockHeld = true;
    await reserved`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum char(64) not null,
        applied_at timestamptz not null default now()
      )
    `;

    const applied = await reserved<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations order by filename
    `;
    if (applied.length > reviewedMigrations.length) {
      throw new Error("Applied migration history is not a reviewed manifest prefix.");
    }
    for (const [index, ledgerRow] of applied.entries()) {
      const reviewed = reviewedMigrations[index];
      if (
        !reviewed ||
        ledgerRow.filename !== reviewed.filename ||
        ledgerRow.checksum !== reviewed.checksum
      ) {
        throw new Error("Applied migration history is not an unchanged manifest prefix.");
      }
    }

    for (const migration of reviewedMigrations.slice(applied.length)) {
      await applyReviewedMigrationAtomically(
        reserved,
        migration,
        () => {
          reservedSessionUsable = false;
        },
      );
      if (!reservedSessionUsable || reservedSessionClosed) {
        throw new Error("Reserved migration session closed before normal release.");
      }
    }
  } catch (error: unknown) {
    primaryError = error;
    reservedSessionUsable = false;
    throw error;
  } finally {
    let cleanupError: unknown;
    const recordUnexpectedSessionClose = () => {
      if (reservedSessionClosed) {
        cleanupError ??= new Error("Reserved migration session closed before normal release.");
      }
    };
    recordUnexpectedSessionClose();
    if (
      reserved &&
      advisoryLockHeld &&
      reservedSessionUsable &&
      !reservedSessionClosed
    ) {
      try {
        const [lockRelease] = await reserved<{ unlocked: boolean }[]>`
          select pg_advisory_unlock(hashtext('crm-salam-fortress:migrations')) as unlocked
        `;
        if (!lockRelease?.unlocked) {
          cleanupError = new Error("Migration advisory lock ownership was lost before release.");
        }
      } catch (error: unknown) {
        cleanupError = error;
        reservedSessionUsable = false;
      }
    }
    recordUnexpectedSessionClose();
    if (reserved && reservedSessionUsable && !reservedSessionClosed) {
      try {
        reserved.release();
        reservedReleasedNormally = true;
      } catch (error: unknown) {
        cleanupError ??= error;
        reservedSessionUsable = false;
      }
    }
    try {
      await sql.end({ timeout: reservedSessionUsable && !reservedSessionClosed ? 5 : 0 });
    } catch (error: unknown) {
      cleanupError ??= error;
    }
    recordUnexpectedSessionClose();
    if (primaryError === undefined && cleanupError !== undefined) {
      throw cleanupError;
    }
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");
  await runMigrations(databaseUrl).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Migration execution failed.");
    process.exitCode = 1;
  });
}
