import { createHash } from "node:crypto";

export const EXPECTED_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: "0001_foundation.sql",
    checksum: "169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de",
    byteLength: 98_976,
  }),
  Object.freeze({
    filename: "0002_migration_platform.sql",
    checksum: "2e8425ae8f551fc5b8c96466f36e917df118a12a18c66e69ec68800e73ec0e73",
    byteLength: 100_661,
  }),
] as const);

export interface MigrationLedgerRow extends Record<string, unknown> {
  filename: string;
  checksum: string;
}

const migrationFilenamePattern = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export function migrationChecksum(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export function validateMigrationDirectoryEntries(entries: readonly string[]): string[] {
  const sqlFiles = entries.filter((entry) => entry.toLowerCase().endsWith(".sql"));
  for (const filename of sqlFiles) {
    if (!migrationFilenamePattern.test(filename)) {
      throw new Error(
        `Migration ${filename} must use the zero-padded NNNN_lowercase_name.sql contract.`,
      );
    }
  }

  const versions = new Set<string>();
  for (const filename of sqlFiles) {
    const version = filename.slice(0, 4);
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version ${version}.`);
    }
    versions.add(version);
  }

  const actual = [...sqlFiles].sort((left, right) => left.localeCompare(right));
  const expected = EXPECTED_MIGRATIONS.map((migration) => migration.filename);
  if (
    actual.length !== expected.length ||
    actual.some((filename, index) => filename !== expected[index])
  ) {
    throw new Error("Migration directory does not match the reviewed migration manifest.");
  }
  return expected;
}

export function assertMigrationSource(filename: string, source: string | Buffer): string {
  const expected = EXPECTED_MIGRATIONS.find((migration) => migration.filename === filename);
  if (!expected) throw new Error(`Migration ${filename} is absent from the reviewed manifest.`);

  const byteLength = Buffer.byteLength(source);
  if (byteLength !== expected.byteLength) {
    throw new Error(`Migration ${filename} byte length differs from the reviewed manifest.`);
  }

  const checksum = migrationChecksum(source);
  if (checksum !== expected.checksum) {
    throw new Error(`Migration ${filename} checksum differs from the reviewed manifest.`);
  }
  return checksum;
}

export function assertMigrationLedgerCurrent(rows: readonly MigrationLedgerRow[]): void {
  if (rows.length !== EXPECTED_MIGRATIONS.length) {
    throw new Error("Database migration ledger is not current.");
  }

  const actual = new Map(rows.map((row) => [row.filename, row.checksum]));
  if (
    actual.size !== EXPECTED_MIGRATIONS.length ||
    EXPECTED_MIGRATIONS.some(
      (migration) => actual.get(migration.filename) !== migration.checksum,
    )
  ) {
    throw new Error("Database migration ledger is not current.");
  }
}
