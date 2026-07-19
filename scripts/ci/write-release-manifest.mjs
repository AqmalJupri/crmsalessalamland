import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXPECTED_RELEASE_MIGRATIONS,
  RUNTIME_BASE_IMAGE,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PLATFORM,
  RELEASE_SYFT_VERSION,
  RELEASE_SURFACES,
  ReleaseContractError,
  assertExactKeys,
  assertPlainRecord,
  assertSha256Digest,
  assertSourceSha,
  canonicalJson,
  failReleaseContract,
  parseStrictJsonBytes,
  sha256Digest,
} from "./release-image-contract.mjs";

const evidenceFiles = Object.freeze({
  image: Object.freeze({ name: "image-metadata.json", limit: 64 * 1024 }),
  imageArtifact: Object.freeze({ name: "image.oci.tar", limit: 4 * 1024 * 1024 * 1024 }),
  ledger: Object.freeze({ name: "migration-ledger.json", limit: 64 * 1024 }),
  sbomBinding: Object.freeze({ name: "sbom-binding.json", limit: 64 * 1024 }),
  cyclonedx: Object.freeze({ name: "sbom.cdx.json", limit: 64 * 1024 * 1024 }),
  spdx: Object.freeze({ name: "sbom.spdx.json", limit: 64 * 1024 * 1024 }),
  scan: Object.freeze({ name: "scan-report.json", limit: 64 * 1024 * 1024 }),
  policy: Object.freeze({ name: "policy.json", limit: 1024 * 1024 }),
  trivyReport: Object.freeze({ name: "trivy-raw.json", limit: 64 * 1024 * 1024 }),
  trivySecretReport: Object.freeze({
    name: "trivy-secret-raw.json",
    limit: 64 * 1024 * 1024,
  }),
  trivyVersion: Object.freeze({ name: "trivy-version.json", limit: 64 * 1024 }),
});
const MAX_SBOM_AGE_MS = 2 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function parseArguments(argv) {
  const allowed = new Set(["--evidence-dir", "--surface", "--source-sha", "--output"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || values.has(key)) {
      failReleaseContract("RELEASE_MANIFEST_ARGUMENTS");
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) failReleaseContract("RELEASE_MANIFEST_ARGUMENTS");

  const surface = values.get("--surface");
  const sourceSha = values.get("--source-sha");
  if (!RELEASE_SURFACES.includes(surface)) {
    failReleaseContract("RELEASE_MANIFEST_SURFACE_MISMATCH");
  }
  assertSourceSha(sourceSha, "RELEASE_MANIFEST_SOURCE_MISMATCH");
  return Object.freeze({
    evidenceDirectory: resolve(values.get("--evidence-dir")),
    outputPath: resolve(values.get("--output")),
    surface,
    sourceSha,
  });
}

async function assertEvidenceDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    failReleaseContract("RELEASE_MANIFEST_EVIDENCE_MISSING");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    failReleaseContract("RELEASE_MANIFEST_EVIDENCE_PATH");
  }
  return realpath(path);
}

async function readBoundedRegularFile(directory, evidence) {
  const path = join(directory, evidence.name);
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > evidence.limit) {
      failReleaseContract("RELEASE_MANIFEST_EVIDENCE_BOUNDS");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) {
      failReleaseContract("RELEASE_MANIFEST_EVIDENCE_CHANGED");
    }
    const finalMetadata = await handle.stat();
    if (
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ino !== metadata.ino ||
      finalMetadata.dev !== metadata.dev
    ) {
      failReleaseContract("RELEASE_MANIFEST_EVIDENCE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") failReleaseContract("RELEASE_MANIFEST_EVIDENCE_MISSING");
    failReleaseContract("RELEASE_MANIFEST_EVIDENCE_PATH");
  } finally {
    await handle?.close();
  }
}

