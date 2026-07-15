import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getRuntimeConfig } from "@/server/env";
import * as schema from "./schema";
import { createSingletonResource, type SingletonResource } from "./singleton-resource";

type SqlClient = ReturnType<typeof postgres>;

const globalForDatabase = globalThis as typeof globalThis & {
  crmSqlResource?: SingletonResource<SqlClient>;
};

const sqlResource =
  globalForDatabase.crmSqlResource ??
  createSingletonResource(
    () => {
      const config = getRuntimeConfig();
      return postgres(config.databaseUrl, {
        max: config.databasePoolMax,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
        onnotice: () => undefined,
      });
    },
    (client) => client.end(),
  );

globalForDatabase.crmSqlResource = sqlResource;

export function getDatabase() {
  return drizzle(sqlResource.get(), { schema, casing: "snake_case" });
}

export async function closeDatabaseConnection(): Promise<void> {
  await sqlResource.close();
}
