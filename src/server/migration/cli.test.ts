import { constants as fileConstants } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";

vi.mock("server-only", () => ({}));

import {
  runMigrationCli,
  type MigrationCliDependencies,
  type MigrationStatusSnapshot,
} from "./cli";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/import/", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL(
    "../../../tests/fixtures/import/synthetic-source-manifest.json",
    import.meta.url,
  ),
);

const safeStatus: MigrationStatusSnapshot = {
  inspectedAt: "2026-07-18T00:00:00.000Z",
  counts: {
    sources: "1",
    batches: "1",
    sourceLimit: "100",
    batchLimit: "100",
  },
  sources: [
    {
      sourceId: "10000000-0000-4000-8000-000000000001",
      state: "ACTIVE",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  ],
  batches: [
    {
      batchId: "20000000-0000-4000-8000-000000000001",
      sourceId: "10000000-0000-4000-8000-000000000001",
      state: "FAILED",
      counts: {
        total: "3",
        staged: "0",
        valid: "0",
        rejected: "3",
        quarantined: "0",
        hidden: "0",
        approved: "0",
        imported: "0",
        noOp: "0",
      },
      reasonCodes: ["SOURCE_SCHEMA_INVALID"],
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      correlationId: "20000000-0000-4000-8000-000000000001",
    },
  ],
};

function harness(overrides: {
  args?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  inspectStatus?: MigrationCliDependencies["inspectStatus"];
  inspectSyntheticManifest?: MigrationCliDependencies["inspectSyntheticManifest"];
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const inspectStatus = vi.fn(
    overrides.inspectStatus ?? (async () => safeStatus),
  );
  const inspectSyntheticManifest = vi.fn(
    overrides.inspectSyntheticManifest ??
      (async () => ({
        sourceId: "synthetic-source-fixture",
        batchId: "synthetic-batch-fixture",
        state: "REGISTERED" as const,
        counts: {
          total: "0",
          staged: "0",
          valid: "0",
          rejected: "0",
          quarantined: "0",
          hidden: "0",
          approved: "0",
          imported: "0",
          noOp: "0",
        },
        reasonCodes: ["SYNTHETIC_FIXTURE_ONLY"],
        capturedAt: "2000-01-01T00:00:00.000Z",
        correlationId: "synthetic-correlation-fixture",
      })),
  );

  return {
    stdout,
    stderr,
    inspectStatus,
    inspectSyntheticManifest,
    execute: () =>
      runMigrationCli({
        args: overrides.args ?? ["status"],
        environment:
          overrides.environment ??
          ({
            DEPLOYMENT_ENVIRONMENT: "local",
            NODE_ENV: "test",
            DATABASE_URL: "postgresql://operator:do-not-print@127.0.0.1:5432/crm",
          } as const),
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        dependencies: { inspectStatus, inspectSyntheticManifest },
      }),
  };
}

function parsedLine(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

interface ControlledManifestMetadata {
  isFile(): boolean;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

function manifestMetadata(
  size: number,
  overrides: Partial<ControlledManifestMetadata> = {},
): ControlledManifestMetadata {
  return {
    isFile: () => true,
    size,
    dev: 41,
    ino: 42,
    mtimeMs: 43,
    ctimeMs: 44,
    ...overrides,
  };
}

function controlledManifestHandle(options: {
  chunks: readonly Uint8Array[];
  initial: ControlledManifestMetadata;
  final?: ControlledManifestMetadata;
}) {
  const metadata = options.final
    ? [options.initial, options.final]
    : [options.initial];
  let statIndex = 0;
  return {
    stat: vi.fn(
      async () => metadata[Math.min(statIndex++, metadata.length - 1)]!,
    ),
    createReadStream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of options.chunks) yield chunk;
      },
    })),
    close: vi.fn(async () => undefined),
  };
}

