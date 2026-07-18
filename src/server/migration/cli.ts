import { constants as fileConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres, { type ReservedSql } from "postgres";
import { z } from "zod";
import { assertMigrationLedgerCurrent } from "@/server/db/migration-manifest";

const ALLOWED_DEPLOYMENTS = new Set(["local", "ci", "staging"]);
const ALLOWED_NODE_ENVIRONMENTS = new Set(["development", "test"]);
const ALLOWED_COMMANDS = new Set(["status", "inspect-manifest"]);
const SOURCE_LIMIT = 100;
const BATCH_LIMIT = 100;
const MAX_REASON_CODES = 16;
const MAX_MANIFEST_BYTES = 16_384;
const STATUS_DEADLINE_MS = 20_000;
const STATUS_CLEANUP_GRACE_MS = 1_000;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYNTHETIC_ID_PATTERN = /^synthetic-(?:source|batch|correlation)-[a-z][a-z-]{0,63}$/;
const COUNT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,126}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_REASON_CODE = "UNSAFE_REASON_CODE_REDACTED";
const REVIEWED_OUTPUT_REASON_CODES = new Set([
  "SOURCE_SCHEMA_INVALID",
  "SYNTHETIC_FIXTURE_ONLY",
]);
const SYNTHETIC_MANIFEST_PATH = fileURLToPath(
  new URL("../../../tests/fixtures/import/synthetic-source-manifest.json", import.meta.url),
);

const sourceStates = new Set(["REGISTERED", "ACTIVE", "ARCHIVED_READ_ONLY"]);
const batchStates = new Set([
  "REGISTERED",
  "STAGED",
  "VALIDATED",
  "DRY_RUN_COMPLETE",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "RECONCILED",
  "REJECTED",
  "FAILED",
]);

export interface MigrationBatchCounts {
  total: string;
  staged: string;
  valid: string;
  rejected: string;
  quarantined: string;
  hidden: string;
  approved: string;
  imported: string;
  noOp: string;
}

export interface MigrationStatusSnapshot {
  inspectedAt: string;
  counts: {
    sources: string;
    batches: string;
    sourceLimit: string;
    batchLimit: string;
  };
  sources: readonly {
    sourceId: string;
    state: string;
    createdAt: string;
    updatedAt: string;
  }[];
  batches: readonly {
    batchId: string;
    sourceId: string;
    state: string;
    counts: MigrationBatchCounts;
    reasonCodes: readonly string[];
    createdAt: string;
    updatedAt: string;
    correlationId: string;
  }[];
}

export interface SyntheticManifestInspection {
  sourceId: string;
  batchId: string;
  state: string;
  counts: MigrationBatchCounts;
  reasonCodes: readonly string[];
  capturedAt: string;
  correlationId: string;
}

export interface MigrationCliDependencies {
  inspectStatus(databaseUrl: string): Promise<MigrationStatusSnapshot>;
  inspectSyntheticManifest(): Promise<SyntheticManifestInspection>;
}

export interface MigrationCliRequest {
  args: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  stdout(line: string): void;
  stderr(line: string): void;
  dependencies?: MigrationCliDependencies;
}

type SafeFailureCode =
  | "DEPLOYMENT_ENVIRONMENT_DENIED"
  | "NODE_ENVIRONMENT_DENIED"
  | "COMMAND_DENIED"
  | "DATABASE_CONFIGURATION_DENIED"
  | "READ_ONLY_ATTESTATION_FAILED"
  | "MIGRATION_LEDGER_MISMATCH"
  | "DATABASE_INSPECTION_DEADLINE"
  | "DATABASE_INSPECTION_FAILED"
  | "STATUS_RESULT_INVALID"
  | "SYNTHETIC_MANIFEST_INVALID";

class MigrationCliError extends Error {
  constructor(readonly reasonCode: SafeFailureCode) {
    super(reasonCode);
    this.name = "MigrationCliError";
  }
}

function safeFailure(reasonCode: SafeFailureCode): string {
  return JSON.stringify({ state: "DENIED", reasonCodes: [reasonCode] });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function safeCount(value: unknown): string {
  if (typeof value !== "string" || !COUNT_PATTERN.test(value)) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_POSTGRES_BIGINT) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return value;
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return value;
}

