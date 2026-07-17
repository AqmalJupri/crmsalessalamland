import { is, SQL } from "drizzle-orm";
import {
  getTableConfig,
  PgDialect,
  PgTable,
  type PgColumn,
} from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@/server/db/migrate";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for migration schema parity tests.");

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Migration schema parity tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const expectedTableNames = [
  "import_batches",
  "import_rows",
  "legacy_object_links",
  "migration_domain_authorities",
  "migration_source_scopes",
  "migration_sources",
  "quarantine_items",
  "reconciliation_results",
  "reconciliation_runs",
  "source_authority_transition_groups",
  "source_authority_transitions",
  "transform_versions",
] as const;

const sqlClient = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const dialect = new PgDialect();

type MigrationTableName = (typeof expectedTableNames)[number];

interface DatabaseColumn {
  tableName: MigrationTableName;
  columnName: string;
  sqlType: string;
  notNull: boolean;
  defaultExpression: string | null;
}

interface DatabaseKey {
  tableName: MigrationTableName;
  constraintName: string;
  constraintType: "p" | "u";
  columnNames: string[];
  nullsNotDistinct: boolean;
}

interface DatabaseForeignKey {
  tableName: MigrationTableName;
  constraintName: string;
  columnNames: string[];
  foreignTableName: string;
  foreignColumnNames: string[];
  onUpdate: string;
  onDelete: string;
  matchType: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
}

interface DatabaseUniqueIndex {
  tableName: MigrationTableName;
  indexName: string;
  columnNames: string[];
  predicate: string | null;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").replace(/,\s+/g, ",").trim();
}

function normalizeSqlType(value: string): string {
  return normalizeSql(value).replace(/,\s*/g, ",");
}

function hasRedundantOuterParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;

  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0 && quote === null;
}

function sqlIdentifierMatches(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false;
  if (value.startsWith('"')) return value === `"${expected}"`;
  return value.toLowerCase() === expected;
}

function unwrapPredicate(value: string): string {
  let unwrapped = value.trim();
  while (hasRedundantOuterParentheses(unwrapped)) {
    unwrapped = unwrapped.slice(1, -1).trim();
  }
  return unwrapped;
}

function normalizeIndexPredicate(indexName: string, value: string | null): string | null {
  if (value === null) return null;

  const identifier = '("[^"\\r\\n]+"|[A-Za-z_][A-Za-z0-9_$]*)';
  const candidate = unwrapPredicate(value);

  if (indexName === "import_rows_row_number_unique") {
    const match = new RegExp(
      `^(?:${identifier}\\s*\\.\\s*)?${identifier}\\s+is\\s+not\\s+null$`,
      "i",
    ).exec(candidate);
    if (
      match &&
      (match[1] === undefined || sqlIdentifierMatches(match[1], "import_rows")) &&
      sqlIdentifierMatches(match[2], "row_number")
    ) {
      return "row_number is not null";
    }
  }

  if (indexName === "quarantine_items_open_unique") {
    const match = new RegExp(
      `^(?:${identifier}\\s*\\.\\s*)?${identifier}\\s*=\\s*('(?:[^']|'')*')\\s*(?:::\\s*${identifier})?$`,
      "i",
    ).exec(candidate);
    const castType = match?.[4];
    if (
      match &&
      (match[1] === undefined || sqlIdentifierMatches(match[1], "quarantine_items")) &&
      sqlIdentifierMatches(match[2], "status") &&
      match[3] === "'OPEN'" &&
      (castType === undefined || (!castType.startsWith('"') && castType.toLowerCase() === "text"))
    ) {
      return "status = 'OPEN'";
    }
  }

  return value.trim();
}

function canonicalDatabaseDefault(value: string | null): string | null {
  if (value === null) return null;

  const textLiteral = /^'((?:[^']|'')*)'::text$/.exec(value);
  if (textLiteral) return `string:${textLiteral[1]?.replace(/''/g, "'") ?? ""}`;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return `number:${value}`;
  if (value === "true" || value === "false") return `boolean:${value}`;
  return `sql:${normalizeSql(value)}`;
}

function canonicalDrizzleDefault(column: PgColumn): string | null {
  if (!column.hasDefault) return null;
  if (column.defaultFn) return "runtime-default";

  const value = column.default;
  if (is(value, SQL)) return `sql:${normalizeSql(dialect.sqlToQuery(value).sql)}`;
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  return `unsupported:${String(value)}`;
}

function indexColumnName(column: unknown): string {
  if (
    typeof column === "object" &&
    column !== null &&
    "name" in column &&
    typeof column.name === "string"
  ) {
    return column.name;
  }
  throw new Error("Migration unique indexes must use named columns, not SQL expressions.");
}

async function loadMigrationTables(): Promise<PgTable[]> {
  const migrationSchema = await vi.importActual<Record<string, unknown>>(
    "@/server/db/migration-schema",
  );
  return Object.values(migrationSchema).filter(
    (value): value is PgTable => is(value, PgTable),
  );
}

