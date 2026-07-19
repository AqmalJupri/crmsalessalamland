import { createHash } from "node:crypto";
import runtimeBaseLock from "../../security/runtime-base-lock.json" with { type: "json" };

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_SYFT_VERSION = "1.48.0";
export const RELEASE_SURFACES = Object.freeze(["crm", "tasha"]);
export const RELEASE_PLATFORM = Object.freeze({ os: "linux", architecture: "amd64" });
export const RELEASE_RUNTIME_CONFIG_FIELDS = Object.freeze([
  "Env",
  "ExposedPorts",
  "Labels",
  "User",
  "WorkingDir",
  "Entrypoint",
  "Cmd",
  "ArgsEscaped",
]);
const RUNTIME_BASE_ENVIRONMENT = Object.freeze([
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
]);
const RELEASE_RUNTIME_ENVIRONMENT = Object.freeze([
  "HOME=/tmp",
  "HOSTNAME=0.0.0.0",
  "NEXT_TELEMETRY_DISABLED=1",
  "NODE_ENV=production",
  "PORT=3000",
]);
export const BUILD_BASE_IMAGE = Object.freeze({
  reference: "node:22.23.1-bookworm-slim",
  indexDigest: "sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3",
  platformDigest: "sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27",
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export const RUNTIME_BASE_IMAGE = deepFreeze(runtimeBaseLock);
export const EXPECTED_RELEASE_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: "0001_foundation.sql",
    checksum: "169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de",
  }),
  Object.freeze({
    filename: "0002_migration_platform.sql",
    checksum: "2e8425ae8f551fc5b8c96466f36e917df118a12a18c66e69ec68800e73ec0e73",
  }),
  Object.freeze({
    filename: "0003_reconciliation_bytewise_order.sql",
    checksum: "46fb6ab301eb4362dc4c74c186a432e59bcf00736e78ab3d5d8ea8e7359885c4",
  }),
  Object.freeze({
    filename: "0004_membership_user_identity_guard.sql",
    checksum: "58713ceda7660aa4a5385c734744c9bb9e12ccb00272032acf9a34cdfca70c5c",
  }),
  Object.freeze({
    filename: "0005_reconciliation_typed_result_truth.sql",
    checksum: "8fbf0ff4b506cc682b16b6d3fe4b59d69ee47040b95ed20542ff6983c496c381",
  }),
  Object.freeze({
    filename: "0006_reconciliation_finite_amounts.sql",
    checksum: "c320a95155c63273f176d2d79df7f9c729285b9c0474e332207da8f4bf0c5541",
  }),
  Object.freeze({
    filename: "0007_reconciliation_signoff_lifecycle.sql",
    checksum: "377718a38cd3af63d0e2eeceecdb2c979fa912714b6d5fc131a79a687a20a6de",
  }),
]);

export class ReleaseContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseContractError";
    this.code = code;
  }
}

export function failReleaseContract(code) {
  throw new ReleaseContractError(code);
}

export function isPlainRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function assertPlainRecord(value, code) {
  if (!isPlainRecord(value)) failReleaseContract(code);
  return value;
}

export function assertExactKeys(value, expected, code) {
  const actual = Object.keys(assertPlainRecord(value, code));
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    failReleaseContract(code);
  }
}

export function assertSha256Digest(value, code) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    failReleaseContract(code);
  }
  return value;
}

export function assertSourceSha(value, code) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    failReleaseContract(code);
  }
  return value;
}

export function expectedReleaseRuntimeEnvironment(surface, sourceSha) {
  if (!RELEASE_SURFACES.includes(surface)) failReleaseContract("RELEASE_IMAGE_ENVIRONMENT");
  assertSourceSha(sourceSha, "RELEASE_IMAGE_ENVIRONMENT");
  return Object.freeze([
    ...RUNTIME_BASE_ENVIRONMENT,
    ...RELEASE_RUNTIME_ENVIRONMENT,
    `APP_VERSION=${sourceSha}`,
    `PRODUCT_SURFACE=${surface}`,
  ]);
}

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
        if (keys.has(key)) failSyntax();
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

export function parseStrictJsonBytes(bytes, code) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(source, "utf8").equals(bytes)) failReleaseContract(code);
    assertNoDuplicateJsonKeys(source, code);
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract(code);
  }
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
