import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPECTED_RELEASE_MIGRATIONS,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PLATFORM,
  RELEASE_SURFACES,
  RELEASE_SYFT_VERSION,
  RUNTIME_BASE_IMAGE,
  assertSourceSha,
  canonicalJson,
  parseStrictJsonBytes,
  sha256Digest,
} from "./release-image-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const dockerCommand = "docker";
const postgresImage =
  "postgres:16.14-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const probeImage =
  "node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const sourceRepository = "https://github.com/AqmalJupri/crmsalessalamland";
const databaseName = "crm_salam_codex_migration_platform";
const databaseUser = "crm";
const requiredEvidence = Object.freeze({
  image: Object.freeze({ name: "image.oci.tar", limit: 4 * 1024 * 1024 * 1024 }),
  imageMetadata: Object.freeze({ name: "image-metadata.json", limit: 64 * 1024 }),
  ledger: Object.freeze({ name: "migration-ledger.json", limit: 64 * 1024 }),
  sbomBinding: Object.freeze({ name: "sbom-binding.json", limit: 64 * 1024 }),
  cyclonedx: Object.freeze({ name: "sbom.cdx.json", limit: 64 * 1024 * 1024 }),
  spdx: Object.freeze({ name: "sbom.spdx.json", limit: 64 * 1024 * 1024 }),
  scan: Object.freeze({ name: "scan-report.json", limit: 64 * 1024 * 1024 }),
  trivyReport: Object.freeze({ name: "trivy-raw.json", limit: 64 * 1024 * 1024 }),
  trivySecretReport: Object.freeze({
    name: "trivy-secret-raw.json",
    limit: 64 * 1024 * 1024,
  }),
  trivyVersion: Object.freeze({ name: "trivy-version.json", limit: 64 * 1024 }),
  policy: Object.freeze({ name: "policy.json", limit: 1024 * 1024 }),
  manifest: Object.freeze({ name: "release-manifest.json", limit: 1024 * 1024 }),
});
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const outputLimit = 1024 * 1024;

export class ReleaseImageSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseImageSmokeError";
    this.code = code;
  }
}

export class ReleaseImageSmokeInterruptedError extends ReleaseImageSmokeError {
  constructor(signal) {
    super(`RELEASE_IMAGE_SMOKE_INTERRUPTED_${signal}`);
    this.name = "ReleaseImageSmokeInterruptedError";
    this.signal = signal;
  }
}

function fail(code) {
  throw new ReleaseImageSmokeError(code);
}

function positiveInteger(value, fallback, code) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) fail(code);
  return candidate;
}

function isPlainRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected, code = "MANIFEST_CONTRACT_INVALID") {
  if (!isPlainRecord(value)) fail(code);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
  return value;
}

function parseJson(bytes, code) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { source, value: parseStrictJsonBytes(bytes, code) };
  } catch (error) {
    if (error instanceof ReleaseImageSmokeError) throw error;
    fail(code);
  }
}

async function readRegularFile(path, limit, code) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) fail(code);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    ) {
      fail("EVIDENCE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseImageSmokeError) throw error;
    fail(code);
  } finally {
    await handle?.close();
  }
}

async function hashRegularFile(path, limit, code) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) fail(code);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength;
      if (size > limit) fail(code);
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    ) {
      fail("EVIDENCE_CHANGED");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch (error) {
    if (error instanceof ReleaseImageSmokeError) throw error;
    fail(code);
  } finally {
    await handle?.close();
  }
}

async function assertRegularFile(path, limit, code) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > limit) fail(code);
  } catch (error) {
    if (error instanceof ReleaseImageSmokeError) throw error;
    fail(code);
  } finally {
    await handle?.close();
  }
}

async function assertRegularDirectory(path, code) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
    return await realpath(path);
  } catch (error) {
    if (error instanceof ReleaseImageSmokeError) throw error;
    fail(code);
  }
}

function assertDigest(value) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  return value;
}

function assertLedger(entries) {
  if (!Array.isArray(entries) || entries.length !== EXPECTED_RELEASE_MIGRATIONS.length) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  return entries.map((entry, index) => {
    exactKeys(entry, ["filename", "checksum"]);
    const expected = EXPECTED_RELEASE_MIGRATIONS[index];
    if (entry.filename !== expected.filename || entry.checksum !== expected.checksum) {
      fail("MANIFEST_CONTRACT_INVALID");
    }
    return { filename: entry.filename, checksum: entry.checksum };
  });
}