async function hashBoundedRegularFile(directory, evidence) {
  const path = join(directory, evidence.name);
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > evidence.limit) {
      failReleaseContract("RELEASE_MANIFEST_EVIDENCE_BOUNDS");
    }
    const hash = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      byteLength += chunk.byteLength;
      if (byteLength > evidence.limit) {
        failReleaseContract("RELEASE_MANIFEST_EVIDENCE_BOUNDS");
      }
      hash.update(chunk);
    }
    if (byteLength !== metadata.size) {
      failReleaseContract("RELEASE_MANIFEST_EVIDENCE_CHANGED");
    }
    const finalMetadata = await handle.stat();
    if (
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ino !== metadata.ino ||
      finalMetadata.dev !== metadata.dev
    ) {
      failReleaseContract("RELEASE_MANIFEST_EVIDENCE_CHANGED");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") failReleaseContract("RELEASE_MANIFEST_EVIDENCE_MISSING");
    failReleaseContract("RELEASE_MANIFEST_EVIDENCE_PATH");
  } finally {
    await handle?.close();
  }
}

function parseJson(bytes, code) {
  return parseStrictJsonBytes(bytes, code);
}

function assertString(value, code, pattern = /\S/) {
  if (typeof value !== "string" || !pattern.test(value)) failReleaseContract(code);
  return value;
}

function assertIsoTimestamp(value, code) {
  const timestamp = assertString(
    value,
    code,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  if (new Date(timestamp).toISOString() !== timestamp) failReleaseContract(code);
  return timestamp;
}

function assertRfc3339Timestamp(value, code) {
  const timestamp = assertString(
    value,
    code,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) failReleaseContract(code);
  return milliseconds;
}

function validateImage(value, surface, sourceSha, artifactDigest) {
  assertExactKeys(
    value,
    [
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
    ],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    failReleaseContract("RELEASE_MANIFEST_SCHEMA");
  }
  if (value.sourceSha !== sourceSha || value.appVersion !== sourceSha) {
    failReleaseContract("RELEASE_MANIFEST_SOURCE_MISMATCH");
  }
  if (value.surface !== surface) failReleaseContract("RELEASE_MANIFEST_SURFACE_MISMATCH");
  const baseImageDigest = assertSha256Digest(
    value.baseImageDigest,
    "RELEASE_MANIFEST_BASE_IMAGE",
  );
  const baseImagePlatformDigest = assertSha256Digest(
    value.baseImagePlatformDigest,
    "RELEASE_MANIFEST_BASE_IMAGE",
  );
  if (
    baseImageDigest !== RUNTIME_BASE_IMAGE.indexDigest ||
    baseImagePlatformDigest !== RUNTIME_BASE_IMAGE.platformDigest
  ) {
    failReleaseContract("RELEASE_MANIFEST_BASE_IMAGE");
  }
  assertExactKeys(value.platform, ["os", "architecture"], "RELEASE_MANIFEST_PLATFORM");
  if (
    value.platform.os !== RELEASE_PLATFORM.os ||
    value.platform.architecture !== RELEASE_PLATFORM.architecture
  ) {
    failReleaseContract("RELEASE_MANIFEST_PLATFORM");
  }

  const imageManifestDigest = assertSha256Digest(
    value.imageManifestDigest,
    "RELEASE_MANIFEST_IMAGE_MISMATCH",
  );
  const imageConfigDigest = assertSha256Digest(
    value.imageConfigDigest,
    "RELEASE_MANIFEST_IMAGE_MISMATCH",
  );
  const imageArtifactSha256 = assertSha256Digest(
    value.imageArtifactSha256,
    "RELEASE_MANIFEST_IMAGE_ARTIFACT",
  );
  if (imageArtifactSha256 !== artifactDigest) {
    failReleaseContract("RELEASE_MANIFEST_IMAGE_ARTIFACT");
  }
  const reference = assertString(
    value.imageReference,
    "RELEASE_MANIFEST_IMAGE_REFERENCE",
    /^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/,
  );
  if (!reference.endsWith(`@${imageManifestDigest}`)) {
    failReleaseContract("RELEASE_MANIFEST_IMAGE_REFERENCE");
  }
  return Object.freeze({
    appVersion: value.appVersion,
    baseImageDigest,
    baseImagePlatformDigest,
    platform: Object.freeze({ ...value.platform }),
    reference,
    imageManifestDigest,
    imageConfigDigest,
    imageArtifactSha256,
  });
}

function validateLedger(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "entries"],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length !== EXPECTED_RELEASE_MIGRATIONS.length
  ) {
    failReleaseContract("RELEASE_MANIFEST_MIGRATION_LEDGER");
  }
  const entries = value.entries.map((entry, index) => {
    assertExactKeys(entry, ["filename", "checksum"], "RELEASE_MANIFEST_UNKNOWN_FIELD");
    const expected = EXPECTED_RELEASE_MIGRATIONS[index];
    if (entry.filename !== expected.filename || entry.checksum !== expected.checksum) {
      failReleaseContract("RELEASE_MANIFEST_MIGRATION_LEDGER");
    }
    return Object.freeze({ filename: entry.filename, checksum: entry.checksum });
  });
  return Object.freeze(entries);
}