function safeIdentifier(value: unknown, allowSynthetic: boolean): string {
  if (
    typeof value !== "string" ||
    (!UUID_PATTERN.test(value) && !(allowSynthetic && SYNTHETIC_ID_PATTERN.test(value)))
  ) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return value;
}

function safeState(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return value;
}

function safeReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_REASON_CODES) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return value.map((reasonCode) =>
    typeof reasonCode === "string" && REVIEWED_OUTPUT_REASON_CODES.has(reasonCode)
      ? reasonCode
      : SAFE_REASON_CODE,
  );
}

function safeBatchCounts(value: unknown): MigrationBatchCounts {
  if (!isPlainRecord(value)) throw new MigrationCliError("STATUS_RESULT_INVALID");
  const counts: MigrationBatchCounts = {
    total: safeCount(value.total),
    staged: safeCount(value.staged),
    valid: safeCount(value.valid),
    rejected: safeCount(value.rejected),
    quarantined: safeCount(value.quarantined),
    hidden: safeCount(value.hidden),
    approved: safeCount(value.approved),
    imported: safeCount(value.imported),
    noOp: safeCount(value.noOp),
  };
  const partition =
    BigInt(counts.staged) +
    BigInt(counts.valid) +
    BigInt(counts.rejected) +
    BigInt(counts.quarantined) +
    BigInt(counts.hidden) +
    BigInt(counts.imported) +
    BigInt(counts.noOp);
  if (partition !== BigInt(counts.total)) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return counts;
}

function renderStatusSnapshot(value: unknown): string {
  if (!isPlainRecord(value)) throw new MigrationCliError("STATUS_RESULT_INVALID");
  const countsValue = value.counts;
  if (!isPlainRecord(countsValue)) throw new MigrationCliError("STATUS_RESULT_INVALID");
  const counts = {
    sources: safeCount(countsValue.sources),
    batches: safeCount(countsValue.batches),
    sourceLimit: safeCount(countsValue.sourceLimit),
    batchLimit: safeCount(countsValue.batchLimit),
  };
  if (counts.sourceLimit !== String(SOURCE_LIMIT) || counts.batchLimit !== String(BATCH_LIMIT)) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  if (
    !Array.isArray(value.sources) ||
    value.sources.length > SOURCE_LIMIT ||
    !Array.isArray(value.batches) ||
    value.batches.length > BATCH_LIMIT ||
    BigInt(counts.sources) < BigInt(value.sources.length) ||
    BigInt(counts.batches) < BigInt(value.batches.length)
  ) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }

  const sources = value.sources.map((source) => {
    if (!isPlainRecord(source)) throw new MigrationCliError("STATUS_RESULT_INVALID");
    return {
      sourceId: safeIdentifier(source.sourceId, false),
      state: safeState(source.state, sourceStates),
      createdAt: safeTimestamp(source.createdAt),
      updatedAt: safeTimestamp(source.updatedAt),
    };
  });
  const batches = value.batches.map((batch) => {
    if (!isPlainRecord(batch)) throw new MigrationCliError("STATUS_RESULT_INVALID");
    return {
      batchId: safeIdentifier(batch.batchId, false),
      sourceId: safeIdentifier(batch.sourceId, false),
      state: safeState(batch.state, batchStates),
      counts: safeBatchCounts(batch.counts),
      reasonCodes: safeReasonCodes(batch.reasonCodes),
      createdAt: safeTimestamp(batch.createdAt),
      updatedAt: safeTimestamp(batch.updatedAt),
      correlationId: safeIdentifier(batch.correlationId, false),
    };
  });

  return JSON.stringify({
    state: "READY",
    counts,
    sources,
    batches,
    timestamp: safeTimestamp(value.inspectedAt),
  });
}

function renderManifestInspection(value: unknown): string {
  if (!isPlainRecord(value)) throw new MigrationCliError("STATUS_RESULT_INVALID");
  return JSON.stringify({
    state: safeState(value.state, batchStates),
    counts: safeBatchCounts(value.counts),
    sourceId: safeIdentifier(value.sourceId, true),
    batchId: safeIdentifier(value.batchId, true),
    reasonCodes: safeReasonCodes(value.reasonCodes),
    timestamp: safeTimestamp(value.capturedAt),
    correlationId: safeIdentifier(value.correlationId, true),
  });
}