function validateManifest(manifest, source, surface) {
  exactKeys(manifest, [
    "schemaVersion",
    "sourceSha",
    "surface",
    "appVersion",
    "baseImageDigest",
    "baseImagePlatformDigest",
    "platform",
    "image",
    "migrationLedger",
    "sboms",
    "scan",
  ]);
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    manifest.sourceSha !== source ||
    manifest.appVersion !== source ||
    manifest.surface !== surface
  ) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  assertDigest(manifest.baseImageDigest);
  assertDigest(manifest.baseImagePlatformDigest);
  if (
    manifest.baseImageDigest !== RUNTIME_BASE_IMAGE.indexDigest ||
    manifest.baseImagePlatformDigest !== RUNTIME_BASE_IMAGE.platformDigest
  ) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  exactKeys(manifest.platform, ["os", "architecture"]);
  if (manifest.platform.os !== "linux" || manifest.platform.architecture !== "amd64") {
    fail("MANIFEST_CONTRACT_INVALID");
  }

  exactKeys(manifest.image, ["reference", "manifestDigest", "configDigest", "artifactSha256"]);
  const manifestDigest = assertDigest(manifest.image.manifestDigest);
  assertDigest(manifest.image.configDigest);
  assertDigest(manifest.image.artifactSha256);
  if (
    typeof manifest.image.reference !== "string" ||
    !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(manifest.image.reference) ||
    !manifest.image.reference.endsWith(`@${manifestDigest}`)
  ) {
    fail("MANIFEST_CONTRACT_INVALID");
  }

  exactKeys(manifest.migrationLedger, ["entryCount", "sha256", "entries"]);
  assertDigest(manifest.migrationLedger.sha256);
  const ledger = assertLedger(manifest.migrationLedger.entries);
  if (manifest.migrationLedger.entryCount !== ledger.length) fail("MANIFEST_CONTRACT_INVALID");

  exactKeys(manifest.sboms, ["binding", "cyclonedx", "spdx"]);
  exactKeys(manifest.sboms.binding, ["filename", "sha256"]);
  exactKeys(manifest.sboms.cyclonedx, ["filename", "sha256"]);
  exactKeys(manifest.sboms.spdx, ["filename", "sha256"]);
  if (
    manifest.sboms.binding.filename !== requiredEvidence.sbomBinding.name ||
    manifest.sboms.cyclonedx.filename !== requiredEvidence.cyclonedx.name ||
    manifest.sboms.spdx.filename !== requiredEvidence.spdx.name
  ) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  assertDigest(manifest.sboms.binding.sha256);
  assertDigest(manifest.sboms.cyclonedx.sha256);
  assertDigest(manifest.sboms.spdx.sha256);

  exactKeys(manifest.scan, [
    "result",
    "evaluatedAt",
    "reportSha256",
    "rawReportSha256",
    "secretReportSha256",
    "versionReportSha256",
    "scanner",
    "policy",
    "vulnerabilityDatabase",
  ]);
  if (manifest.scan.result !== "pass") fail("MANIFEST_CONTRACT_INVALID");
  assertDigest(manifest.scan.reportSha256);
  assertDigest(manifest.scan.rawReportSha256);
  assertDigest(manifest.scan.secretReportSha256);
  assertDigest(manifest.scan.versionReportSha256);
  exactKeys(manifest.scan.scanner, ["engine", "version"]);
  exactKeys(manifest.scan.policy, ["version", "sha256"]);
  exactKeys(manifest.scan.vulnerabilityDatabase, [
    "source",
    "version",
    "updatedAt",
    "nextUpdate",
    "downloadedAt",
    "sha256",
  ]);
  if (
    typeof manifest.scan.evaluatedAt !== "string" ||
    typeof manifest.scan.scanner.engine !== "string" ||
    typeof manifest.scan.scanner.version !== "string" ||
    typeof manifest.scan.policy.version !== "string" ||
    typeof manifest.scan.vulnerabilityDatabase.source !== "string" ||
    typeof manifest.scan.vulnerabilityDatabase.version !== "string" ||
    manifest.scan.vulnerabilityDatabase.source !==
      "ghcr.io/aquasecurity/trivy-db:2" ||
    typeof manifest.scan.vulnerabilityDatabase.updatedAt !== "string" ||
    typeof manifest.scan.vulnerabilityDatabase.nextUpdate !== "string" ||
    typeof manifest.scan.vulnerabilityDatabase.downloadedAt !== "string"
  ) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  assertDigest(manifest.scan.policy.sha256);
  assertDigest(manifest.scan.vulnerabilityDatabase.sha256);
  return { manifest, ledger };
}

