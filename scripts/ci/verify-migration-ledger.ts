import { open } from "node:fs/promises";
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

export async function writeMigrationLedgerEvidence(
  rows: readonly MigrationLedgerRow[],
  outputPath: string,
): Promise<void> {
  assertCiMigrationLedgerCurrent(rows);
  const entries = rows.map(({ filename, checksum }) => ({ filename, checksum }));
  const source = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
  let output;
  try {
    output = await open(outputPath, "wx", 0o600);
    await output.writeFile(source, "utf8");
    await output.sync();
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error("Migration ledger evidence already exists.");
    }
    throw error;
  } finally {
    await output?.close();
  }
}

function evidenceOutputArgument(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("Usage: verify-migration-ledger.ts [--output <path>]");
  }
  return argv[1];
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
    const outputPath = evidenceOutputArgument(process.argv.slice(2));
    if (outputPath) await writeMigrationLedgerEvidence(rows, outputPath);
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