const manifestCountSchema = z
  .string()
  .regex(COUNT_PATTERN)
  .refine((value) => BigInt(value) <= MAX_POSTGRES_BIGINT);
const manifestSchema = z
  .object({
    fixture_kind: z.literal("SYNTHETIC_MIGRATION_SOURCE_MANIFEST"),
    schema_version: z.literal("1.0.0"),
    source_id: z.string().regex(/^synthetic-source-[a-z][a-z-]{0,63}$/),
    batch_id: z.string().regex(/^synthetic-batch-[a-z][a-z-]{0,63}$/),
    correlation_id: z.string().regex(/^synthetic-correlation-[a-z][a-z-]{0,63}$/),
    state: z.enum([
      "REGISTERED",
      "STAGED",
      "VALIDATED",
      "DRY_RUN_COMPLETE",
      "APPROVED",
      "APPLYING",
      "APPLIED",
      "RECONCILED",
      "REJECTED",
      "FAILED",
    ]),
    counts: z
      .object({
        total: manifestCountSchema,
        staged: manifestCountSchema,
        valid: manifestCountSchema,
        rejected: manifestCountSchema,
        quarantined: manifestCountSchema,
        hidden: manifestCountSchema,
        approved: manifestCountSchema,
        imported: manifestCountSchema,
        no_op: manifestCountSchema,
      })
      .strict(),
    reason_codes: z.array(z.string().regex(REASON_CODE_PATTERN)).max(MAX_REASON_CODES),
    captured_at: z.string().regex(ISO_TIMESTAMP_PATTERN),
  })
  .strict();

function parseSyntheticManifest(bytes: Buffer): SyntheticManifestInspection {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error("invalid manifest");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("invalid manifest");
  const parsed = manifestSchema.parse(JSON.parse(source) as unknown);
  const capturedAt = safeTimestamp(parsed.captured_at);
  const counts: MigrationBatchCounts = {
    total: parsed.counts.total,
    staged: parsed.counts.staged,
    valid: parsed.counts.valid,
    rejected: parsed.counts.rejected,
    quarantined: parsed.counts.quarantined,
    hidden: parsed.counts.hidden,
    approved: parsed.counts.approved,
    imported: parsed.counts.imported,
    noOp: parsed.counts.no_op,
  };
  safeBatchCounts(counts);
  return {
    sourceId: parsed.source_id,
    batchId: parsed.batch_id,
    state: parsed.state,
    counts,
    reasonCodes: parsed.reason_codes,
    capturedAt,
    correlationId: parsed.correlation_id,
  };
}

async function inspectSyntheticManifest(): Promise<SyntheticManifestInspection> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      SYNTHETIC_MANIFEST_PATH,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size < 1 || initial.size > MAX_MANIFEST_BYTES) {
      throw new Error("invalid manifest");
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_MANIFEST_BYTES || byteLength > initial.size) {
        throw new Error("invalid manifest");
      }
      chunks.push(bytes);
    }
    const final = await handle.stat();
    if (
      byteLength !== initial.size ||
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error("invalid manifest");
    }
    return parseSyntheticManifest(Buffer.concat(chunks, byteLength));
  } finally {
    await handle?.close();
  }
}

interface SourceStatusRow extends Record<string, unknown> {
  source_id: string;
  state: string;
  created_at: Date;
  updated_at: Date;
}

interface BatchStatusRow extends Record<string, unknown> {
  batch_id: string;
  source_id: string;
  state: string;
  total: string;
  staged: string;
  valid: string;
  rejected: string;
  quarantined: string;
  hidden: string;
  approved: string;
  imported: string;
  no_op: string;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

function databaseTimestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MigrationCliError("STATUS_RESULT_INVALID");
  }
  return value.toISOString();
}