function validateSbomBinding(binding, source, manifest, surface, sourceSha, digests) {
  exactKeys(
    binding,
    ["schemaVersion", "sourceSha", "surface", "syft", "image", "sboms"],
    "EVIDENCE_CONTENT_INVALID",
  );
  if (
    source !== canonicalJson(binding) ||
    binding.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    binding.sourceSha !== sourceSha ||
    binding.surface !== surface
  ) {
    fail("EVIDENCE_CONTENT_INVALID");
  }

  exactKeys(
    binding.syft,
    ["version", "command", "source", "platform", "sourceName", "sourceVersion"],
    "EVIDENCE_CONTENT_INVALID",
  );
  if (
    binding.syft.version !== RELEASE_SYFT_VERSION ||
    binding.syft.command !== "scan" ||
    binding.syft.source !== `oci-archive:${requiredEvidence.image.name}` ||
    binding.syft.platform !== `${RELEASE_PLATFORM.os}/${RELEASE_PLATFORM.architecture}` ||
    binding.syft.sourceName !== surface ||
    binding.syft.sourceVersion !== sourceSha
  ) {
    fail("EVIDENCE_CONTENT_INVALID");
  }

  exactKeys(
    binding.image,
    ["manifestDigest", "configDigest", "artifactSha256"],
    "EVIDENCE_CONTENT_INVALID",
  );
  if (
    binding.image.manifestDigest !== manifest.image.manifestDigest ||
    binding.image.configDigest !== manifest.image.configDigest ||
    binding.image.artifactSha256 !== manifest.image.artifactSha256
  ) {
    fail("EVIDENCE_CONTENT_INVALID");
  }

  exactKeys(binding.sboms, ["cyclonedx", "spdx"], "EVIDENCE_CONTENT_INVALID");
  const expectedSboms = {
    cyclonedx: {
      filename: requiredEvidence.cyclonedx.name,
      format: "cyclonedx-json",
      specVersion: "1.6",
      sha256: digests.cyclonedx,
    },
    spdx: {
      filename: requiredEvidence.spdx.name,
      format: "spdx-json",
      specVersion: "2.3",
      sha256: digests.spdx,
    },
  };
  for (const name of ["cyclonedx", "spdx"]) {
    exactKeys(
      binding.sboms[name],
      ["filename", "format", "specVersion", "sha256"],
      "EVIDENCE_CONTENT_INVALID",
    );
    if (
      Object.keys(expectedSboms[name]).some(
        (key) => binding.sboms[name][key] !== expectedSboms[name][key],
      )
    ) {
      fail("EVIDENCE_CONTENT_INVALID");
    }
  }
}

