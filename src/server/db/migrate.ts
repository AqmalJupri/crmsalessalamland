import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  assertMigrationSource,
  validateMigrationDirectoryEntries,
} from "./migration-manifest";

export async function runMigrations(
  connectionUrl: string,
  migrationsDirectory = resolve(process.cwd(), "db/migrations"),
): Promise<void> {
  const sql = postgres(connectionUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  let advisoryLockHeld = false;

  try {
    await sql.unsafe("set lock_timeout = '10s'");
    await sql.unsafe("set statement_timeout = '5min'");
    await sql`select pg_advisory_lock(hashtext('crm-salam-fortress:migrations'))`;
    advisoryLockHeld = true;
    await sql`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum char(64) not null,
        applied_at timestamptz not null default now()
      )
    `;

    const files = validateMigrationDirectoryEntries(await readdir(migrationsDirectory));

    for (const filename of files) {
      const source = await readFile(resolve(migrationsDirectory, filename), "utf8");
      const checksum = assertMigrationSource(filename, source);
      const [existing] = await sql<{ checksum: string }[]>`
        select checksum from schema_migrations where filename = ${filename}
      `;

      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Applied migration ${filename} has changed.`);
        }
        continue;
      }

      await sql.begin(async (transaction) => {
        await transaction.unsafe(source);
        await transaction`
          insert into schema_migrations (filename, checksum)
          values (${filename}, ${checksum})
        `;
      });
    }
  } finally {
    if (advisoryLockHeld) {
      await sql`select pg_advisory_unlock(hashtext('crm-salam-fortress:migrations'))`.catch(
        () => undefined,
      );
    }
    await sql.end();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");
  void runMigrations(databaseUrl);
}
