import { constants as fileConstants } from "node:fs";
import { createHash } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PLATFORM,
  RELEASE_SYFT_VERSION,
  RELEASE_SURFACES,
  ReleaseContractError,
  assertPlainRecord,
  assertSha256Digest,
  assertSourceSha,
  canonicalJson,
  failReleaseContract,
  sha256Digest,
} from "./release-image-contract.mjs";

const SCAN_POLICY_VERSION = "2026-07-18";
const TRIVY_REPORT_LIMIT = 64 * 1024 * 1024;
const TRIVY_VERSION_LIMIT = 64 * 1024;
const IMAGE_METADATA_LIMIT = 64 * 1024;
const SBOM_LIMIT = 64 * 1024 * 1024;
const TRIVY_DATABASE_LIMIT = 2 * 1024 * 1024 * 1024;
const POLICY_LIMIT = 1024 * 1024;
const MAX_RESULTS = 10_000;
const MAX_PACKAGES = 250_000;
const MAX_VULNERABILITIES = 250_000;
const MAX_EXCEPTIONS = 1_000;
const MAX_EXCEPTION_TTL_DAYS = 90;
const MAX_REPORT_AGE_MS = 60 * 60 * 1_000;
const MAX_SBOM_AGE_MS = 2 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_DATABASE_AGE_MS = 48 * 60 * 60 * 1_000;
const MAX_DATABASE_DOWNLOAD_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_DATABASE_UPDATE_INTERVAL_MS = 48 * 60 * 60 * 1_000;
const allowedSeverities = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const blockingSeverities = new Set(["HIGH", "CRITICAL"]);
const policyKeys = Object.freeze(["schemaVersion", "version", "exceptions"]);
const exceptionKeys = Object.freeze([
  "id",
  "vulnerabilityId",
  "packageName",
  "installedVersion",
  "severity",
  "owner",
  "rationale",
  "expiresOn",
]);
const trivyRootKeys = new Set([
  "SchemaVersion",
  "Trivy",
  "ReportID",
  "CreatedAt",
  "ArtifactID",
  "ArtifactName",
  "ArtifactType",
  "Metadata",
  "Results",
]);
const trivyResultKeys = new Set([
  "Target",
  "Class",
  "Type",
  "Packages",
  "Vulnerabilities",
  "MisconfSummary",
  "Misconfigurations",
  "Secrets",
  "Licenses",
  "CustomResources",
  "ExperimentalModifiedFindings",
]);
const trivyVulnerabilityKeys = new Set([
  "VulnerabilityID",
  "VendorIDs",
  "PkgID",
  "PkgName",
  "PkgIdentifier",
  "PkgPath",
  "InstalledVersion",
  "FixedVersion",
  "Status",
  "Layer",
  "SeveritySource",
  "PrimaryURL",
  "DataSource",
  "Fingerprint",
  "Custom",
  "Title",
  "Description",
  "Severity",
  "CweIDs",
  "VendorSeverity",
  "CVSS",
  "References",
  "PublishedDate",
  "LastModifiedDate",
  "CauseMetadata",
  "RiskFactors",
  "EPSS",
  "KEV",
  "InstalledFiles",
  "Maintainer",
]);

function assertKeySet(value, expected, code) {
  const actual = Object.keys(assertPlainRecord(value, code));
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    failReleaseContract(code);
  }
}

function assertAllowedKeys(value, allowed, code) {
  const record = assertPlainRecord(value, code);
  if (Object.keys(record).some((key) => !allowed.has(key))) failReleaseContract(code);
  return record;
}

function assertCalendarDate(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    failReleaseContract(code);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    failReleaseContract(code);
  }
  return value;
}