async function preflight(input) {
  if (!RELEASE_SURFACES.includes(input.surface)) {
    fail("RELEASE_IMAGE_SMOKE_ARGUMENTS");
  }
  try {
    assertSourceSha(input.sourceSha, "RELEASE_IMAGE_SMOKE_ARGUMENTS");
  } catch {
    fail("RELEASE_IMAGE_SMOKE_ARGUMENTS");
  }
  const evidenceDirectory = resolve(input.evidenceDirectory ?? "");
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(evidenceDirectory);
  } catch {
    fail("EVIDENCE_MISSING");
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail("EVIDENCE_PATH_INVALID");
  }
  const canonicalDirectory = await realpath(evidenceDirectory);
  const databaseDumpPath = resolve(input.databaseDumpPath ?? "");
  if (basename(databaseDumpPath) !== "crm_salam_codex_migration_platform.dump") {
    fail("DATABASE_DUMP_INVALID");
  }
  await assertRegularFile(databaseDumpPath, 8 * 1024 * 1024 * 1024, "DATABASE_DUMP_INVALID");
  const runtimeSmokeDirectory = await assertRegularDirectory(
    join(repositoryRoot, "tests/production"),
    "RUNTIME_SMOKE_INPUT_MISSING",
  );
  const nodeModulesDirectory = await assertRegularDirectory(
    join(repositoryRoot, "node_modules"),
    "RUNTIME_SMOKE_DEPENDENCIES_MISSING",
  );
  try {
    await realpath(join(nodeModulesDirectory, "jsdom"));
  } catch {
    fail("RUNTIME_SMOKE_DEPENDENCIES_MISSING");
  }

  const values = {};
  for (const [key, evidence] of Object.entries(requiredEvidence)) {
    const path = join(canonicalDirectory, evidence.name);
    values[key] = key === "image"
      ? await hashRegularFile(path, evidence.limit, "EVIDENCE_MISSING")
      : await readRegularFile(path, evidence.limit, "EVIDENCE_MISSING");
  }
  const parsedManifest = parseJson(values.manifest, "MANIFEST_CONTRACT_INVALID");
  if (parsedManifest.source !== canonicalJson(parsedManifest.value)) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  const { manifest, ledger } = validateManifest(
    parsedManifest.value,
    input.sourceSha,
    input.surface,
  );

  const parsedLedger = parseJson(values.ledger, "MANIFEST_CONTRACT_INVALID").value;
  exactKeys(parsedLedger, ["schemaVersion", "entries"]);
  if (parsedLedger.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    fail("MANIFEST_CONTRACT_INVALID");
  }
  const evidenceLedger = assertLedger(parsedLedger.entries);
  if (JSON.stringify(evidenceLedger) !== JSON.stringify(ledger)) {
    fail("MANIFEST_CONTRACT_INVALID");
  }

  const digests = {
    image: values.image,
    ledger: sha256Digest(values.ledger),
    sbomBinding: sha256Digest(values.sbomBinding),
    cyclonedx: sha256Digest(values.cyclonedx),
    spdx: sha256Digest(values.spdx),
    scan: sha256Digest(values.scan),
    trivyReport: sha256Digest(values.trivyReport),
    trivySecretReport: sha256Digest(values.trivySecretReport),
    trivyVersion: sha256Digest(values.trivyVersion),
    policy: sha256Digest(values.policy),
  };
  if (
    digests.image !== manifest.image.artifactSha256 ||
    digests.ledger !== manifest.migrationLedger.sha256 ||
    digests.sbomBinding !== manifest.sboms.binding.sha256 ||
    digests.cyclonedx !== manifest.sboms.cyclonedx.sha256 ||
    digests.spdx !== manifest.sboms.spdx.sha256 ||
    digests.scan !== manifest.scan.reportSha256 ||
    digests.trivyReport !== manifest.scan.rawReportSha256 ||
    digests.trivySecretReport !== manifest.scan.secretReportSha256 ||
    digests.trivyVersion !== manifest.scan.versionReportSha256 ||
    digests.policy !== manifest.scan.policy.sha256
  ) {
    fail("EVIDENCE_DIGEST_MISMATCH");
  }
  const imageMetadata = parseJson(
    values.imageMetadata,
    "EVIDENCE_CONTENT_INVALID",
  ).value;
  exactKeys(imageMetadata, [
    "schemaVersion",
    "sourceSha",
    "surface",
    "appVersion",
    "baseImageDigest",
    "baseImagePlatformDigest",
    "platform",
    "imageReference",
    "imageManifestDigest",
    "imageConfigDigest",
    "imageArtifactSha256",
  ], "EVIDENCE_CONTENT_INVALID");
  if (
    imageMetadata.schemaVersion !== manifest.schemaVersion ||
    imageMetadata.sourceSha !== manifest.sourceSha ||
    imageMetadata.surface !== manifest.surface ||
    imageMetadata.appVersion !== manifest.appVersion ||
    imageMetadata.baseImageDigest !== manifest.baseImageDigest ||
    imageMetadata.baseImagePlatformDigest !== manifest.baseImagePlatformDigest ||
    JSON.stringify(imageMetadata.platform) !== JSON.stringify(manifest.platform) ||
    imageMetadata.imageReference !== manifest.image.reference ||
    imageMetadata.imageManifestDigest !== manifest.image.manifestDigest ||
    imageMetadata.imageConfigDigest !== manifest.image.configDigest ||
    imageMetadata.imageArtifactSha256 !== manifest.image.artifactSha256
  ) {
    fail("EVIDENCE_CONTENT_INVALID");
  }
  const cyclonedx = parseJson(values.cyclonedx, "EVIDENCE_CONTENT_INVALID").value;
  const spdx = parseJson(values.spdx, "EVIDENCE_CONTENT_INVALID").value;
  const sbomBinding = parseJson(values.sbomBinding, "EVIDENCE_CONTENT_INVALID");
  const scan = parseJson(values.scan, "EVIDENCE_CONTENT_INVALID").value;
  if (
    !isPlainRecord(cyclonedx) ||
    cyclonedx.bomFormat !== "CycloneDX" ||
    !isPlainRecord(cyclonedx.metadata) ||
    !isPlainRecord(cyclonedx.metadata.component) ||
    cyclonedx.metadata.component.name !== input.surface ||
    cyclonedx.metadata.component.version !== input.sourceSha ||
    !isPlainRecord(spdx) ||
    spdx.spdxVersion !== "SPDX-2.3" ||
    spdx.name !== input.surface ||
    !isPlainRecord(scan) ||
    scan.sourceSha !== input.sourceSha ||
    scan.surface !== input.surface ||
    scan.result !== "pass"
  ) {
    fail("EVIDENCE_CONTENT_INVALID");
  }
  validateSbomBinding(
    sbomBinding.value,
    sbomBinding.source,
    manifest,
    input.surface,
    input.sourceSha,
    digests,
  );
  return {
    databaseDumpPath,
    evidenceDirectory: canonicalDirectory,
    imageArchivePath: join(canonicalDirectory, requiredEvidence.image.name),
    imageArtifactSha256: digests.image,
    ledger,
    manifest,
    nodeModulesDirectory,
    runtimeSmokeDirectory,
  };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function createDockerCommandRunner() {
  return Object.freeze({
    run(command, args, options = {}) {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, {
          detached: process.platform !== "win32",
          env: { ...process.env, ...(options.env ?? {}) },
          shell: false,
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let forceKill;
        let terminationReason = null;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(forceKill);
          options.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const terminate = (reason) => {
          if (terminationReason) return;
          terminationReason = reason;
          if (!child.pid) {
            finish(() => rejectRun(reason));
            return;
          }
          if (process.platform === "win32") child.kill("SIGTERM");
          else signalGroup(child.pid, "SIGTERM");
          forceKill = setTimeout(() => {
            if (process.platform === "win32") child.kill("SIGKILL");
            else signalGroup(child.pid, "SIGKILL");
          }, 1_000);
          forceKill.unref();
        };
        const timeout = options.timeoutMs
          ? setTimeout(() => {
              terminate(new ReleaseImageSmokeError("COMMAND_TIMEOUT"));
            }, options.timeoutMs)
          : undefined;
        timeout?.unref();
        const onAbort = () => {
          terminate(options.signal?.reason ?? new ReleaseImageSmokeError("COMMAND_ABORTED"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => {
          stdout = Buffer.concat([stdout, chunk]);
          if (stdout.byteLength > outputLimit) {
            terminate(new ReleaseImageSmokeError("COMMAND_OUTPUT_BOUNDS"));
          }
        });
        child.stderr?.on("data", (chunk) => {
          stderr = Buffer.concat([stderr, chunk]);
          if (stderr.byteLength > outputLimit) {
            terminate(new ReleaseImageSmokeError("COMMAND_OUTPUT_BOUNDS"));
          }
        });
        child.once("error", () => finish(() => rejectRun(new ReleaseImageSmokeError("COMMAND_SPAWN_FAILED"))));
        child.once("exit", (code, signal) => finish(() => {
          if (terminationReason) {
            rejectRun(terminationReason);
            return;
          }
          if (code !== 0) {
            rejectRun(new ReleaseImageSmokeError(signal ? "COMMAND_SIGNALLED" : "COMMAND_FAILED"));
            return;
          }
          resolveRun({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
        }));
        if (options.stdin !== undefined) child.stdin?.end(options.stdin);
        if (options.signal?.aborted) onAbort();
      });
    },
  });
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      rejectDelay(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function boundedSignal(signal, timeoutMs, timeoutCode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ReleaseImageSmokeError(timeoutCode)), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function runDocker(context, args, failureCode, timeoutCode = `${failureCode}_TIMEOUT`, timeoutMs = 30_000) {
  const bounded = boundedSignal(context.signal, timeoutMs, timeoutCode);
  try {
    return await context.runner.run(dockerCommand, args, { signal: bounded.signal });
  } catch (error) {
    if (error instanceof ReleaseImageSmokeInterruptedError) throw error;
    if (error instanceof ReleaseImageSmokeError && error.code === timeoutCode) throw error;
    if (bounded.signal.aborted && bounded.signal.reason instanceof ReleaseImageSmokeInterruptedError) {
      throw bounded.signal.reason;
    }
    if (bounded.signal.aborted && bounded.signal.reason instanceof ReleaseImageSmokeError) {
      throw bounded.signal.reason;
    }
    fail(failureCode);
  } finally {
    bounded.close();
  }
}

async function tryDocker(context, args, timeoutMs = 5_000) {
  const bounded = boundedSignal(context.signal, timeoutMs, "DOCKER_PROBE_TIMEOUT");
  try {
    return await context.runner.run(dockerCommand, args, { signal: bounded.signal });
  } finally {
    bounded.close();
  }
}

async function waitDatabase(context) {
  const deadline = Date.now() + context.readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      await tryDocker(context, [
        "exec",
        context.databaseContainer,
        "pg_isready",
        "--username=postgres",
        "--dbname=postgres",
      ]);
      return;
    } catch {
      await delay(context.pollIntervalMs, context.signal);
    }
  }
  fail("DATABASE_READINESS_FAILED");
}

async function waitApp(context, baseUrl) {
  const deadline = Date.now() + context.readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (context.signal.aborted) throw context.signal.reason;
    const remaining = Math.max(1, deadline - Date.now());
    const bounded = boundedSignal(
      context.signal,
      Math.min(2_000, remaining),
      "APP_READINESS_PROBE_TIMEOUT",
    );
    try {
      const aborted = new Promise((_, reject) => {
        bounded.signal.addEventListener(
          "abort",
          () => reject(bounded.signal.reason),
          { once: true },
        );
      });
      const response = await Promise.race([
        context.fetchImpl(`${baseUrl}/api/health/ready`, {
          cache: "no-store",
          redirect: "manual",
          signal: bounded.signal,
        }),
        aborted,
      ]);
      if (response.status === 200) return;
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
    } finally {
      bounded.close();
    }
    await delay(context.pollIntervalMs, context.signal);
  }
  fail("APP_READINESS_FAILED");
}

function parseImageInspection(source, manifest) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("IMAGE_INSPECTION_INVALID");
  }
  if (!Array.isArray(value) || value.length !== 1 || !isPlainRecord(value[0])) {
    fail("IMAGE_INSPECTION_INVALID");
  }
  const image = value[0];
  const labels = image.Config?.Labels;
  if (
    image.Id !== manifest.image.configDigest ||
    image.Config?.User !== "65532:65532" ||
    labels?.["org.opencontainers.image.source"] !== sourceRepository ||
    labels?.["org.opencontainers.image.revision"] !== manifest.sourceSha ||
    labels?.["org.opencontainers.image.version"] !== manifest.appVersion ||
    labels?.["com.salamland.product-surface"] !== manifest.surface
  ) {
    fail("IMAGE_INSPECTION_MISMATCH");
  }
}