async function awaitBoundedSettlement(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function inspectStatus(databaseUrl: string): Promise<MigrationStatusSnapshot> {
  let connectionUrl: URL;
  try {
    connectionUrl = new URL(databaseUrl);
  } catch {
    throw new MigrationCliError("DATABASE_CONFIGURATION_DENIED");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(connectionUrl.protocol)) {
    throw new MigrationCliError("DATABASE_CONFIGURATION_DENIED");
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
    max_lifetime: 30,
    prepare: false,
    onnotice: () => undefined,
  });
  let reserved: ReservedSql | undefined;
  let transactionOpen = false;
  let deadlineTriggered = false;
  const inspection = (async (): Promise<MigrationStatusSnapshot> => {
    try {
    reserved = await sql.reserve();
    await reserved.unsafe("begin isolation level repeatable read read only");
    transactionOpen = true;
    await reserved.unsafe("set local search_path = pg_catalog");
    await reserved.unsafe("set local lock_timeout = '1s'");
    await reserved.unsafe("set local statement_timeout = '5s'");
    await reserved.unsafe("set local idle_in_transaction_session_timeout = '10s'");

    const [readOnly] = await reserved<{ transaction_read_only: string }[]>`
      select pg_catalog.current_setting('transaction_read_only') as transaction_read_only
    `;
    if (readOnly?.transaction_read_only !== "on") {
      throw new MigrationCliError("READ_ONLY_ATTESTATION_FAILED");
    }

    const ledger = await reserved<{ filename: string; checksum: string }[]>`
      select filename, checksum
      from public.schema_migrations
      order by filename collate pg_catalog."C"
    `;
    try {
      assertMigrationLedgerCurrent(ledger);
    } catch {
      throw new MigrationCliError("MIGRATION_LEDGER_MISMATCH");
    }

    const [summary] = await reserved<
      { source_count: string; batch_count: string; inspected_at: Date }[]
    >`
      select
        (select pg_catalog.count(*)::pg_catalog.text from public.migration_sources) as source_count,
        (select pg_catalog.count(*)::pg_catalog.text from public.import_batches) as batch_count,
        pg_catalog.clock_timestamp() as inspected_at
    `;
    if (!summary) throw new MigrationCliError("STATUS_RESULT_INVALID");

    const sources = await reserved<SourceStatusRow[]>`
      select
        id::pg_catalog.text as source_id,
        status as state,
        created_at,
        updated_at
      from public.migration_sources
      order by updated_at desc, id
      limit ${SOURCE_LIMIT}
    `;
    const batches = await reserved<BatchStatusRow[]>`
      select
        id::pg_catalog.text as batch_id,
        migration_source_id::pg_catalog.text as source_id,
        status as state,
        total_row_count::pg_catalog.text as total,
        staged_row_count::pg_catalog.text as staged,
        valid_row_count::pg_catalog.text as valid,
        rejected_row_count::pg_catalog.text as rejected,
        quarantined_row_count::pg_catalog.text as quarantined,
        hidden_row_count::pg_catalog.text as hidden,
        approved_row_count::pg_catalog.text as approved,
        imported_row_count::pg_catalog.text as imported,
        no_op_row_count::pg_catalog.text as no_op,
        failure_code,
        created_at,
        updated_at
      from public.import_batches
      order by updated_at desc, id
      limit ${BATCH_LIMIT}
    `;

    await reserved.unsafe("commit");
    transactionOpen = false;
    return {
      inspectedAt: databaseTimestamp(summary.inspected_at),
      counts: {
        sources: summary.source_count,
        batches: summary.batch_count,
        sourceLimit: String(SOURCE_LIMIT),
        batchLimit: String(BATCH_LIMIT),
      },
      sources: sources.map((source) => ({
        sourceId: source.source_id,
        state: source.state,
        createdAt: databaseTimestamp(source.created_at),
        updatedAt: databaseTimestamp(source.updated_at),
      })),
      batches: batches.map((batch) => ({
        batchId: batch.batch_id,
        sourceId: batch.source_id,
        state: batch.state,
        counts: {
          total: batch.total,
          staged: batch.staged,
          valid: batch.valid,
          rejected: batch.rejected,
          quarantined: batch.quarantined,
          hidden: batch.hidden,
          approved: batch.approved,
          imported: batch.imported,
          noOp: batch.no_op,
        },
        reasonCodes: batch.failure_code === null ? [] : [batch.failure_code],
        createdAt: databaseTimestamp(batch.created_at),
        updatedAt: databaseTimestamp(batch.updated_at),
        correlationId: batch.batch_id,
      })),
    };
    } catch (error: unknown) {
      if (!deadlineTriggered && transactionOpen && reserved) {
        try {
          await reserved.unsafe("rollback");
        } catch {
          // The public boundary emits only a fixed safe reason code.
        }
      }
      if (deadlineTriggered) {
        throw new MigrationCliError("DATABASE_INSPECTION_DEADLINE");
      }
      if (error instanceof MigrationCliError) throw error;
      throw new MigrationCliError("DATABASE_INSPECTION_FAILED");
    } finally {
      try {
        reserved?.release();
      } catch {
        // A failed release is contained by the bounded client shutdown below.
      }
      try {
        await sql.end({ timeout: 1 });
      } catch {
        // The command has no safe diagnostic detail to expose for cleanup failures.
      }
    }
  })();

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineTriggered = true;
      resolve();
    }, STATUS_DEADLINE_MS);
  });

  try {
    const outcome = await Promise.race([
      inspection.then(
        (snapshot) => ({ kind: "snapshot" as const, snapshot }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      deadline.then(() => ({ kind: "deadline" as const })),
    ]);
    if (outcome.kind === "snapshot") return outcome.snapshot;
    if (outcome.kind === "error") throw outcome.error;

    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    let forcedTeardown: Promise<unknown>;
    try {
      forcedTeardown = Promise.resolve(sql.end({ timeout: 0 }));
    } catch (error) {
      forcedTeardown = Promise.reject(error);
    }
    await awaitBoundedSettlement(
      Promise.allSettled([forcedTeardown, inspection]),
      STATUS_CLEANUP_GRACE_MS,
    );
    throw new MigrationCliError("DATABASE_INSPECTION_DEADLINE");
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

const defaultDependencies: MigrationCliDependencies = Object.freeze({
  inspectStatus,
  inspectSyntheticManifest,
});

export async function runMigrationCli(request: MigrationCliRequest): Promise<number> {
  const deploymentEnvironment = request.environment.DEPLOYMENT_ENVIRONMENT;
  if (
    typeof deploymentEnvironment !== "string" ||
    !ALLOWED_DEPLOYMENTS.has(deploymentEnvironment)
  ) {
    request.stderr(safeFailure("DEPLOYMENT_ENVIRONMENT_DENIED"));
    return 1;
  }

  const nodeEnvironment = request.environment.NODE_ENV;
  if (
    nodeEnvironment !== undefined &&
    (typeof nodeEnvironment !== "string" || !ALLOWED_NODE_ENVIRONMENTS.has(nodeEnvironment))
  ) {
    request.stderr(safeFailure("NODE_ENVIRONMENT_DENIED"));
    return 1;
  }

  if (
    request.args.length !== 1 ||
    typeof request.args[0] !== "string" ||
    !ALLOWED_COMMANDS.has(request.args[0])
  ) {
    request.stderr(safeFailure("COMMAND_DENIED"));
    return 1;
  }

  const dependencies = request.dependencies ?? defaultDependencies;
  if (request.args[0] === "status") {
    const databaseUrl = request.environment.DATABASE_URL;
    if (typeof databaseUrl !== "string" || databaseUrl.length < 1) {
      request.stderr(safeFailure("DATABASE_CONFIGURATION_DENIED"));
      return 1;
    }
    try {
      const snapshot = await dependencies.inspectStatus(databaseUrl);
      request.stdout(renderStatusSnapshot(snapshot));
      return 0;
    } catch (error: unknown) {
      const reasonCode =
        error instanceof MigrationCliError ? error.reasonCode : "DATABASE_INSPECTION_FAILED";
      request.stderr(safeFailure(reasonCode));
      return 1;
    }
  }

  try {
    const inspection = await dependencies.inspectSyntheticManifest();
    request.stdout(renderManifestInspection(inspection));
    return 0;
  } catch {
    request.stderr(safeFailure("SYNTHETIC_MANIFEST_INVALID"));
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  void runMigrationCli({
    args: process.argv.slice(2),
    environment: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