function validateCycloneDx(value, surface, sourceSha) {
  const root = assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
  if (
    root.bomFormat !== "CycloneDX" ||
    root.specVersion !== "1.6" ||
    !Number.isSafeInteger(root.version) ||
    root.version < 1 ||
    !Array.isArray(root.components) ||
    root.components.length < 1 ||
    root.components.length > 250_000
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_INVALID");
  }
  const metadata = assertPlainRecord(root.metadata, "RELEASE_MANIFEST_SBOM_INVALID");
  const generatedAt = assertRfc3339Timestamp(
    metadata.timestamp,
    "RELEASE_MANIFEST_SBOM_INVALID",
  );
  const component = assertPlainRecord(metadata.component, "RELEASE_MANIFEST_SBOM_INVALID");
  if (
    component.type !== "container" ||
    component.name !== surface ||
    component.version !== sourceSha
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  const tools = assertPlainRecord(metadata.tools, "RELEASE_MANIFEST_SBOM_INVALID");
  if (
    !Array.isArray(tools.components) ||
    !tools.components.some((value) => {
      const tool = assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
      return tool.name === "syft" && tool.version === RELEASE_SYFT_VERSION;
    })
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_INVALID");
  }
  for (const value of root.components) {
    assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
  }
  return generatedAt;
}

function validateSpdx(value, surface, sourceSha, imageManifestDigest) {
  const root = assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
  let namespace;
  try {
    namespace = new URL(root.documentNamespace);
  } catch {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  if (
    root.spdxVersion !== "SPDX-2.3" ||
    root.dataLicense !== "CC0-1.0" ||
    root.SPDXID !== "SPDXRef-DOCUMENT" ||
    root.name !== surface ||
    namespace.protocol !== "https:" ||
    namespace.username ||
    namespace.password ||
    namespace.search ||
    namespace.hash ||
    !namespace.pathname.includes(surface)
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  if (
    !Array.isArray(root.packages) ||
    root.packages.length < 1 ||
    root.packages.length > 250_000
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_INVALID");
  }
  const creationInfo = assertPlainRecord(
    root.creationInfo,
    "RELEASE_MANIFEST_SBOM_INVALID",
  );
  const generatedAt = assertRfc3339Timestamp(
    creationInfo.created,
    "RELEASE_MANIFEST_SBOM_INVALID",
  );
  if (
    !Array.isArray(creationInfo.creators) ||
    !creationInfo.creators.includes(`Tool: syft-${RELEASE_SYFT_VERSION}`)
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_INVALID");
  }
  for (const value of root.packages) {
    assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
  }
  const describedRelationships = Array.isArray(root.relationships)
    ? root.relationships.filter((value) => {
        const relationship = assertPlainRecord(
          value,
          "RELEASE_MANIFEST_SBOM_INVALID",
        );
        return (
          relationship.spdxElementId === "SPDXRef-DOCUMENT" &&
          relationship.relationshipType === "DESCRIBES"
        );
      })
    : [];
  if (describedRelationships.length !== 1) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  const rootPackageId = describedRelationships[0].relatedSpdxElement;
  const rootPackages = root.packages.filter((value) => value.SPDXID === rootPackageId);
  if (rootPackages.length !== 1) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  const rootPackage = rootPackages[0];
  const manifestHex = imageManifestDigest.slice("sha256:".length);
  const hasManifestChecksum =
    Array.isArray(rootPackage.checksums) &&
    rootPackage.checksums.some((value) => {
      const checksum = assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
      return checksum.algorithm === "SHA256" && checksum.checksumValue === manifestHex;
    });
  const hasManifestPurl =
    Array.isArray(rootPackage.externalRefs) &&
    rootPackage.externalRefs.some((value) => {
      const reference = assertPlainRecord(value, "RELEASE_MANIFEST_SBOM_INVALID");
      if (
        reference.referenceCategory !== "PACKAGE-MANAGER" ||
        reference.referenceType !== "purl" ||
        typeof reference.referenceLocator !== "string"
      ) {
        return false;
      }
      try {
        return decodeURIComponent(reference.referenceLocator).includes(
          `@${imageManifestDigest}`,
        );
      } catch {
        return false;
      }
    });
  if (
    rootPackage.primaryPackagePurpose !== "CONTAINER" ||
    rootPackage.name !== surface ||
    rootPackage.versionInfo !== sourceSha ||
    !hasManifestChecksum ||
    !hasManifestPurl
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  return generatedAt;
}

function validateSbomBinding(value, source, context) {
  assertExactKeys(
    value,
    ["schemaVersion", "sourceSha", "surface", "syft", "image", "sboms"],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    value.sourceSha !== context.sourceSha ||
    value.surface !== context.surface
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  assertExactKeys(
    value.syft,
    ["version", "command", "source", "platform", "sourceName", "sourceVersion"],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    value.syft.version !== RELEASE_SYFT_VERSION ||
    value.syft.command !== "scan" ||
    value.syft.source !== `oci-archive:${evidenceFiles.imageArtifact.name}` ||
    value.syft.platform !== `${RELEASE_PLATFORM.os}/${RELEASE_PLATFORM.architecture}` ||
    value.syft.sourceName !== context.surface ||
    value.syft.sourceVersion !== context.sourceSha
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  assertExactKeys(
    value.image,
    ["manifestDigest", "configDigest", "artifactSha256"],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    value.image.manifestDigest !== context.image.imageManifestDigest ||
    value.image.configDigest !== context.image.imageConfigDigest ||
    value.image.artifactSha256 !== context.image.imageArtifactSha256
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
  assertExactKeys(value.sboms, ["cyclonedx", "spdx"], "RELEASE_MANIFEST_UNKNOWN_FIELD");
  const expected = Object.freeze({
    cyclonedx: Object.freeze({
      filename: evidenceFiles.cyclonedx.name,
      format: "cyclonedx-json",
      specVersion: "1.6",
      sha256: context.cyclonedxDigest,
    }),
    spdx: Object.freeze({
      filename: evidenceFiles.spdx.name,
      format: "spdx-json",
      specVersion: "2.3",
      sha256: context.spdxDigest,
    }),
  });
  for (const name of ["cyclonedx", "spdx"]) {
    assertExactKeys(
      value.sboms[name],
      ["filename", "format", "specVersion", "sha256"],
      "RELEASE_MANIFEST_UNKNOWN_FIELD",
    );
    if (Object.keys(expected[name]).some((key) => value.sboms[name][key] !== expected[name][key])) {
      failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
    }
  }
  if (source !== canonicalJson(value)) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }
}

function assertSbomFreshness(generatedTimes, evaluatedAt) {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (
    generatedTimes.some(
      (generatedAtMs) =>
        generatedAtMs > evaluatedAtMs + MAX_CLOCK_SKEW_MS ||
        evaluatedAtMs - generatedAtMs > MAX_SBOM_AGE_MS,
    )
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_FRESHNESS");
  }
}

function validatePolicy(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "version", "exceptions"],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    typeof value.version !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.version) ||
    !Array.isArray(value.exceptions)
  ) {
    failReleaseContract("RELEASE_MANIFEST_POLICY");
  }
  return value.version;
}

function validateScan(value, context) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sourceSha",
      "surface",
      "imageManifestDigest",
      "result",
      "evaluatedAt",
      "findings",
      "artifacts",
      "scanner",
      "policy",
      "vulnerabilityDatabase",
    ],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION || value.result !== "pass") {
    failReleaseContract("RELEASE_MANIFEST_SCAN_RESULT");
  }
  if (value.sourceSha !== context.sourceSha) {
    failReleaseContract("RELEASE_MANIFEST_SOURCE_MISMATCH");
  }
  if (value.surface !== context.surface) {
    failReleaseContract("RELEASE_MANIFEST_SURFACE_MISMATCH");
  }
  if (value.imageManifestDigest !== context.image.imageManifestDigest) {
    failReleaseContract("RELEASE_MANIFEST_IMAGE_MISMATCH");
  }
  const evaluatedAt = assertIsoTimestamp(
    value.evaluatedAt,
    "RELEASE_MANIFEST_SCAN_RESULT",
  );
  if (!Array.isArray(value.findings)) failReleaseContract("RELEASE_MANIFEST_SCAN_RESULT");

  assertExactKeys(
    value.artifacts,
    [
      "imageArtifactSha256",
      "sbomBindingSha256",
      "cyclonedxSha256",
      "spdxSha256",
      "trivyReportSha256",
      "trivySecretReportSha256",
      "trivyVersionSha256",
    ],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  if (
    value.artifacts.imageArtifactSha256 !== context.image.imageArtifactSha256 ||
    value.artifacts.sbomBindingSha256 !== context.sbomBindingDigest ||
    value.artifacts.cyclonedxSha256 !== context.cyclonedxDigest ||
    value.artifacts.spdxSha256 !== context.spdxDigest ||
    value.artifacts.trivyReportSha256 !== context.trivyReportDigest ||
    value.artifacts.trivySecretReportSha256 !== context.trivySecretReportDigest ||
    value.artifacts.trivyVersionSha256 !== context.trivyVersionDigest
  ) {
    failReleaseContract("RELEASE_MANIFEST_SBOM_MISMATCH");
  }

  assertExactKeys(value.scanner, ["engine", "version"], "RELEASE_MANIFEST_UNKNOWN_FIELD");
  const scanner = Object.freeze({
    engine: assertString(value.scanner.engine, "RELEASE_MANIFEST_SCANNER"),
    version: assertString(value.scanner.version, "RELEASE_MANIFEST_SCANNER"),
  });

  assertExactKeys(value.policy, ["version", "sha256"], "RELEASE_MANIFEST_UNKNOWN_FIELD");
  if (
    value.policy.version !== context.policyVersion ||
    value.policy.sha256 !== context.policyDigest
  ) {
    failReleaseContract("RELEASE_MANIFEST_POLICY");
  }
  const policy = Object.freeze({
    version: value.policy.version,
    sha256: assertSha256Digest(value.policy.sha256, "RELEASE_MANIFEST_POLICY"),
  });

  assertExactKeys(
    value.vulnerabilityDatabase,
    ["source", "version", "updatedAt", "nextUpdate", "downloadedAt", "sha256"],
    "RELEASE_MANIFEST_UNKNOWN_FIELD",
  );
  const updatedAt = assertIsoTimestamp(
    value.vulnerabilityDatabase.updatedAt,
    "RELEASE_MANIFEST_VULNERABILITY_DATABASE",
  );
  const nextUpdate = assertIsoTimestamp(
    value.vulnerabilityDatabase.nextUpdate,
    "RELEASE_MANIFEST_VULNERABILITY_DATABASE",
  );
  const downloadedAt = assertIsoTimestamp(
    value.vulnerabilityDatabase.downloadedAt,
    "RELEASE_MANIFEST_VULNERABILITY_DATABASE",
  );
  if (
    value.vulnerabilityDatabase.source !== "ghcr.io/aquasecurity/trivy-db:2" ||
    Date.parse(updatedAt) > Date.parse(downloadedAt) + 5 * 60 * 1_000 ||
    Date.parse(downloadedAt) > Date.parse(evaluatedAt) + 5 * 60 * 1_000 ||
    Date.parse(nextUpdate) <= Date.parse(updatedAt)
  ) {
    failReleaseContract("RELEASE_MANIFEST_VULNERABILITY_DATABASE");
  }
  const vulnerabilityDatabase = Object.freeze({
    source: assertString(
      value.vulnerabilityDatabase.source,
      "RELEASE_MANIFEST_VULNERABILITY_DATABASE",
    ),
    version: assertString(
      value.vulnerabilityDatabase.version,
      "RELEASE_MANIFEST_VULNERABILITY_DATABASE",
    ),
    updatedAt,
    nextUpdate,
    downloadedAt,
    sha256: assertSha256Digest(
      value.vulnerabilityDatabase.sha256,
      "RELEASE_MANIFEST_VULNERABILITY_DATABASE",
    ),
  });
  return Object.freeze({ evaluatedAt, scanner, policy, vulnerabilityDatabase });
}

async function writeExclusive(path, source) {
  const parent = dirname(path);
  let parentMetadata;
  try {
    parentMetadata = await lstat(parent);
  } catch {
    failReleaseContract("RELEASE_MANIFEST_OUTPUT_PATH");
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    failReleaseContract("RELEASE_MANIFEST_OUTPUT_PATH");
  }

  try {
    await lstat(path);
    failReleaseContract("RELEASE_MANIFEST_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") failReleaseContract("RELEASE_MANIFEST_OUTPUT_PATH");
  }

  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EEXIST") failReleaseContract("RELEASE_MANIFEST_OUTPUT_EXISTS");
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_MANIFEST_OUTPUT_PATH");
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

export async function writeReleaseManifest(argv) {
  const args = parseArguments(argv);
  const evidenceDirectory = await assertEvidenceDirectory(args.evidenceDirectory);
  let outputDirectory;
  try {
    outputDirectory = await realpath(dirname(args.outputPath));
  } catch {
    failReleaseContract("RELEASE_MANIFEST_OUTPUT_PATH");
  }
  if (outputDirectory !== evidenceDirectory) {
    failReleaseContract("RELEASE_MANIFEST_OUTPUT_PATH");
  }

  const entries = await Promise.all(
    Object.entries(evidenceFiles)
      .filter(([name]) => name !== "imageArtifact")
      .map(async ([name, evidence]) => [
      name,
      await readBoundedRegularFile(evidenceDirectory, evidence),
      ]),
  );
  const evidence = Object.fromEntries(entries);
  const imageArtifactDigest = await hashBoundedRegularFile(
    evidenceDirectory,
    evidenceFiles.imageArtifact,
  );
  const image = validateImage(
    parseJson(evidence.image, "RELEASE_MANIFEST_IMAGE_METADATA"),
    args.surface,
    args.sourceSha,
    imageArtifactDigest,
  );
  const ledger = validateLedger(
    parseJson(evidence.ledger, "RELEASE_MANIFEST_MIGRATION_LEDGER"),
  );
  const cyclonedx = parseJson(evidence.cyclonedx, "RELEASE_MANIFEST_SBOM_INVALID");
  const spdx = parseJson(evidence.spdx, "RELEASE_MANIFEST_SBOM_INVALID");
  const cyclonedxGeneratedAt = validateCycloneDx(
    cyclonedx,
    args.surface,
    args.sourceSha,
  );
  const spdxGeneratedAt = validateSpdx(
    spdx,
    args.surface,
    args.sourceSha,
    image.imageManifestDigest,
  );
  const cyclonedxDigest = sha256Digest(evidence.cyclonedx);
  const spdxDigest = sha256Digest(evidence.spdx);
  const sbomBinding = parseJson(
    evidence.sbomBinding,
    "RELEASE_MANIFEST_SBOM_INVALID",
  );
  validateSbomBinding(
    sbomBinding,
    new TextDecoder("utf-8", { fatal: true }).decode(evidence.sbomBinding),
    {
      sourceSha: args.sourceSha,
      surface: args.surface,
      image,
      cyclonedxDigest,
      spdxDigest,
    },
  );
  const sbomBindingDigest = sha256Digest(evidence.sbomBinding);
  const trivyReportDigest = sha256Digest(evidence.trivyReport);
  const trivySecretReportDigest = sha256Digest(evidence.trivySecretReport);
  const trivyVersionDigest = sha256Digest(evidence.trivyVersion);

  const policy = parseJson(evidence.policy, "RELEASE_MANIFEST_POLICY");
  const policyVersion = validatePolicy(policy);
  const policyDigest = sha256Digest(evidence.policy);
  const scan = parseJson(evidence.scan, "RELEASE_MANIFEST_SCAN_REPORT");
  const scanIdentity = validateScan(scan, {
    sourceSha: args.sourceSha,
    surface: args.surface,
    image,
    sbomBindingDigest,
    cyclonedxDigest,
    spdxDigest,
    trivyReportDigest,
    trivySecretReportDigest,
    trivyVersionDigest,
    policyVersion,
    policyDigest,
  });
  assertSbomFreshness(
    [cyclonedxGeneratedAt, spdxGeneratedAt],
    scanIdentity.evaluatedAt,
  );

  const manifest = Object.freeze({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceSha: args.sourceSha,
    surface: args.surface,
    appVersion: image.appVersion,
    baseImageDigest: image.baseImageDigest,
    baseImagePlatformDigest: image.baseImagePlatformDigest,
    platform: image.platform,
    image: Object.freeze({
      reference: image.reference,
      manifestDigest: image.imageManifestDigest,
      configDigest: image.imageConfigDigest,
      artifactSha256: image.imageArtifactSha256,
    }),
    migrationLedger: Object.freeze({
      entryCount: ledger.length,
      sha256: sha256Digest(evidence.ledger),
      entries: ledger,
    }),
    sboms: Object.freeze({
      binding: Object.freeze({
        filename: evidenceFiles.sbomBinding.name,
        sha256: sbomBindingDigest,
      }),
      cyclonedx: Object.freeze({
        filename: evidenceFiles.cyclonedx.name,
        sha256: cyclonedxDigest,
      }),
      spdx: Object.freeze({ filename: evidenceFiles.spdx.name, sha256: spdxDigest }),
    }),
    scan: Object.freeze({
      result: "pass",
      evaluatedAt: scanIdentity.evaluatedAt,
      reportSha256: sha256Digest(evidence.scan),
      rawReportSha256: trivyReportDigest,
      secretReportSha256: trivySecretReportDigest,
      versionReportSha256: trivyVersionDigest,
      scanner: scanIdentity.scanner,
      policy: scanIdentity.policy,
      vulnerabilityDatabase: scanIdentity.vulnerabilityDatabase,
    }),
  });
  await writeExclusive(args.outputPath, canonicalJson(manifest));
  return manifest;
}

async function main() {
  try {
    await writeReleaseManifest(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof ReleaseContractError
      ? error.code
      : "RELEASE_MANIFEST_INTERNAL";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