function privateContainerAddress(value) {
  const address = value.trim();
  if (!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}$/.test(address)) {
    fail("DATABASE_NETWORK_INVALID");
  }
  return address;
}

function publishedBaseUrl(value) {
  const match = value.trim().match(/^127\.0\.0\.1:(\d{4,5})$/);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 10_000 || port > 65_535) {
    fail("APP_PORT_INVALID");
  }
  return `http://127.0.0.1:${port}`;
}

function appEnvironment(context, databaseAddress) {
  const appUrl = context.surface === "crm"
    ? "https://crm-ci.example.test"
    : "https://tasha-ci.example.test";
  const clientId = context.surface === "crm" ? "crm-ci" : "tasha-ci";
  const databaseUrl = `postgresql://${databaseUser}:${encodeURIComponent(context.databasePassword)}@${databaseAddress}:5432/${databaseName}`;
  return {
    APP_URL: appUrl,
    APP_VERSION: context.sourceSha,
    AUTH_HASH_KEY: randomBytes(32).toString("hex"),
    CRM_DEMO_MODE: "false",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "4",
    DEPLOYMENT_ENVIRONMENT: "ci",
    HOSTNAME: "0.0.0.0",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: randomBytes(24).toString("hex"),
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_REDIRECT_URI: `${appUrl}/api/v1/auth/oidc/callback`,
    PORT: "3000",
    PRODUCT_SURFACE: context.surface,
  };
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function assertNetworkInspection(source, context) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("NETWORK_MEMBERSHIP_INVALID");
  }
  const network = Array.isArray(value) && value.length === 1 ? value[0] : null;
  const containers = isPlainRecord(network?.Containers)
    ? Object.values(network.Containers).map((entry) => entry?.Name).sort()
    : [];
  if (
    network?.Internal !== true ||
    JSON.stringify(containers) !== JSON.stringify([
      context.appContainer,
      context.databaseContainer,
    ].sort())
  ) {
    fail("NETWORK_MEMBERSHIP_INVALID");
  }
}

