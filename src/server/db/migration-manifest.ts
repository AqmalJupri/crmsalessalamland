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
  Object.freeze({
    filename: "0003_reconciliation_bytewise_order.sql",
    checksum: "46fb6ab301eb4362dc4c74c186a432e59bcf00736e78ab3d5d8ea8e7359885c4",
    byteLength: 5_176,
  }),
  Object.freeze({
    filename: "0004_membership_user_identity_guard.sql",
    checksum: "58713ceda7660aa4a5385c734744c9bb9e12ccb00272032acf9a34cdfca70c5c",
    byteLength: 554,
  }),
  Object.freeze({
    filename: "0005_reconciliation_typed_result_truth.sql",
    checksum: "8fbf0ff4b506cc682b16b6d3fe4b59d69ee47040b95ed20542ff6983c496c381",
    byteLength: 679,
  }),
  Object.freeze({
    filename: "0006_reconciliation_finite_amounts.sql",
    checksum: "c320a95155c63273f176d2d79df7f9c729285b9c0474e332207da8f4bf0c5541",
    byteLength: 509,
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
