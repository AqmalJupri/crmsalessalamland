import { sql } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";
import {
  assertMigrationLedgerCurrent,
  type MigrationLedgerRow,
} from "@/server/db/migration-manifest";
import { getRuntimeConfig } from "@/server/env";
import { evaluateReadiness } from "@/server/health/readiness";

export const dynamic = "force-dynamic";

async function assertDatabaseReady(): Promise<void> {
  const ledger = await getDatabase().execute<MigrationLedgerRow>(sql`
    select filename, checksum
    from schema_migrations
    order by filename
  `);
  assertMigrationLedgerCurrent(ledger);
}

export async function GET(): Promise<Response> {
  const result = await evaluateReadiness(getRuntimeConfig, assertDatabaseReady);
  return Response.json(result.body, {
    status: result.statusCode,
    headers: { "Cache-Control": "no-store" },
  });
}
