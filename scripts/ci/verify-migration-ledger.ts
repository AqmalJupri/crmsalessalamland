import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  EXPECTED_MIGRATIONS,
  assertMigrationLedgerCurrent,
  type MigrationLedgerRow,
} from "../../src/server/db/migration-manifest";

export function assertCiMigrationLedgerCurrent(
  rows: readonly MigrationLedgerRow[],
): number {
  assertMigrationLedgerCurrent(rows);
  return EXPECTED_MIGRATIONS.length;
}

async function verifyMigrationLedger(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to verify migrations.");

  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

  try {
    const rows = await sql<MigrationLedgerRow[]>`
      select filename, checksum
      from schema_migrations
      order by filename
    `;
    const migrationCount = assertCiMigrationLedgerCurrent(rows);
    process.stdout.write(
      `Verified exact frozen migration ledger (${migrationCount} rows).\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void verifyMigrationLedger().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