const egressProbe = String.raw`
import { promises as dns } from "node:dns";
import { connect } from "node:net";
const blocked = ["93.184.216.34", "169.254.169.254", "192.168.1.1"];
const socketProbe = (host) => new Promise((resolve, reject) => {
  const socket = connect({ host, port: 80 });
  const finish = (allowed) => { socket.destroy(); allowed ? reject(new Error("egress")) : resolve(); };
  socket.setTimeout(750, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});
await Promise.all([
  dns.lookup("example.com").then(() => { throw new Error("dns"); }, () => undefined),
  ...blocked.map(socketProbe),
]);
`;

async function runProductionSmoke(context, appAddress, environment) {
  await runDocker(context, [
    "run",
    "--name",
    context.probeContainer,
    "--network",
    context.network,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1.0",
    "--user",
    "10001:10001",
    "--dns",
    "127.0.0.1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    "--mount",
    `type=bind,src=${context.runtimeSmokeDirectory},dst=/probe/tests,readonly`,
    "--mount",
    `type=bind,src=${context.nodeModulesDirectory},dst=/probe/node_modules,readonly`,
    "--workdir",
    "/probe/tests",
    "--pull",
    "always",
    "--env",
    `PRODUCTION_SMOKE_URL=http://${appAddress}:3000`,
    "--env",
    `DATABASE_URL=${environment.DATABASE_URL}`,
    "--env",
    `PRODUCT_SURFACE=${context.surface}`,
    "--env",
    "HOME=/tmp",
    probeImage,
    "node",
    "/probe/tests/runtime-smoke.mjs",
  ], "RUNTIME_SMOKE_FAILED", "RUNTIME_SMOKE_TIMEOUT", context.smokeTimeoutMs);
  await runDocker(
    context,
    ["rm", "--force", context.probeContainer],
    "PROBE_CLEANUP_FAILED",
  );
  const network = await runDocker(
    context,
    ["network", "inspect", context.network],
    "NETWORK_MEMBERSHIP_INVALID",
  );
  assertNetworkInspection(network.stdout, context);
}

async function cleanup(context, primaryError) {
  const errors = [];
  for (const [listArgs, removeArgs] of [
    [["container", "ls", "--all", "--quiet", "--filter", `name=^/${context.probeContainer}$`], ["rm", "--force", context.probeContainer]],
    [["container", "ls", "--all", "--quiet", "--filter", `name=^/${context.appContainer}$`], ["rm", "--force", context.appContainer]],
    [["container", "ls", "--all", "--quiet", "--filter", `name=^/${context.databaseContainer}$`], ["rm", "--force", context.databaseContainer]],
    [["network", "ls", "--quiet", "--filter", `name=^${context.network}$`], ["network", "rm", context.network]],
  ]) {
    let matches;
    try {
      const result = await context.runner.run(dockerCommand, listArgs, { timeoutMs: 10_000 });
      matches = result.stdout.trim().split("\n").filter(Boolean);
    } catch {
      errors.push(new ReleaseImageSmokeError("CLEANUP_FAILED"));
      continue;
    }
    if (matches.length === 0) continue;
    if (matches.length !== 1 || !/^[a-f0-9]{12,64}$/.test(matches[0])) {
      errors.push(new ReleaseImageSmokeError("CLEANUP_FAILED"));
      continue;
    }
    try {
      await context.runner.run(dockerCommand, removeArgs, { timeoutMs: 10_000 });
    } catch {
      errors.push(new ReleaseImageSmokeError("CLEANUP_FAILED"));
    }
  }
  if (primaryError && errors.length) {
    throw new AggregateError([primaryError, ...errors], primaryError.message);
  }
  if (primaryError) throw primaryError;
  if (errors.length) throw new AggregateError(errors, "CLEANUP_FAILED");
}