function assertIsoTimestamp(value, code) {
  if (typeof value !== "string") failReleaseContract(code);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) failReleaseContract(code);
  const milliseconds = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const normalized = `${match[1]}.${milliseconds}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== normalized) {
    failReleaseContract(code);
  }
  return normalized;
}

function assertSafeString(value, pattern, code, maximum = 256) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !pattern.test(value)
  ) {
    failReleaseContract(code);
  }
  return value;
}

function assertVulnerabilityId(value, code) {
  return assertSafeString(
    value,
    /^[A-Za-z0-9][A-Za-z0-9._:+-]{2,127}$/,
    code,
    128,
  );
}

function assertPackageName(value, code) {
  return assertSafeString(
    value,
    /^(?:@?[A-Za-z0-9][A-Za-z0-9._+:-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._+:-]*)*$/,
    code,
  );
}

function assertInstalledVersion(value, code) {
  return assertSafeString(value, /^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/, code);
}

function assertFreshReportTimestamp(value, evaluationTime) {
  const createdAt = assertIsoTimestamp(value, "RELEASE_SCAN_REPORT_SCHEMA");
  const createdAtMs = Date.parse(createdAt);
  const evaluationMs = Date.parse(evaluationTime);
  if (
    createdAtMs > evaluationMs + MAX_CLOCK_SKEW_MS ||
    evaluationMs - createdAtMs > MAX_REPORT_AGE_MS
  ) {
    failReleaseContract("RELEASE_SCAN_REPORT_FRESHNESS");
  }
}

function parseArguments(argv, trustedNowMs) {
  const allowed = new Set([
    "--trivy-report",
    "--trivy-secret-report",
    "--trivy-version",
    "--trivy-database",
    "--policy",
    "--image-metadata",
    "--cyclonedx",
    "--spdx",
    "--sbom-binding",
    "--surface",
    "--source-sha",
    "--evaluation-time",
    "--output",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || values.has(key)) {
      failReleaseContract("RELEASE_SCAN_ARGUMENTS");
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) failReleaseContract("RELEASE_SCAN_ARGUMENTS");

  const surface = values.get("--surface");
  const sourceSha = values.get("--source-sha");
  if (!RELEASE_SURFACES.includes(surface)) failReleaseContract("RELEASE_SCAN_SUBJECT");
  assertSourceSha(sourceSha, "RELEASE_SCAN_SUBJECT");

  const evaluationTime = assertIsoTimestamp(
    values.get("--evaluation-time"),
    "RELEASE_SCAN_EVALUATION_TIME",
  );
  if (
    !Number.isFinite(trustedNowMs) ||
    Math.abs(Date.parse(evaluationTime) - trustedNowMs) > MAX_CLOCK_SKEW_MS
  ) {
    failReleaseContract("RELEASE_SCAN_EVALUATION_TIME");
  }

  return Object.freeze({
    trivyReportPath: resolve(values.get("--trivy-report")),
    trivySecretReportPath: resolve(values.get("--trivy-secret-report")),
    trivyVersionPath: resolve(values.get("--trivy-version")),
    trivyDatabasePath: resolve(values.get("--trivy-database")),
    policyPath: resolve(values.get("--policy")),
    imageMetadataPath: resolve(values.get("--image-metadata")),
    cyclonedxPath: resolve(values.get("--cyclonedx")),
    spdxPath: resolve(values.get("--spdx")),
    sbomBindingPath: resolve(values.get("--sbom-binding")),
    outputPath: resolve(values.get("--output")),
    surface,
    sourceSha,
    evaluationTime,
  });
}

async function readBoundedRegularFile(path, limit) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) {
      failReleaseContract("RELEASE_SCAN_INPUT_BOUNDS");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      failReleaseContract("RELEASE_SCAN_INPUT_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_SCAN_INPUT_PATH");
  } finally {
    await handle?.close();
  }
}

async function digestBoundedRegularFile(path, limit) {
  let handle;
  try {
    handle = await open(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) {
      failReleaseContract("RELEASE_SCAN_INPUT_BOUNDS");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.byteLength, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead < 1) failReleaseContract("RELEASE_SCAN_INPUT_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      failReleaseContract("RELEASE_SCAN_INPUT_CHANGED");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_SCAN_INPUT_PATH");
  } finally {
    await handle?.close();
  }
}

function assertNoDuplicateJsonKeys(source, syntaxCode) {
  let index = 0;
  const failSyntax = () => failReleaseContract(syntaxCode);
  const skipWhitespace = () => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const parseString = () => {
    if (source[index] !== '"') failSyntax();
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          failSyntax();
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= source.length) failSyntax();
        if (source[index] === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(source.slice(index + 1, index + 5))) failSyntax();
          index += 5;
        } else {
          if (!/["\\/bfnrt]/.test(source[index])) failSyntax();
          index += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) failSyntax();
      index += 1;
    }
    failSyntax();
  };
  const parseValue = () => {
    skipWhitespace();
    const character = source[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) failReleaseContract("RELEASE_SCAN_JSON_DUPLICATE_KEY");
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ":") failSyntax();
        index += 1;
        parseValue();
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",") failSyntax();
        index += 1;
      }
      failSyntax();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        parseValue();
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",") failSyntax();
        index += 1;
      }
      failSyntax();
    }
    if (character === '"') {
      parseString();
      return;
    }
    const remainder = source.slice(index);
    const literal = /^(?:true|false|null)/.exec(remainder);
    if (literal) {
      index += literal[0].length;
      return;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (!number) failSyntax();
    index += number[0].length;
  };

  parseValue();
  skipWhitespace();
  if (index !== source.length) failSyntax();
}

function parseJson(bytes, code) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(source, "utf8").equals(bytes)) failReleaseContract(code);
    assertNoDuplicateJsonKeys(source, code);
    return Object.freeze({ source, value: JSON.parse(source) });
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract(code);
  }
}

function validatePolicy(parsed, evaluationTime) {
  const evaluationDate = evaluationTime.slice(0, 10);
  const evaluationDateMs = Date.parse(`${evaluationDate}T00:00:00.000Z`);
  const policy = assertPlainRecord(parsed.value, "RELEASE_SCAN_POLICY_SCHEMA");
  assertKeySet(policy, policyKeys, "RELEASE_SCAN_POLICY_UNKNOWN_FIELD");
  if (
    policy.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    policy.version !== SCAN_POLICY_VERSION ||
    !Array.isArray(policy.exceptions) ||
    policy.exceptions.length > MAX_EXCEPTIONS
  ) {
    failReleaseContract("RELEASE_SCAN_POLICY_SCHEMA");
  }

  const ids = new Set();
  const matches = new Map();
  for (const value of policy.exceptions) {
    const item = assertPlainRecord(value, "RELEASE_SCAN_POLICY_EXCEPTION");
    assertKeySet(item, exceptionKeys, "RELEASE_SCAN_POLICY_UNKNOWN_FIELD");
    const id = assertSafeString(
      item.id,
      /^[A-Z0-9][A-Z0-9._:-]{2,127}$/,
      "RELEASE_SCAN_POLICY_EXCEPTION",
      128,
    );
    const vulnerabilityId = assertVulnerabilityId(
      item.vulnerabilityId,
      "RELEASE_SCAN_POLICY_EXCEPTION",
    );
    const packageName = assertPackageName(
      item.packageName,
      "RELEASE_SCAN_POLICY_EXCEPTION",
    );
    const installedVersion = assertInstalledVersion(
      item.installedVersion,
      "RELEASE_SCAN_POLICY_EXCEPTION",
    );
    if (!blockingSeverities.has(item.severity)) {
      failReleaseContract("RELEASE_SCAN_POLICY_EXCEPTION");
    }
    const owner = assertSafeString(
      item.owner,
      /^[A-Za-z0-9][A-Za-z0-9._@+-]{2,127}$/,
      "RELEASE_SCAN_POLICY_EXCEPTION",
      128,
    );
    if (
      typeof item.rationale !== "string" ||
      item.rationale.length < 10 ||
      item.rationale.length > 500 ||
      item.rationale.trim() !== item.rationale ||
      /[\u0000-\u001f\u007f]/.test(item.rationale)
    ) {
      failReleaseContract("RELEASE_SCAN_POLICY_EXCEPTION");
    }
    const expiresOn = assertCalendarDate(
      item.expiresOn,
      "RELEASE_SCAN_POLICY_EXCEPTION",
    );
    if (expiresOn < evaluationDate) failReleaseContract("RELEASE_SCAN_POLICY_EXPIRED");
    const expiresOnMs = Date.parse(`${expiresOn}T00:00:00.000Z`);
    if (expiresOnMs - evaluationDateMs > MAX_EXCEPTION_TTL_DAYS * 24 * 60 * 60 * 1_000) {
      failReleaseContract("RELEASE_SCAN_POLICY_TTL");
    }

    const match = [vulnerabilityId, packageName, installedVersion, item.severity].join("\0");
    if (ids.has(id) || matches.has(match)) {
      failReleaseContract("RELEASE_SCAN_POLICY_DUPLICATE");
    }
    ids.add(id);
    matches.set(
      match,
      Object.freeze({
        id,
        vulnerabilityId,
        packageName,
        installedVersion,
        severity: item.severity,
        owner,
        rationale: item.rationale,
        expiresOn,
      }),
    );
  }

  if (parsed.source !== canonicalJson(policy)) {
    failReleaseContract("RELEASE_SCAN_POLICY_CANONICAL");
  }
  return Object.freeze({ version: policy.version, matches });
}

function validateImageMetadata(value, surface, sourceSha) {
  const metadata = assertPlainRecord(value, "RELEASE_SCAN_IMAGE_METADATA");
  assertKeySet(
    metadata,
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
    "RELEASE_SCAN_IMAGE_METADATA",
  );
  if (
    metadata.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    metadata.sourceSha !== sourceSha ||
    metadata.appVersion !== sourceSha
  ) {
    failReleaseContract("RELEASE_SCAN_SUBJECT");
  }
  if (metadata.surface !== surface) failReleaseContract("RELEASE_SCAN_SUBJECT");
  const imageManifestDigest = assertSha256Digest(
    metadata.imageManifestDigest,
    "RELEASE_SCAN_IMAGE_METADATA",
  );
  const imageConfigDigest = assertSha256Digest(
    metadata.imageConfigDigest,
    "RELEASE_SCAN_IMAGE_METADATA",
  );
  const imageArtifactSha256 = assertSha256Digest(
    metadata.imageArtifactSha256,
    "RELEASE_SCAN_IMAGE_METADATA",
  );
  assertSha256Digest(metadata.baseImageDigest, "RELEASE_SCAN_IMAGE_METADATA");
  assertSha256Digest(metadata.baseImagePlatformDigest, "RELEASE_SCAN_IMAGE_METADATA");
  const platform = assertPlainRecord(metadata.platform, "RELEASE_SCAN_IMAGE_METADATA");
  assertKeySet(platform, ["os", "architecture"], "RELEASE_SCAN_IMAGE_METADATA");
  if (platform.os !== "linux" || platform.architecture !== "amd64") {
    failReleaseContract("RELEASE_SCAN_IMAGE_METADATA");
  }
  if (
    typeof metadata.imageReference !== "string" ||
    !metadata.imageReference.endsWith(`@${imageManifestDigest}`)
  ) {
    failReleaseContract("RELEASE_SCAN_IMAGE_METADATA");
  }
  return Object.freeze({ imageManifestDigest, imageConfigDigest, imageArtifactSha256 });
}

function assertRfc3339Timestamp(value, code) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    failReleaseContract(code);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) failReleaseContract(code);
  return milliseconds;
}

function assertSbomFreshness(generatedAt, evaluationTime) {
  const evaluatedAt = Date.parse(evaluationTime);
  if (
    generatedAt > evaluatedAt + MAX_CLOCK_SKEW_MS ||
    evaluatedAt - generatedAt > MAX_SBOM_AGE_MS
  ) {
    failReleaseContract("RELEASE_SCAN_SBOM_FRESHNESS");
  }
}

function validateCycloneDx(value, surface, sourceSha, evaluationTime) {
  const root = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
  if (
    root.bomFormat !== "CycloneDX" ||
    root.specVersion !== "1.6" ||
    !Number.isSafeInteger(root.version) ||
    root.version < 1 ||
    !Array.isArray(root.components) ||
    root.components.length < 1 ||
    root.components.length > MAX_PACKAGES
  ) {
    failReleaseContract("RELEASE_SCAN_SBOM_INVALID");
  }
  const metadata = assertPlainRecord(root.metadata, "RELEASE_SCAN_SBOM_INVALID");
  assertSbomFreshness(
    assertRfc3339Timestamp(metadata.timestamp, "RELEASE_SCAN_SBOM_INVALID"),
    evaluationTime,
  );
  const component = assertPlainRecord(metadata.component, "RELEASE_SCAN_SBOM_INVALID");
  if (
    component.type !== "container" ||
    component.name !== surface ||
    component.version !== sourceSha
  ) {
    failReleaseContract("RELEASE_SCAN_SBOM_MISMATCH");
  }
  const tools = assertPlainRecord(metadata.tools, "RELEASE_SCAN_SBOM_INVALID");
  if (
    !Array.isArray(tools.components) ||
    !tools.components.some((value) => {
      const tool = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
      return tool.name === "syft" && tool.version === RELEASE_SYFT_VERSION;
    })
  ) {
    failReleaseContract("RELEASE_SCAN_SBOM_INVALID");
  }
}

function validateSpdx(value, surface, sourceSha, imageManifestDigest, evaluationTime) {
  const root = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
  if (
    root.spdxVersion !== "SPDX-2.3" ||
    root.dataLicense !== "CC0-1.0" ||
    root.SPDXID !== "SPDXRef-DOCUMENT" ||
    root.name !== surface ||
    !Array.isArray(root.packages) ||
    root.packages.length < 1 ||
    root.packages.length > MAX_PACKAGES
  ) {
    failReleaseContract("RELEASE_SCAN_SBOM_INVALID");
  }
  let namespace;
  try {
    namespace = new URL(root.documentNamespace);
  } catch {
    failReleaseContract("RELEASE_SCAN_SBOM_MISMATCH");
  }
  if (namespace.protocol !== "https:" || namespace.hash || namespace.search) {
    failReleaseContract("RELEASE_SCAN_SBOM_MISMATCH");
  }
  const creationInfo = assertPlainRecord(root.creationInfo, "RELEASE_SCAN_SBOM_INVALID");
  assertSbomFreshness(
    assertRfc3339Timestamp(creationInfo.created, "RELEASE_SCAN_SBOM_INVALID"),
    evaluationTime,
  );
  if (
    !Array.isArray(creationInfo.creators) ||
    !creationInfo.creators.includes(`Tool: syft-${RELEASE_SYFT_VERSION}`)
  ) {
    failReleaseContract("RELEASE_SCAN_SBOM_INVALID");
  }
  const relationships = Array.isArray(root.relationships) ? root.relationships : [];
  const described = relationships.filter((value) => {
    const relationship = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
    return (
      relationship.spdxElementId === "SPDXRef-DOCUMENT" &&
      relationship.relationshipType === "DESCRIBES"
    );
  });
  if (described.length !== 1) failReleaseContract("RELEASE_SCAN_SBOM_MISMATCH");
  const rootPackages = root.packages.filter((value) => {
    const item = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
    return item.SPDXID === described[0].relatedSpdxElement;
  });
  if (rootPackages.length !== 1) failReleaseContract("RELEASE_SCAN_SBOM_MISMATCH");
  const rootPackage = rootPackages[0];
  const manifestHex = imageManifestDigest.slice("sha256:".length);
  const hasManifestChecksum =
    Array.isArray(rootPackage.checksums) &&
    rootPackage.checksums.some((value) => {
      const checksum = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
      return checksum.algorithm === "SHA256" && checksum.checksumValue === manifestHex;
    });
  const hasManifestPurl =
    Array.isArray(rootPackage.externalRefs) &&
    rootPackage.externalRefs.some((value) => {
      const reference = assertPlainRecord(value, "RELEASE_SCAN_SBOM_INVALID");
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
    failReleaseContract("RELEASE_SCAN_SBOM_MISMATCH");
  }
}

function createSbomBinding(args, image, cyclonedxBytes, spdxBytes) {
  return Object.freeze({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceSha: args.sourceSha,
    surface: args.surface,
    syft: Object.freeze({
      version: RELEASE_SYFT_VERSION,
      command: "scan",
      source: "oci-archive:image.oci.tar",
      platform: `${RELEASE_PLATFORM.os}/${RELEASE_PLATFORM.architecture}`,
      sourceName: args.surface,
      sourceVersion: args.sourceSha,
    }),
    image: Object.freeze({
      manifestDigest: image.imageManifestDigest,
      configDigest: image.imageConfigDigest,
      artifactSha256: image.imageArtifactSha256,
    }),
    sboms: Object.freeze({
      cyclonedx: Object.freeze({
        filename: "sbom.cdx.json",
        format: "cyclonedx-json",
        specVersion: "1.6",
        sha256: sha256Digest(cyclonedxBytes),
      }),
      spdx: Object.freeze({
        filename: "sbom.spdx.json",
        format: "spdx-json",
        specVersion: "2.3",
        sha256: sha256Digest(spdxBytes),
      }),
    }),
  });
}

function validateTrivyVersion(value, evaluationTime) {
  const version = assertAllowedKeys(
    value,
    new Set(["Version", "VulnerabilityDB", "JavaDB", "CheckBundle"]),
    "RELEASE_SCAN_SCANNER",
  );
  const scannerVersion = assertSafeString(
    version.Version,
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    "RELEASE_SCAN_SCANNER",
    64,
  );
  const database = assertAllowedKeys(
    version.VulnerabilityDB,
    new Set(["Version", "UpdatedAt", "NextUpdate", "DownloadedAt"]),
    "RELEASE_SCAN_VULNERABILITY_DATABASE",
  );
  const databaseVersion =
    typeof database.Version === "number" &&
    Number.isSafeInteger(database.Version) &&
    database.Version >= 1
      ? String(database.Version)
      : assertSafeString(
          database.Version,
          /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/,
          "RELEASE_SCAN_VULNERABILITY_DATABASE",
          128,
        );
  const updatedAt = assertIsoTimestamp(
    database.UpdatedAt,
    "RELEASE_SCAN_VULNERABILITY_DATABASE",
  );
  const nextUpdate = assertIsoTimestamp(
    database.NextUpdate,
    "RELEASE_SCAN_VULNERABILITY_DATABASE",
  );
  const downloadedAt = assertIsoTimestamp(
    database.DownloadedAt,
    "RELEASE_SCAN_VULNERABILITY_DATABASE",
  );
  const evaluationMs = Date.parse(evaluationTime);
  const updatedAtMs = Date.parse(updatedAt);
  const nextUpdateMs = Date.parse(nextUpdate);
  const downloadedAtMs = Date.parse(downloadedAt);
  if (
    updatedAtMs > evaluationMs + MAX_CLOCK_SKEW_MS ||
    evaluationMs - updatedAtMs > MAX_DATABASE_AGE_MS ||
    downloadedAtMs > evaluationMs + MAX_CLOCK_SKEW_MS ||
    evaluationMs - downloadedAtMs > MAX_DATABASE_DOWNLOAD_AGE_MS ||
    downloadedAtMs + MAX_CLOCK_SKEW_MS < updatedAtMs ||
    nextUpdateMs <= updatedAtMs ||
    nextUpdateMs < evaluationMs - MAX_CLOCK_SKEW_MS ||
    nextUpdateMs - updatedAtMs > MAX_DATABASE_UPDATE_INTERVAL_MS
  ) {
    failReleaseContract("RELEASE_SCAN_VULNERABILITY_DATABASE_FRESHNESS");
  }
  return Object.freeze({
    scannerVersion,
    databaseVersion,
    updatedAt,
    nextUpdate,
    downloadedAt,
  });
}

function validateTrivyReport(value, image, exceptions, scannerVersion, evaluationTime) {
  const report = assertAllowedKeys(
    value,
    trivyRootKeys,
    "RELEASE_SCAN_REPORT_UNKNOWN_FIELD",
  );
  if (
    report.SchemaVersion !== 2 ||
    report.ArtifactType !== "container_image" ||
    !Array.isArray(report.Results) ||
    report.Results.length > MAX_RESULTS
  ) {
    failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
  }
  assertFreshReportTimestamp(report.CreatedAt, evaluationTime);
  if (report.Trivy !== undefined) {
    const trivy = assertAllowedKeys(
      report.Trivy,
      new Set(["Version", "Server"]),
      "RELEASE_SCAN_REPORT_UNKNOWN_FIELD",
    );
    if (trivy.Version !== scannerVersion) failReleaseContract("RELEASE_SCAN_SCANNER");
  }
  if (report.ReportID !== undefined) {
    assertSafeString(report.ReportID, /^[0-9a-f-]+$/, "RELEASE_SCAN_REPORT_SCHEMA", 128);
  }
  if (report.ArtifactID !== undefined) {
    assertSafeString(report.ArtifactID, /^[A-Za-z0-9:._+-]+$/, "RELEASE_SCAN_REPORT_SCHEMA");
  }
  assertSafeString(report.ArtifactName, /^[^\u0000-\u001f\u007f]+$/, "RELEASE_SCAN_REPORT_SCHEMA", 4096);
  const scanMetadata = assertPlainRecord(report.Metadata, "RELEASE_SCAN_REPORT_SCHEMA");
  const repoDigests = scanMetadata.RepoDigests;
  if (repoDigests !== undefined && !Array.isArray(repoDigests)) {
    failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
  }
  const manifestBound =
    scanMetadata.ImageID === image.imageConfigDigest ||
    scanMetadata.ImageID === image.imageManifestDigest ||
    (Array.isArray(repoDigests) &&
      repoDigests.some(
        (digest) =>
          typeof digest === "string" && digest.endsWith(`@${image.imageManifestDigest}`),
      ));
  if (!manifestBound) failReleaseContract("RELEASE_SCAN_IMAGE_MISMATCH");

  const results = report.Results.map((value) =>
    assertAllowedKeys(value, trivyResultKeys, "RELEASE_SCAN_REPORT_UNKNOWN_FIELD"),
  );
  let packageCount = 0;
  let hasPackageVulnerabilityCoverage = false;
  for (const result of results) {
    if (
      result.ExperimentalModifiedFindings !== undefined &&
      (!Array.isArray(result.ExperimentalModifiedFindings) ||
        result.ExperimentalModifiedFindings.length > 0)
    ) {
      failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
    }
    if (result.Secrets !== undefined && !Array.isArray(result.Secrets)) {
      failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
    }
    if (Array.isArray(result.Secrets) && result.Secrets.length > 0) {
      failReleaseContract("RELEASE_SCAN_SECRET_FINDING");
    }
    if (result.Packages !== undefined && !Array.isArray(result.Packages)) {
      failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
    }
    if (Array.isArray(result.Packages)) {
      packageCount += result.Packages.length;
      if (packageCount > MAX_PACKAGES) failReleaseContract("RELEASE_SCAN_REPORT_BOUNDS");
    }
    if (
      (result.Class === "os-pkgs" || result.Class === "lang-pkgs") &&
      typeof result.Target === "string" &&
      result.Target.length > 0 &&
      typeof result.Type === "string" &&
      result.Type.length > 0 &&
      Array.isArray(result.Packages) &&
      result.Packages.length > 0
    ) {
      hasPackageVulnerabilityCoverage = true;
    }
  }
  if (!hasPackageVulnerabilityCoverage) {
    failReleaseContract("RELEASE_SCAN_REPORT_COVERAGE");
  }

  const approvedFindings = new Map();
  let vulnerabilityCount = 0;
  for (const result of results) {
    if (result.Vulnerabilities === undefined) continue;
    if (!Array.isArray(result.Vulnerabilities)) {
      failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
    }
    vulnerabilityCount += result.Vulnerabilities.length;
    if (vulnerabilityCount > MAX_VULNERABILITIES) {
      failReleaseContract("RELEASE_SCAN_REPORT_BOUNDS");
    }
    for (const value of result.Vulnerabilities) {
      const finding = assertAllowedKeys(
        value,
        trivyVulnerabilityKeys,
        "RELEASE_SCAN_REPORT_UNKNOWN_FIELD",
      );
      const vulnerabilityId = assertVulnerabilityId(
        finding.VulnerabilityID,
        "RELEASE_SCAN_VULNERABILITY",
      );
      const packageName = assertPackageName(finding.PkgName, "RELEASE_SCAN_VULNERABILITY");
      const installedVersion = assertInstalledVersion(
        finding.InstalledVersion,
        "RELEASE_SCAN_VULNERABILITY",
      );
      if (!allowedSeverities.has(finding.Severity)) {
        failReleaseContract("RELEASE_SCAN_VULNERABILITY");
      }
      if (!blockingSeverities.has(finding.Severity)) continue;
      const match = [vulnerabilityId, packageName, installedVersion, finding.Severity].join("\0");
      const approved = exceptions.get(match);
      if (!approved) failReleaseContract("RELEASE_SCAN_UNAPPROVED_VULNERABILITY");
      approvedFindings.set(
        match,
        Object.freeze({
          vulnerabilityId,
          packageName,
          installedVersion,
          severity: finding.Severity,
          exceptionId: approved.id,
          expiresOn: approved.expiresOn,
        }),
      );
    }
  }

  return Object.freeze(
    [...approvedFindings.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, finding]) => finding),
  );
}

function validateTrivySecretReport(value, image, scannerVersion, evaluationTime) {
  const report = assertAllowedKeys(
    value,
    trivyRootKeys,
    "RELEASE_SCAN_REPORT_UNKNOWN_FIELD",
  );
  if (
    report.SchemaVersion !== 2 ||
    report.ArtifactType !== "container_image" ||
    (report.Results !== undefined &&
      (!Array.isArray(report.Results) || report.Results.length > MAX_RESULTS))
  ) {
    failReleaseContract("RELEASE_SCAN_SECRET_COVERAGE");
  }
  assertFreshReportTimestamp(report.CreatedAt, evaluationTime);
  if (report.Trivy !== undefined) {
    const trivy = assertAllowedKeys(
      report.Trivy,
      new Set(["Version", "Server"]),
      "RELEASE_SCAN_REPORT_UNKNOWN_FIELD",
    );
    if (trivy.Version !== scannerVersion) failReleaseContract("RELEASE_SCAN_SCANNER");
  }
  const scanMetadata = assertPlainRecord(
    report.Metadata,
    "RELEASE_SCAN_REPORT_SCHEMA",
  );
  const repoDigests = scanMetadata.RepoDigests;
  if (repoDigests !== undefined && !Array.isArray(repoDigests)) {
    failReleaseContract("RELEASE_SCAN_REPORT_SCHEMA");
  }
  const manifestBound =
    scanMetadata.ImageID === image.imageConfigDigest ||
    scanMetadata.ImageID === image.imageManifestDigest ||
    (Array.isArray(repoDigests) &&
      repoDigests.some(
        (value) =>
          typeof value === "string" && value.endsWith(`@${image.imageManifestDigest}`),
      ));
  if (!manifestBound) failReleaseContract("RELEASE_SCAN_IMAGE_MISMATCH");

  for (const value of report.Results ?? []) {
    const result = assertAllowedKeys(
      value,
      trivyResultKeys,
      "RELEASE_SCAN_REPORT_UNKNOWN_FIELD",
    );
    if (
      result.Class !== "secret" ||
      typeof result.Target !== "string" ||
      result.Target.length < 1 ||
      !Array.isArray(result.Secrets) ||
      result.Vulnerabilities !== undefined ||
      result.Packages !== undefined
    ) {
      failReleaseContract("RELEASE_SCAN_SECRET_COVERAGE");
    }
    if (result.Secrets.length > 0) {
      failReleaseContract("RELEASE_SCAN_SECRET_FINDING");
    }
  }
}

async function writeExclusive(path, source) {
  const requestedParent = dirname(path);
  let parent;
  let parentMetadata;
  try {
    parentMetadata = await lstat(requestedParent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
    }
    parent = await realpath(requestedParent);
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
  }

  const outputPath = join(parent, basename(path));

  try {
    await lstat(outputPath);
    failReleaseContract("RELEASE_SCAN_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
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
    await link(temporary, outputPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EEXIST") failReleaseContract("RELEASE_SCAN_OUTPUT_EXISTS");
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertOutputAvailable(path) {
  const parentPath = dirname(path);
  try {
    const parentMetadata = await lstat(parentPath);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
    }
    await realpath(parentPath);
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
  }
  try {
    await lstat(path);
    failReleaseContract("RELEASE_SCAN_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
  }
}

export async function assertReleaseScan(argv, { trustedClock = Date.now } = {}) {
  const args = parseArguments(argv, trustedClock());
  if (basename(args.sbomBindingPath) !== "sbom-binding.json") {
    failReleaseContract("RELEASE_SCAN_OUTPUT_PATH");
  }
  await Promise.all([
    assertOutputAvailable(args.outputPath),
    assertOutputAvailable(args.sbomBindingPath),
  ]);
  const [
    policyBytes,
    trivyBytes,
    trivySecretBytes,
    trivyVersionBytes,
    imageMetadataBytes,
    cyclonedxBytes,
    spdxBytes,
    vulnerabilityDatabaseSha256,
  ] = await Promise.all([
    readBoundedRegularFile(args.policyPath, POLICY_LIMIT),
    readBoundedRegularFile(args.trivyReportPath, TRIVY_REPORT_LIMIT),
    readBoundedRegularFile(args.trivySecretReportPath, TRIVY_REPORT_LIMIT),
    readBoundedRegularFile(args.trivyVersionPath, TRIVY_VERSION_LIMIT),
    readBoundedRegularFile(args.imageMetadataPath, IMAGE_METADATA_LIMIT),
    readBoundedRegularFile(args.cyclonedxPath, SBOM_LIMIT),
    readBoundedRegularFile(args.spdxPath, SBOM_LIMIT),
    digestBoundedRegularFile(args.trivyDatabasePath, TRIVY_DATABASE_LIMIT),
  ]);
  const policy = validatePolicy(
    parseJson(policyBytes, "RELEASE_SCAN_POLICY_JSON"),
    args.evaluationTime,
  );
  const image = validateImageMetadata(
    parseJson(imageMetadataBytes, "RELEASE_SCAN_IMAGE_METADATA").value,
    args.surface,
    args.sourceSha,
  );
  validateCycloneDx(
    parseJson(cyclonedxBytes, "RELEASE_SCAN_SBOM_INVALID").value,
    args.surface,
    args.sourceSha,
    args.evaluationTime,
  );
  validateSpdx(
    parseJson(spdxBytes, "RELEASE_SCAN_SBOM_INVALID").value,
    args.surface,
    args.sourceSha,
    image.imageManifestDigest,
    args.evaluationTime,
  );
  const trivyVersion = validateTrivyVersion(
    parseJson(trivyVersionBytes, "RELEASE_SCAN_SCANNER").value,
    args.evaluationTime,
  );
  const findings = validateTrivyReport(
    parseJson(trivyBytes, "RELEASE_SCAN_REPORT_JSON").value,
    image,
    policy.matches,
    trivyVersion.scannerVersion,
    args.evaluationTime,
  );
  validateTrivySecretReport(
    parseJson(trivySecretBytes, "RELEASE_SCAN_REPORT_JSON").value,
    image,
    trivyVersion.scannerVersion,
    args.evaluationTime,
  );
  const sbomBinding = createSbomBinding(args, image, cyclonedxBytes, spdxBytes);
  const sbomBindingSource = canonicalJson(sbomBinding);
  const report = Object.freeze({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceSha: args.sourceSha,
    surface: args.surface,
    imageManifestDigest: image.imageManifestDigest,
    result: "pass",
    evaluatedAt: args.evaluationTime,
    findings,
    artifacts: Object.freeze({
      imageArtifactSha256: image.imageArtifactSha256,
      sbomBindingSha256: sha256Digest(Buffer.from(sbomBindingSource, "utf8")),
      cyclonedxSha256: sha256Digest(cyclonedxBytes),
      spdxSha256: sha256Digest(spdxBytes),
      trivyReportSha256: sha256Digest(trivyBytes),
      trivySecretReportSha256: sha256Digest(trivySecretBytes),
      trivyVersionSha256: sha256Digest(trivyVersionBytes),
    }),
    scanner: Object.freeze({ engine: "trivy", version: trivyVersion.scannerVersion }),
    policy: Object.freeze({ version: policy.version, sha256: sha256Digest(policyBytes) }),
    vulnerabilityDatabase: Object.freeze({
      source: "ghcr.io/aquasecurity/trivy-db:2",
      version: trivyVersion.databaseVersion,
      updatedAt: trivyVersion.updatedAt,
      nextUpdate: trivyVersion.nextUpdate,
      downloadedAt: trivyVersion.downloadedAt,
      sha256: vulnerabilityDatabaseSha256,
    }),
  });
  await writeExclusive(args.sbomBindingPath, sbomBindingSource);
  await writeExclusive(args.outputPath, canonicalJson(report));
  return report;
}

async function main() {
  try {
    await assertReleaseScan(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof ReleaseContractError ? error.code : "RELEASE_SCAN_INTERNAL";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