async function runDefaultManifestWithOpen(
  openImplementation: (...args: readonly unknown[]) => Promise<unknown>,
  args: readonly string[] = ["inspect-manifest"],
) {
  vi.resetModules();
  const openMock = vi.fn(openImplementation);
  vi.doMock("node:fs/promises", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs/promises")>()),
    open: openMock,
  }));
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const { runMigrationCli: runWithControlledManifest } = await import("./cli");
    const exitCode = await runWithControlledManifest({
      args,
      environment: { DEPLOYMENT_ENVIRONMENT: "ci", NODE_ENV: "test" },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { exitCode, stdout, stderr, openMock };
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}

describe("migration operator CLI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "", "production", "preview", "LOCAL"])(
    "denies DEPLOYMENT_ENVIRONMENT=%s before reading NODE_ENV or opening resources",
    async (deploymentEnvironment) => {
      const reads: string[] = [];
      const environment = new Proxy<Record<string, string | undefined>>(
        {
          DEPLOYMENT_ENVIRONMENT: deploymentEnvironment,
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://operator:secret@127.0.0.1:5432/customer",
        },
        {
          get(target, property, receiver) {
            if (typeof property === "string") reads.push(property);
            return Reflect.get(target, property, receiver) as string | undefined;
          },
        },
      );
      const run = harness({ environment });

      await expect(run.execute()).resolves.toBe(1);

      expect(reads).toEqual(["DEPLOYMENT_ENVIRONMENT"]);
      expect(run.inspectStatus).not.toHaveBeenCalled();
      expect(run.inspectSyntheticManifest).not.toHaveBeenCalled();
      expect(run.stdout).toEqual([]);
      expect(parsedLine(run.stderr)).toEqual({
        state: "DENIED",
        reasonCodes: ["DEPLOYMENT_ENVIRONMENT_DENIED"],
      });
    },
  );

  it.each(["production", "preview", "local", "TEST", ""])(
    "denies the explicit NODE_ENV mode %s before parsing commands or opening resources",
    async (nodeEnvironment) => {
      const run = harness({
        args: ["status", "/tmp/customer-export.csv"],
        environment: {
          DEPLOYMENT_ENVIRONMENT: "staging",
          NODE_ENV: nodeEnvironment,
          DATABASE_URL: "postgresql://operator:secret@127.0.0.1:5432/customer",
        },
      });

      await expect(run.execute()).resolves.toBe(1);

      expect(run.inspectStatus).not.toHaveBeenCalled();
      expect(run.inspectSyntheticManifest).not.toHaveBeenCalled();
      expect(parsedLine(run.stderr)).toEqual({
        state: "DENIED",
        reasonCodes: ["NODE_ENVIRONMENT_DENIED"],
      });
    },
  );

  it("accepts a missing NODE_ENV but still requires an exact read-only command", async () => {
    const run = harness({
      args: [],
      environment: {
        DEPLOYMENT_ENVIRONMENT: "ci",
        DATABASE_URL: "postgresql://operator:secret@127.0.0.1:5432/customer",
      },
    });

    await expect(run.execute()).resolves.toBe(1);

    expect(parsedLine(run.stderr)).toEqual({
      state: "DENIED",
      reasonCodes: ["COMMAND_DENIED"],
    });
    expect(run.inspectStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["status", "extra"],
    ["inspect-manifest", "/tmp/customer-export.csv"],
    ["apply"],
    ["import"],
    ["reconcile"],
    ["migrate"],
    ["status --verbose"],
  ])("rejects the exact argument vector %j before DB or manifest access", async (...args) => {
    const run = harness({ args });

    await expect(run.execute()).resolves.toBe(1);

    expect(parsedLine(run.stderr)).toEqual({
      state: "DENIED",
      reasonCodes: ["COMMAND_DENIED"],
    });
    expect(run.inspectStatus).not.toHaveBeenCalled();
    expect(run.inspectSyntheticManifest).not.toHaveBeenCalled();
  });

  it("requires DATABASE_URL only after the status command is accepted", async () => {
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      { DEPLOYMENT_ENVIRONMENT: "local", NODE_ENV: "test" },
      {
        get(target, property, receiver) {
          if (typeof property === "string") reads.push(property);
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const run = harness({ args: ["status"], environment });

    await expect(run.execute()).resolves.toBe(1);

    expect(reads).toEqual(["DEPLOYMENT_ENVIRONMENT", "NODE_ENV", "DATABASE_URL"]);
    expect(parsedLine(run.stderr)).toEqual({
      state: "DENIED",
      reasonCodes: ["DATABASE_CONFIGURATION_DENIED"],
    });
    expect(run.inspectStatus).not.toHaveBeenCalled();
  });

  it("renders a bounded status snapshot with string counts and whitelisted fields", async () => {
    const unsafeSnapshot = {
      ...safeStatus,
      databaseUrl: "postgresql://operator:secret@127.0.0.1:5432/customer",
      sources: safeStatus.sources.map((source) => ({
        ...source,
        ownerEmail: "owner@example.test",
      })),
      batches: safeStatus.batches.map((batch) => ({
        ...batch,
        paymentNarrative: "Call +60123456789",
        reasonCodes: [
          "SOURCE_SCHEMA_INVALID",
          "leak@example.test",
          "CUSTOMER_PHONE_60123456789",
          "NATIONAL_ID_900101011234",
        ],
      })),
    } as unknown as MigrationStatusSnapshot;
    const run = harness({
      args: ["status"],
      inspectStatus: async () => unsafeSnapshot,
    });

    await expect(run.execute()).resolves.toBe(0);

    expect(run.stderr).toEqual([]);
    const output = parsedLine(run.stdout);
    expect(output).toEqual({
      state: "READY",
      counts: safeStatus.counts,
      sources: safeStatus.sources,
      batches: [
        {
          ...safeStatus.batches[0],
          reasonCodes: [
            "SOURCE_SCHEMA_INVALID",
            "UNSAFE_REASON_CODE_REDACTED",
            "UNSAFE_REASON_CODE_REDACTED",
            "UNSAFE_REASON_CODE_REDACTED",
          ],
        },
      ],
      timestamp: safeStatus.inspectedAt,
    });
    expect(JSON.stringify(output)).not.toMatch(
      /postgresql:|secret|owner@example|\+60123456789|paymentNarrative/i,
    );
  });

  it("fails closed when a status snapshot violates its count contract", async () => {
    const run = harness({
      inspectStatus: async () =>
        ({
          ...safeStatus,
          counts: { ...safeStatus.counts, batches: 1 },
        }) as unknown as MigrationStatusSnapshot,
    });

    await expect(run.execute()).resolves.toBe(1);

    expect(run.stdout).toEqual([]);
    expect(parsedLine(run.stderr)).toEqual({
      state: "DENIED",
      reasonCodes: ["STATUS_RESULT_INVALID"],
    });
  });

  it("never emits dependency errors, arguments, environment values, credentials, or PII", async () => {
    const run = harness({
      args: ["status"],
      environment: {
        DEPLOYMENT_ENVIRONMENT: "local",
        NODE_ENV: "test",
        DATABASE_URL:
          "postgresql://operator:client-secret-value@127.0.0.1:5432/customer",
        OIDC_CLIENT_SECRET: "oidc-secret-value",
      },
      inspectStatus: async () => {
        throw new Error(
          "postgresql://operator:client-secret-value@host/customer leak@example.test +60123456789",
        );
      },
    });

    await expect(run.execute()).resolves.toBe(1);

    const rendered = run.stderr.join("");
    expect(parsedLine(run.stderr)).toEqual({
      state: "DENIED",
      reasonCodes: ["DATABASE_INSPECTION_FAILED"],
    });
    expect(rendered).not.toMatch(
      /operator|client-secret|customer|leak@example|\+60123456789|OIDC|postgresql:/i,
    );
  });

  it("inspects only the built-in synthetic manifest without reading DATABASE_URL", async () => {
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        DEPLOYMENT_ENVIRONMENT: "staging",
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://operator:secret@127.0.0.1:5432/customer",
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") reads.push(property);
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const run = harness({ args: ["inspect-manifest"], environment });

    await expect(run.execute()).resolves.toBe(0);

    expect(reads).toEqual(["DEPLOYMENT_ENVIRONMENT", "NODE_ENV"]);
    expect(run.inspectStatus).not.toHaveBeenCalled();
    expect(run.inspectSyntheticManifest).toHaveBeenCalledTimes(1);
    expect(parsedLine(run.stdout)).toEqual({
      state: "REGISTERED",
      counts: {
        total: "0",
        staged: "0",
        valid: "0",
        rejected: "0",
        quarantined: "0",
        hidden: "0",
        approved: "0",
        imported: "0",
        noOp: "0",
      },
      sourceId: "synthetic-source-fixture",
      batchId: "synthetic-batch-fixture",
      reasonCodes: ["SYNTHETIC_FIXTURE_ONLY"],
      timestamp: "2000-01-01T00:00:00.000Z",
      correlationId: "synthetic-correlation-fixture",
    });
  });

  it("maps malformed manifests to one safe failure code", async () => {
    const run = harness({
      args: ["inspect-manifest"],
      inspectSyntheticManifest: async () => {
        throw new Error(
          "Manifest contained customer@example.test and password=do-not-print",
        );
      },
    });

    await expect(run.execute()).resolves.toBe(1);

    expect(run.stdout).toEqual([]);
    expect(parsedLine(run.stderr)).toEqual({
      state: "DENIED",
      reasonCodes: ["SYNTHETIC_MANIFEST_INVALID"],
    });
    expect(run.stderr.join("")).not.toMatch(/customer@example|password|do-not-print/i);
  });
});

describe("synthetic fixture repository contract", () => {
  it("keeps exactly one named JSON fixture behind an ignore allowlist", async () => {
    const [entries, ignoreFile] = await Promise.all([
      readdir(fixtureDirectory),
      readFile(`${repositoryRoot}/.gitignore`, "utf8"),
    ]);

    expect(entries).toEqual(["synthetic-source-manifest.json"]);
    expect(ignoreFile).toContain("tests/fixtures/import/*");
    expect(ignoreFile).toContain(
      "!tests/fixtures/import/synthetic-source-manifest.json",
    );
    expect(ignoreFile).toContain("*.sqlite-*");
    expect(ignoreFile).toContain("*.sqlite3-*");
    expect(ignoreFile).toContain("*.db-*");
  });

  it("contains unmistakably synthetic values and no realistic PII or credentials", async () => {
    const source = await readFile(fixturePath, "utf8");
    const fixture = JSON.parse(source) as Record<string, unknown>;

    expect(fixture.fixture_kind).toBe("SYNTHETIC_MIGRATION_SOURCE_MANIFEST");
    expect(fixture.source_id).toMatch(/^synthetic-source-/);
    expect(fixture.batch_id).toMatch(/^synthetic-batch-/);
    expect(fixture.correlation_id).toMatch(/^synthetic-correlation-/);
    expect(fixture.reason_codes).toEqual(["SYNTHETIC_FIXTURE_ONLY"]);
    expect(source).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    expect(source).not.toMatch(/(?:\+?60|0)1[0-46-9][\s().-]*\d{7,8}/);
    expect(source).not.toMatch(
      /\b(?:password|passwd|client[_-]?secret|api[_-]?key|authorization|bearer|cookie|credential)\b/i,
    );
    expect(source).not.toMatch(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    );
  });
});

describe("default synthetic manifest reader", () => {
  const safeManifestFailure = JSON.stringify({
    state: "DENIED",
    reasonCodes: ["SYNTHETIC_MANIFEST_INVALID"],
  });

  async function expectControlledManifestDenied(
    handle: ReturnType<typeof controlledManifestHandle>,
  ) {
    const run = await runDefaultManifestWithOpen(async () => handle);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toEqual([safeManifestFailure]);
    expect(handle.close).toHaveBeenCalledOnce();
    return run;
  }

  it("reads and renders the repository's one fixed synthetic fixture", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runMigrationCli({
      args: ["inspect-manifest"],
      environment: { DEPLOYMENT_ENVIRONMENT: "local", NODE_ENV: "test" },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(parsedLine(stdout)).toEqual({
      state: "REGISTERED",
      counts: {
        total: "0",
        staged: "0",
        valid: "0",
        rejected: "0",
        quarantined: "0",
        hidden: "0",
        approved: "0",
        imported: "0",
        noOp: "0",
      },
      sourceId: "synthetic-source-fixture",
      batchId: "synthetic-batch-fixture",
      reasonCodes: ["SYNTHETIC_FIXTURE_ONLY"],
      timestamp: "2000-01-01T00:00:00.000Z",
      correlationId: "synthetic-correlation-fixture",
    });
  });

  it("opens only the fixed fixture with no-follow, non-blocking, read-only flags", async () => {
    const bytes = await readFile(fixturePath);
    const metadata = manifestMetadata(bytes.length);
    const handle = controlledManifestHandle({
      chunks: [bytes],
      initial: metadata,
    });

    const run = await runDefaultManifestWithOpen(async () => handle);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toEqual([]);
    expect(run.stdout).toHaveLength(1);
    expect(run.openMock).toHaveBeenCalledOnce();
    expect(run.openMock).toHaveBeenCalledWith(
      fixturePath,
      fileConstants.O_RDONLY |
        fileConstants.O_NOFOLLOW |
        fileConstants.O_NONBLOCK,
    );
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.createReadStream).toHaveBeenCalledWith({ autoClose: false });
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects a caller-supplied path before the default reader can open anything", async () => {
    const run = await runDefaultManifestWithOpen(
      async () => {
        throw new Error("the reader must not be reached");
      },
      ["inspect-manifest", "/tmp/customer-export.csv"],
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toEqual([
      JSON.stringify({ state: "DENIED", reasonCodes: ["COMMAND_DENIED"] }),
    ]);
    expect(run.openMock).not.toHaveBeenCalled();
  });

  it.each([
    ["non-regular", manifestMetadata(1, { isFile: () => false })],
    ["empty", manifestMetadata(0)],
    ["oversized", manifestMetadata(16_385)],
  ])("denies a %s file and still closes its acquired handle", async (_case, metadata) => {
    const handle = controlledManifestHandle({ chunks: [], initial: metadata });

    await expectControlledManifestDenied(handle);

    expect(handle.createReadStream).not.toHaveBeenCalled();
  });

  it.each([
    [
      "UTF-8 BOM",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"fixture_kind":"SYNTHETIC_MIGRATION_SOURCE_MANIFEST"}'),
      ]),
    ],
    ["malformed UTF-8", Buffer.from([0xc3, 0x28])],
  ])("denies %s bytes with one safe error", async (_case, bytes) => {
    const handle = controlledManifestHandle({
      chunks: [bytes],
      initial: manifestMetadata(bytes.length),
    });

    await expectControlledManifestDenied(handle);

    expect(handle.stat).toHaveBeenCalledTimes(2);
  });

  it("denies a valid-shaped manifest with an unreviewed extra key", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<
      string,
      unknown
    >;
    fixture.customer_email = "customer@example.test";
    const bytes = Buffer.from(JSON.stringify(fixture));
    const handle = controlledManifestHandle({
      chunks: [bytes],
      initial: manifestMetadata(bytes.length),
    });

    const run = await expectControlledManifestDenied(handle);

    expect(run.stderr.join("")).not.toContain("customer@example.test");
  });

  it.each([
    ["device identity", { dev: 51 }],
    ["inode identity", { ino: 52 }],
    ["size", { size: 53 }],
    ["modification time", { mtimeMs: 54 }],
    ["change time", { ctimeMs: 55 }],
  ] as const)("denies a between-read %s mutation", async (_case, mutation) => {
    const bytes = await readFile(fixturePath);
    const initial = manifestMetadata(bytes.length);
    const handle = controlledManifestHandle({
      chunks: [bytes],
      initial,
      final: { ...initial, ...mutation },
    });

    await expectControlledManifestDenied(handle);

    expect(handle.stat).toHaveBeenCalledTimes(2);
  });

  it("denies stream overread before parsing", async () => {
    const bytes = await readFile(fixturePath);
    const handle = controlledManifestHandle({
      chunks: [bytes],
      initial: manifestMetadata(bytes.length - 1),
    });

    await expectControlledManifestDenied(handle);

    expect(handle.stat).toHaveBeenCalledOnce();
  });

  it("denies stream underread after the final identity check", async () => {
    const bytes = await readFile(fixturePath);
    const handle = controlledManifestHandle({
      chunks: [bytes.subarray(0, bytes.length - 1)],
      initial: manifestMetadata(bytes.length),
    });

    await expectControlledManifestDenied(handle);

    expect(handle.stat).toHaveBeenCalledTimes(2);
  });

  it("maps an acquired handle's close failure to the same safe denial", async () => {
    const bytes = await readFile(fixturePath);
    const handle = controlledManifestHandle({
      chunks: [bytes],
      initial: manifestMetadata(bytes.length),
    });
    handle.close.mockRejectedValueOnce(
      new Error("/tmp/customer-export.csv customer@example.test"),
    );

    const run = await expectControlledManifestDenied(handle);

    expect(run.stderr.join("")).not.toMatch(/customer-export|customer@example/i);
  });

  it("maps an open failure to the same safe denial without diagnostics", async () => {
    const run = await runDefaultManifestWithOpen(async () => {
      throw new Error("/tmp/customer-export.csv customer@example.test");
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toEqual([safeManifestFailure]);
    expect(run.stderr.join("")).not.toMatch(/customer-export|customer@example/i);
  });
});

describe("status transaction SQL contract", () => {
  it("pins pg_catalog, qualifies public tables, and uses one repeatable-read snapshot", async () => {
    vi.resetModules();
    const statements: string[] = [];
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const reserved = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
        const statement = normalize(
          strings.reduce(
            (result, part, index) =>
              `${result}${part}${index < values.length ? "$value" : ""}`,
            "",
          ),
        );
        statements.push(statement);
        if (statement.includes("transaction_read_only")) {
          return [{ transaction_read_only: "on" }];
        }
        if (statement.includes("public.schema_migrations")) {
          return EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({
            filename,
            checksum,
          }));
        }
        if (statement.includes("source_count")) {
          return [
            {
              source_count: "0",
              batch_count: "0",
              inspected_at: new Date("2026-07-18T00:00:00.000Z"),
            },
          ];
        }
        return [];
      }),
      {
        unsafe: vi.fn(async (statement: string) => {
          statements.push(normalize(statement));
          return [];
        }),
        release: vi.fn(),
      },
    );
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn(async () => undefined),
    });
    const postgresFactory = vi.fn(() => pool);
    vi.doMock("postgres", () => ({ default: postgresFactory }));

    try {
      const { runMigrationCli: runWithRecordedSql } = await import("./cli");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runWithRecordedSql({
        args: ["status"],
        environment: {
          DEPLOYMENT_ENVIRONMENT: "ci",
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://operator:never-print@127.0.0.1:5432/synthetic",
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      expect(statements.slice(0, 5)).toEqual([
        "begin isolation level repeatable read read only",
        "set local search_path = pg_catalog",
        "set local lock_timeout = '1s'",
        "set local statement_timeout = '5s'",
        "set local idle_in_transaction_session_timeout = '10s'",
      ]);
      expect(statements[5]).toContain(
        "pg_catalog.current_setting('transaction_read_only')",
      );
      expect(statements[6]).toContain("from public.schema_migrations");
      expect(statements[6]).toContain('collate pg_catalog."C"');
      expect(statements[7]).toContain("from public.migration_sources");
      expect(statements[7]).toContain("from public.import_batches");
      expect(statements[7]).toContain("pg_catalog.clock_timestamp()");
      expect(statements[8]).toContain("from public.migration_sources");
      expect(statements[9]).toContain("from public.import_batches");
      expect(statements.at(-1)).toBe("commit");
      expect(reserved.release).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledWith({ timeout: 1 });
    } finally {
      vi.doUnmock("postgres");
      vi.resetModules();
    }
  });

  it("waits for driver-forced inspection cleanup before returning the deadline denial", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let rejectBlockedOperation: ((reason: Error) => void) | undefined;
    let resolveDriverShutdown: (() => void) | undefined;
    const driverShutdown = new Promise<void>((resolve) => {
      resolveDriverShutdown = resolve;
    });
    const blockedOperation = new Promise<never>((_resolve, reject) => {
      rejectBlockedOperation = reject;
    });
    const forcedShutdown = vi.fn(() => {
      rejectBlockedOperation?.(new Error("driver forced shutdown"));
      return driverShutdown;
    });
    const reserved = Object.assign(vi.fn(), {
      unsafe: vi.fn(() => blockedOperation),
      release: vi.fn(),
    });
    const pool = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
      end: vi.fn((options: { timeout: number }) => {
        if (options.timeout === 0) return forcedShutdown();
        return driverShutdown;
      }),
    });
    vi.doMock("postgres", () => ({ default: vi.fn(() => pool) }));

    let pending: Promise<number> | undefined;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const { runMigrationCli: runWithBlockedSql } = await import("./cli");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const observed: number[] = [];
      pending = runWithBlockedSql({
        args: ["status"],
        environment: {
          DEPLOYMENT_ENVIRONMENT: "ci",
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://operator:never-print@127.0.0.1:5432/synthetic",
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      void pending.then((exitCode) => observed.push(exitCode));
      await vi.advanceTimersByTimeAsync(20_000);

      expect(forcedShutdown).toHaveBeenCalledOnce();
      expect(reserved.release).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledWith({ timeout: 1 });
      expect(observed).toEqual([]);

      resolveDriverShutdown?.();
      await pending;
      await Promise.resolve();

      expect(observed).toEqual([1]);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        JSON.stringify({
          state: "DENIED",
          reasonCodes: ["DATABASE_INSPECTION_DEADLINE"],
        }),
      ]);
      expect(pool.end).toHaveBeenCalledWith({ timeout: 0 });
      expect(vi.getTimerCount()).toBe(0);
      expect(unhandledRejections).toEqual([]);
    } finally {
      resolveDriverShutdown?.();
      await pending?.catch(() => undefined);
      await Promise.resolve();
      process.off("unhandledRejection", onUnhandledRejection);
      vi.doUnmock("postgres");
      vi.resetModules();
      vi.useRealTimers();
    }

    expect(reserved.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledWith({ timeout: 1 });
  });
});