function normalizedContext(input, evidence) {
  return {
    ...evidence,
    appContainer: `crm-smoke-app-${randomUUID()}`,
    databaseContainer: `crm-smoke-db-${randomUUID()}`,
    databasePassword: randomBytes(24).toString("hex"),
    databaseSuperuserPassword: randomBytes(24).toString("hex"),
    fetchImpl: input.fetchImpl ?? fetch,
    network: `crm-smoke-net-${randomUUID()}`,
    pollIntervalMs: positiveInteger(input.pollIntervalMs, 250, "RELEASE_IMAGE_SMOKE_ARGUMENTS"),
    probeContainer: `crm-smoke-probe-${randomUUID()}`,
    readinessTimeoutMs: positiveInteger(input.readinessTimeoutMs, 60_000, "RELEASE_IMAGE_SMOKE_ARGUMENTS"),
    runner: input.runner ?? createDockerCommandRunner(),
    signal: input.signal ?? new AbortController().signal,
    smokeTimeoutMs: positiveInteger(input.smokeTimeoutMs, 240_000, "RELEASE_IMAGE_SMOKE_ARGUMENTS"),
    sourceSha: input.sourceSha,
    surface: input.surface,
  };
}

export async function runReleaseImageSmoke(input = {}) {
  const evidence = await preflight(input);
  const context = normalizedContext(input, evidence);
  let primaryError = null;
  try {
    await runDocker(context, ["load", "--input", context.imageArchivePath], "IMAGE_LOAD_FAILED");
    if (
      await hashRegularFile(context.imageArchivePath, requiredEvidence.image.limit, "EVIDENCE_MISSING") !==
      context.imageArtifactSha256
    ) {
      fail("EVIDENCE_CHANGED");
    }
    const inspection = await runDocker(
      context,
      ["image", "inspect", context.manifest.image.manifestDigest],
      "IMAGE_INSPECTION_FAILED",
    );
    parseImageInspection(inspection.stdout, context.manifest);

    await runDocker(context, [
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--label",
      `com.salamland.release-source=${context.sourceSha}`,
      context.network,
    ], "NETWORK_CREATE_FAILED");

    await runDocker(context, [
      "run",
      "--detach",
      "--name",
      context.databaseContainer,
      "--network",
      context.network,
      "--network-alias",
      "postgres",
      "--pull",
      "always",
      "--env",
      "POSTGRES_DB=postgres",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      `POSTGRES_PASSWORD=${context.databaseSuperuserPassword}`,
      postgresImage,
    ], "DATABASE_START_FAILED", "DATABASE_START_TIMEOUT", context.readinessTimeoutMs);
    await waitDatabase(context);
    await runDocker(context, [
      "exec",
      context.databaseContainer,
      "psql",
      "--username=postgres",
      "--dbname=postgres",
      "--set=ON_ERROR_STOP=1",
      "--command",
      `CREATE ROLE ${databaseUser} LOGIN PASSWORD '${context.databasePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    ], "DATABASE_BOOTSTRAP_FAILED");
    await runDocker(context, [
      "exec",
      context.databaseContainer,
      "createdb",
      "--username=postgres",
      `--owner=${databaseUser}`,
      databaseName,
    ], "DATABASE_BOOTSTRAP_FAILED");
    await runDocker(context, [
      "cp",
      context.databaseDumpPath,
      `${context.databaseContainer}:/tmp/migrated.dump`,
    ], "DATABASE_RESTORE_FAILED");
    await runDocker(context, [
      "exec",
      "--env",
      `PGPASSWORD=${context.databasePassword}`,
      context.databaseContainer,
      "pg_restore",
      "--host=127.0.0.1",
      `--username=${databaseUser}`,
      `--dbname=${databaseName}`,
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "/tmp/migrated.dump",
    ], "DATABASE_RESTORE_FAILED", "DATABASE_RESTORE_TIMEOUT", 120_000);
    const ledgerResult = await runDocker(context, [
      "exec",
      "--env",
      `PGPASSWORD=${context.databasePassword}`,
      context.databaseContainer,
      "psql",
      "--host=127.0.0.1",
      `--username=${databaseUser}`,
      `--dbname=${databaseName}`,
      "--no-align",
      "--tuples-only",
      "--set=ON_ERROR_STOP=1",
      "--command",
      "select coalesce(json_agg(row_to_json(m) order by filename)::text,'[]') from (select filename, checksum from schema_migrations order by filename) m",
    ], "DATABASE_LEDGER_FAILED");
    let restoredLedger;
    try {
      restoredLedger = JSON.parse(ledgerResult.stdout.trim());
    } catch {
      fail("DATABASE_LEDGER_MISMATCH");
    }
    if (JSON.stringify(restoredLedger) !== JSON.stringify(context.ledger)) {
      fail("DATABASE_LEDGER_MISMATCH");
    }

    const databaseInspection = await runDocker(context, [
      "inspect",
      "--format",
      `{{with index .NetworkSettings.Networks "${context.network}"}}{{.IPAddress}}{{end}}`,
      context.databaseContainer,
    ], "DATABASE_NETWORK_INVALID");
    const databaseAddress = privateContainerAddress(databaseInspection.stdout);
    const environment = appEnvironment(context, databaseAddress);
    await runDocker(context, [
      "run",
      "--detach",
      "--name",
      context.appContainer,
      "--network",
      context.network,
      "--network-alias",
      "app",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--cpus",
      "1.0",
      "--user",
      "65532:65532",
      "--dns",
      "127.0.0.1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
      "--tmpfs",
      "/app/.next/cache:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
      "--publish",
      "127.0.0.1::3000",
      ...environmentArguments(environment),
      context.manifest.image.manifestDigest,
    ], "APP_START_FAILED", "APP_START_TIMEOUT", context.readinessTimeoutMs);
    const port = await runDocker(
      context,
      ["port", context.appContainer, "3000/tcp"],
      "APP_PORT_INVALID",
    );
    const baseUrl = publishedBaseUrl(port.stdout);
    const network = await runDocker(
      context,
      ["network", "inspect", context.network],
      "NETWORK_MEMBERSHIP_INVALID",
    );
    assertNetworkInspection(network.stdout, context);
    await waitApp(context, baseUrl);

    const appInspection = await runDocker(context, [
      "inspect",
      "--format",
      `{{with index .NetworkSettings.Networks "${context.network}"}}{{.IPAddress}}{{end}}`,
      context.appContainer,
    ], "APP_NETWORK_INVALID");
    const appAddress = privateContainerAddress(appInspection.stdout);

    await runDocker(context, [
      "exec",
      context.appContainer,
      "/nodejs/bin/node",
      "--input-type=module",
      "--eval",
      egressProbe,
    ], "EGRESS_POLICY_FAILED");

    await runProductionSmoke(context, appAddress, environment);

    await runDocker(context, ["stop", "--time", "10", context.appContainer], "APP_RESTART_FAILED");
    await runDocker(context, ["start", context.appContainer], "APP_RESTART_FAILED");
    await waitApp(context, baseUrl);
    const networkAfterRestart = await runDocker(
      context,
      ["network", "inspect", context.network],
      "NETWORK_MEMBERSHIP_INVALID",
    );
    assertNetworkInspection(networkAfterRestart.stdout, context);
    const appInspectionAfterRestart = await runDocker(context, [
      "inspect",
      "--format",
      `{{with index .NetworkSettings.Networks "${context.network}"}}{{.IPAddress}}{{end}}`,
      context.appContainer,
    ], "APP_NETWORK_INVALID");
    const appAddressAfterRestart = privateContainerAddress(appInspectionAfterRestart.stdout);
    await runProductionSmoke(context, appAddressAfterRestart, environment);
  } catch (error) {
    primaryError = error instanceof Error ? error : new ReleaseImageSmokeError("RELEASE_IMAGE_SMOKE_FAILED");
  }
  await cleanup(context, primaryError);
}

export async function runReleaseImageSmokeCli(input = {}) {
  const processTarget = input.processTarget ?? process;
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let receivedSignal = null;
  const handlers = Object.fromEntries(["SIGINT", "SIGTERM"].map((name) => [
    name,
    () => {
      if (receivedSignal) return;
      receivedSignal = name;
      controller.abort(new ReleaseImageSmokeInterruptedError(name));
    },
  ]));
  for (const [name, handler] of Object.entries(handlers)) processTarget.on(name, handler);
  try {
    await runReleaseImageSmoke({ ...input, signal });
  } catch (error) {
    if (!(receivedSignal && error instanceof ReleaseImageSmokeInterruptedError)) throw error;
  } finally {
    for (const [name, handler] of Object.entries(handlers)) {
      processTarget.removeListener(name, handler);
    }
    if (receivedSignal) processTarget.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  }
}

function parseArguments(argv) {
  const allowed = new Set(["--evidence-dir", "--database-dump", "--surface", "--source-sha"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || values.has(key)) {
      fail("RELEASE_IMAGE_SMOKE_ARGUMENTS");
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) fail("RELEASE_IMAGE_SMOKE_ARGUMENTS");
  return {
    databaseDumpPath: values.get("--database-dump"),
    evidenceDirectory: values.get("--evidence-dir"),
    sourceSha: values.get("--source-sha"),
    surface: values.get("--surface"),
  };
}

async function main() {
  try {
    await runReleaseImageSmokeCli(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof ReleaseImageSmokeError
      ? error.code
      : error instanceof AggregateError
        ? "RELEASE_IMAGE_SMOKE_CLEANUP_FAILED"
        : "RELEASE_IMAGE_SMOKE_INTERNAL";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