beforeAll(async () => {
  await sqlClient.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
});

afterAll(async () => {
  await sqlClient.end();
});

describe("partial-index predicate normalization", () => {
  it("keeps unknown casts semantically distinct", () => {
    expect(
      normalizeIndexPredicate("import_rows_row_number_unique", "pg_typeof('x'::text)"),
    ).not.toBe(
      normalizeIndexPredicate("import_rows_row_number_unique", "pg_typeof('x')"),
    );
  });

  it("keeps quoted identifiers distinct from boolean keywords", () => {
    expect(normalizeIndexPredicate("quarantine_items_open_unique", '"true"')).not.toBe(
      normalizeIndexPredicate("quarantine_items_open_unique", "true"),
    );
  });

  it("normalizes only harmless spellings of the two locked predicates", () => {
    expect(
      normalizeIndexPredicate(
        "import_rows_row_number_unique",
        '(("import_rows"."row_number" IS NOT NULL))',
      ),
    ).toBe("row_number is not null");
    expect(
      normalizeIndexPredicate(
        "quarantine_items_open_unique",
        "(status = 'OPEN'::text)",
      ),
    ).toBe("status = 'OPEN'");
    expect(
      normalizeIndexPredicate(
        "quarantine_items_open_unique",
        '"quarantine_items"."status" = \'OPEN\'',
      ),
    ).toBe("status = 'OPEN'");
  });
});

describe("typed migration schema parity", () => {
  it("matches every PostgreSQL migration table and column contract", async () => {
    const migrationTables = await loadMigrationTables();
    const drizzleTables = migrationTables
      .map((table) => getTableConfig(table))
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(drizzleTables.map(({ name }) => name)).toEqual(expectedTableNames);

    const databaseColumns = await sqlClient<DatabaseColumn[]>`
      select
        relation.relname as "tableName",
        attribute.attname as "columnName",
        format_type(attribute.atttypid, attribute.atttypmod) as "sqlType",
        attribute.attnotnull as "notNull",
        pg_get_expr(column_default.adbin, column_default.adrelid) as "defaultExpression"
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_attribute attribute
        on attribute.attrelid = relation.oid
       and attribute.attnum > 0
       and not attribute.attisdropped
      left join pg_attrdef column_default
        on column_default.adrelid = relation.oid
       and column_default.adnum = attribute.attnum
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and relation.relname = any(${[...expectedTableNames]})
      order by relation.relname, attribute.attnum
    `;

    const drizzleColumns = drizzleTables.flatMap((table) =>
      table.columns.map((column) => ({
        tableName: table.name,
        columnName: column.name,
        sqlType: normalizeSqlType(column.getSQLType()),
        notNull: column.notNull,
        defaultExpression: canonicalDrizzleDefault(column),
      })),
    );
    const normalizedDatabaseColumns = databaseColumns.map((column) => ({
      ...column,
      sqlType: normalizeSqlType(column.sqlType),
      defaultExpression: canonicalDatabaseDefault(column.defaultExpression),
    }));

    expect(drizzleColumns).toEqual(normalizedDatabaseColumns);
  });

  it("matches all primary, unique, composite, and foreign key contracts", async () => {
    const migrationTables = await loadMigrationTables();
    const drizzleTables = migrationTables
      .map((table) => getTableConfig(table))
      .sort((left, right) => left.name.localeCompare(right.name));

    const databaseKeys = await sqlClient<DatabaseKey[]>`
      select
        relation.relname as "tableName",
        constraint_record.conname as "constraintName",
        constraint_record.contype as "constraintType",
        array(
          select attribute.attname::text
          from unnest(constraint_record.conkey) with ordinality as key_column(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = constraint_record.conrelid
           and attribute.attnum = key_column.attnum
          order by key_column.position
        ) as "columnNames",
        coalesce(index_record.indnullsnotdistinct, false) as "nullsNotDistinct"
      from pg_constraint constraint_record
      join pg_class relation on relation.oid = constraint_record.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      left join pg_index index_record on index_record.indexrelid = constraint_record.conindid
      where namespace.nspname = 'public'
        and relation.relname = any(${[...expectedTableNames]})
        and constraint_record.contype in ('p', 'u')
      order by relation.relname, constraint_record.conname
    `;

    const drizzleKeys = drizzleTables
      .flatMap((table) => [
        ...table.columns
          .filter((column) => column.primary)
          .map((column) => ({
            tableName: table.name,
            constraintName: `${table.name}_pkey`,
            constraintType: "p" as const,
            columnNames: [column.name],
            nullsNotDistinct: false,
          })),
        ...table.primaryKeys.map((key) => ({
          tableName: table.name,
          constraintName: key.getName(),
          constraintType: "p" as const,
          columnNames: key.columns.map((column) => column.name),
          nullsNotDistinct: false,
        })),
        ...table.uniqueConstraints.map((key) => ({
          tableName: table.name,
          constraintName: key.getName(),
          constraintType: "u" as const,
          columnNames: key.columns.map((column) => column.name),
          nullsNotDistinct: key.nullsNotDistinct,
        })),
      ])
      .sort((left, right) =>
        `${left.tableName}.${left.constraintName}`.localeCompare(
          `${right.tableName}.${right.constraintName}`,
        ),
      );

    expect(drizzleKeys).toEqual(databaseKeys);

    const databaseForeignKeys = await sqlClient<DatabaseForeignKey[]>`
      select
        relation.relname as "tableName",
        constraint_record.conname as "constraintName",
        array(
          select attribute.attname::text
          from unnest(constraint_record.conkey) with ordinality as key_column(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = constraint_record.conrelid
           and attribute.attnum = key_column.attnum
          order by key_column.position
        ) as "columnNames",
        foreign_relation.relname as "foreignTableName",
        array(
          select attribute.attname::text
          from unnest(constraint_record.confkey) with ordinality as key_column(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = constraint_record.confrelid
           and attribute.attnum = key_column.attnum
          order by key_column.position
        ) as "foreignColumnNames",
        case constraint_record.confupdtype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as "onUpdate",
        case constraint_record.confdeltype
          when 'a' then 'no action'
          when 'r' then 'restrict'
          when 'c' then 'cascade'
          when 'n' then 'set null'
          when 'd' then 'set default'
        end as "onDelete",
        case constraint_record.confmatchtype
          when 's' then 'simple'
          when 'f' then 'full'
          when 'p' then 'partial'
        end as "matchType",
        constraint_record.condeferrable as deferrable,
        constraint_record.condeferred as "initiallyDeferred"
      from pg_constraint constraint_record
      join pg_class relation on relation.oid = constraint_record.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_class foreign_relation on foreign_relation.oid = constraint_record.confrelid
      where namespace.nspname = 'public'
        and relation.relname = any(${[...expectedTableNames]})
        and constraint_record.contype = 'f'
      order by relation.relname, constraint_record.conname
    `;

    const drizzleForeignKeys = drizzleTables
      .flatMap((table) =>
        table.foreignKeys.map((key) => {
          const reference = key.reference();
          return {
            tableName: table.name,
            constraintName: key.getName(),
            columnNames: reference.columns.map((column) => column.name),
            foreignTableName: getTableConfig(reference.foreignTable).name,
            foreignColumnNames: reference.foreignColumns.map((column) => column.name),
            onUpdate: key.onUpdate ?? "no action",
            onDelete: key.onDelete ?? "no action",
            matchType: "simple",
            deferrable: false,
            initiallyDeferred: false,
          };
        }),
      )
      .sort((left, right) =>
        `${left.tableName}.${left.constraintName}`.localeCompare(
          `${right.tableName}.${right.constraintName}`,
        ),
      );

    expect(drizzleForeignKeys).toEqual(databaseForeignKeys);

    const databaseUniqueIndexes = await sqlClient<DatabaseUniqueIndex[]>`
      select
        relation.relname as "tableName",
        index_relation.relname as "indexName",
        array(
          select attribute.attname::text
          from unnest(index_record.indkey::smallint[]) with ordinality as key_column(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = index_record.indrelid
           and attribute.attnum = key_column.attnum
          order by key_column.position
        ) as "columnNames",
        pg_get_expr(index_record.indpred, index_record.indrelid) as predicate
      from pg_index index_record
      join pg_class relation on relation.oid = index_record.indrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_class index_relation on index_relation.oid = index_record.indexrelid
      where namespace.nspname = 'public'
        and relation.relname = any(${[...expectedTableNames]})
        and index_record.indisunique
        and not index_record.indisprimary
        and not exists (
          select 1 from pg_constraint constraint_record
          where constraint_record.conindid = index_record.indexrelid
        )
      order by relation.relname, index_relation.relname
    `;

    const drizzleUniqueIndexes = drizzleTables
      .flatMap((table) =>
        table.indexes
          .filter((index) => index.config.unique)
          .map((index) => ({
            tableName: table.name,
            indexName: index.config.name ?? "",
            columnNames: index.config.columns.map(indexColumnName),
            predicate: normalizeIndexPredicate(
              index.config.name ?? "",
              index.config.where
                ? dialect.sqlToQuery(index.config.where, "indexes").sql
                : null,
            ),
          })),
      )
      .sort((left, right) =>
        `${left.tableName}.${left.indexName}`.localeCompare(`${right.tableName}.${right.indexName}`),
      );

    expect(drizzleUniqueIndexes).toEqual(
      databaseUniqueIndexes.map((index) => ({
        ...index,
        predicate: normalizeIndexPredicate(index.indexName, index.predicate),
      })),
    );
  });
});
