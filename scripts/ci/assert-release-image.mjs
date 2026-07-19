import {
  closeSync,
  constants as fileConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  RUNTIME_BASE_IMAGE,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PLATFORM,
  RELEASE_RUNTIME_CONFIG_FIELDS,
  RELEASE_SURFACES,
  assertSourceSha,
  canonicalJson,
  expectedReleaseRuntimeEnvironment,
  parseStrictJsonBytes,
  sha256Digest,
} from "./release-image-contract.mjs";

const EXPECTED_SOURCE = "https://github.com/AqmalJupri/crmsalessalamland";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LAYER_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_LAYER_BYTES = 1024 * 1024 * 1024;
const MAX_TAR_ENTRIES = 100_000;
const MAX_TOTAL_TAR_ENTRIES = 250_000;
const MAX_TAR_EXTENSION_BYTES = 64 * 1024;
const MAX_APP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_APP_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_CREDENTIAL_KEY_MATCHES = 4096;
const OBSERVED_PRODUCTION_SENSITIVE_TOKENS = 6_353_075;
const OBSERVED_PRODUCTION_CREDENTIAL_COMMENTS = 30_372;
const SENSITIVE_SCAN_HEADROOM_NUMERATOR = 3;
const SENSITIVE_SCAN_HEADROOM_DENOMINATOR = 2;
const MAX_CREDENTIAL_COMMENT_SPANS = Math.ceil(
  (OBSERVED_PRODUCTION_CREDENTIAL_COMMENTS * SENSITIVE_SCAN_HEADROOM_NUMERATOR) /
    SENSITIVE_SCAN_HEADROOM_DENOMINATOR,
);
const MAX_SENSITIVE_SOURCE_BYTES = MAX_APP_SCAN_BYTES + MAX_JSON_BYTES;
const MAX_SENSITIVE_TOKENS = Math.ceil(
  (OBSERVED_PRODUCTION_SENSITIVE_TOKENS * SENSITIVE_SCAN_HEADROOM_NUMERATOR) /
    SENSITIVE_SCAN_HEADROOM_DENOMINATOR,
);
const MAX_TEMPLATE_NESTING = 32;
const MIN_CREDENTIAL_LITERAL_CHARACTERS = 8;
const SAFE_CREDENTIAL_CONTROL_VALUES = new Set(["include", "omit", "same-origin"]);
const SAFE_CREDENTIAL_ROLE_VALUES = new Set([
  ...SAFE_CREDENTIAL_CONTROL_VALUES,
  "use-credentials",
]);
const SAFE_CREDENTIAL_PREDICATE_VALUES = new Set([
  ...SAFE_CREDENTIAL_ROLE_VALUES,
  "anonymous",
  "basic",
  "cors",
  "opaque",
  "opaqueredirect",
]);
const CREDENTIAL_METADATA_SUFFIXES = new Set([
  "error",
  "hash",
  "kind",
  "label",
  "mode",
  "name",
  "policy",
  "provider",
  "strength",
  "type",
  "url",
]);
const CREDENTIAL_CODE_METADATA_SUFFIXES = new Set([
  "characters",
  "charset",
  "chars",
  "codepoint",
  "codepoints",
]);
const CREDENTIAL_CONTROL_PREFIXES = new Set(["include", "request", "use"]);
const CREDENTIAL_CODE_CALLABLE_PREFIXES = new Set(["create", "get"]);
const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const LAYER_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
]);
const REQUIRED_LABELS = Object.freeze([
  "org.opencontainers.image.source",
  "org.opencontainers.image.revision",
  "org.opencontainers.image.version",
  "com.salamland.product-surface",
]);
const ALLOWED_APP_ROOTS = new Set([".next", "node_modules", "public"]);
let activeCanary;

class InspectionError extends Error {
  constructor(code, safePath) {
    super(code);
    this.name = "InspectionError";
    this.code = code;
    this.safePath = safePath;
  }
}

function fail(code, safePath) {
  throw new InspectionError(code, safePath);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value, code) {
  if (!isRecord(value)) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const keys = Object.keys(record(value, code));
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail(code);
  }
}

function allowedKeys(value, allowed, code) {
  if (Object.keys(record(value, code)).some((key) => !allowed.includes(key))) fail(code);
}

function digest(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    fail("RELEASE_IMAGE_DIGEST_INVALID");
  }
  return value;
}

function parseArguments(argv) {
  const allowed = new Set(["--archive", "--surface", "--source-sha", "--output", "--canary"]);
  const values = new Map();
  if (argv.length !== allowed.size * 2) fail("RELEASE_IMAGE_ARGUMENTS");
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || values.has(key)) {
      fail("RELEASE_IMAGE_ARGUMENTS");
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) fail("RELEASE_IMAGE_ARGUMENTS");

  const surface = values.get("--surface");
  const sourceSha = values.get("--source-sha");
  const canary = values.get("--canary");
  if (!RELEASE_SURFACES.includes(surface) || !/^[A-Za-z0-9_.:-]{16,256}$/.test(canary)) {
    fail("RELEASE_IMAGE_ARGUMENTS");
  }
  try {
    assertSourceSha(sourceSha, "RELEASE_IMAGE_ARGUMENTS");
  } catch {
    fail("RELEASE_IMAGE_ARGUMENTS");
  }

  const archivePath = resolve(values.get("--archive"));
  const requestedOutputPath = resolve(values.get("--output"));
  if (basename(requestedOutputPath) !== "image-metadata.json") fail("RELEASE_IMAGE_OUTPUT_PATH");
  let outputDirectory;
  try {
    outputDirectory = realpathSync(dirname(requestedOutputPath));
  } catch {
    fail("RELEASE_IMAGE_OUTPUT_PATH");
  }
  const outputPath = join(outputDirectory, "image-metadata.json");
  return Object.freeze({ archivePath, outputPath, surface, sourceSha, canary });
}

function readStableArchive(path) {
  let pathMetadata;
  try {
    pathMetadata = lstatSync(path);
  } catch {
    fail("RELEASE_IMAGE_ARCHIVE_PATH");
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    fail("RELEASE_IMAGE_ARCHIVE_PATH");
  }
  if (pathMetadata.size < 1024 || pathMetadata.size > MAX_ARCHIVE_BYTES) {
    fail("RELEASE_IMAGE_ARCHIVE_BOUNDS");
  }

  let descriptor;
  try {
    descriptor = openSync(
      path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== pathMetadata.size) fail("RELEASE_IMAGE_ARCHIVE_CHANGED");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      fail("RELEASE_IMAGE_ARCHIVE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    fail("RELEASE_IMAGE_ARCHIVE_PATH");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("RELEASE_IMAGE_TAR_HEADER");
  }
}

function tarOctal(header, offset, length) {
  const source = tarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(source)) fail("RELEASE_IMAGE_TAR_HEADER");
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail("RELEASE_IMAGE_TAR_HEADER");
  return value;
}

function canonicalTarPath(header, type, extendedPath) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  let path = extendedPath ?? (prefix ? `${prefix}/${name}` : name);
  if (type === "directory" && path.endsWith("/")) path = path.slice(0, -1);
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    fail("RELEASE_IMAGE_TAR_PATH");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail("RELEASE_IMAGE_TAR_PATH");
  }
  return path;
}

function decodeTarExtensionValue(bytes) {
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > 4097 ||
    bytes.at(-1) !== 0 ||
    bytes.subarray(0, -1).includes(0)
  ) {
    fail("RELEASE_IMAGE_TAR_EXTENSION");
  }
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, -1),
    );
    if (!value || Buffer.byteLength(value, "utf8") > 4096) {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    return value;
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    fail("RELEASE_IMAGE_TAR_EXTENSION");
  }
}

function parsePaxExtension(bytes) {
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_TAR_EXTENSION_BYTES) {
    fail("RELEASE_IMAGE_TAR_EXTENSION");
  }
  const values = Object.create(null);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const separator = bytes.indexOf(0x20, offset);
    if (separator < offset + 1) fail("RELEASE_IMAGE_TAR_EXTENSION");
    const lengthSource = bytes.subarray(offset, separator).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthSource)) {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    const length = Number.parseInt(lengthSource, 10);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > bytes.byteLength ||
      separator >= end - 2 ||
      bytes[end - 1] !== 0x0a
    ) {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    const record = bytes.subarray(separator + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1 || equals === record.byteLength - 1) {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    let key;
    let value;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      key = decoder.decode(record.subarray(0, equals));
      value = decoder.decode(record.subarray(equals + 1));
    } catch {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    if (
      !["path", "linkpath"].includes(key) ||
      Object.hasOwn(values, key) ||
      !value ||
      Buffer.byteLength(value, "utf8") > 4096
    ) {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    values[key] = value;
    offset = end;
  }
  if (!Object.hasOwn(values, "path") && !Object.hasOwn(values, "linkpath")) {
    fail("RELEASE_IMAGE_TAR_EXTENSION");
  }
  return values;
}

function parseTar(bytes, scope) {
  const entries = [];
  const paths = new Set();
  let offset = 0;
  let sawTerminator = false;
  let headerCount = 0;
  let pendingExtension;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      if (pendingExtension !== undefined) fail("RELEASE_IMAGE_TAR_EXTENSION");
      if (offset + 1024 > bytes.byteLength || !isZeroBlock(bytes.subarray(offset + 512, offset + 1024))) {
        fail("RELEASE_IMAGE_TAR_TERMINATOR");
      }
      for (const byte of bytes.subarray(offset + 1024)) {
        if (byte !== 0) fail("RELEASE_IMAGE_TAR_TRAILING_DATA");
      }
      sawTerminator = true;
      break;
    }
    headerCount += 1;
    if (headerCount > MAX_TAR_ENTRIES) fail("RELEASE_IMAGE_TAR_BOUNDS");

    const expectedChecksum = tarOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (actualChecksum !== expectedChecksum) fail("RELEASE_IMAGE_TAR_CHECKSUM");

    const typeFlag = header[156];
    const type =
      typeFlag === 0 || typeFlag === 0x30
        ? "file"
        : typeFlag === 0x35
          ? "directory"
          : typeFlag === 0x32
            ? "symlink"
            : typeFlag === 0x31
              ? "hardlink"
              : typeFlag === 0x78
                ? "pax"
                : typeFlag === 0x4c
                  ? "gnu-long-name"
                  : typeFlag === 0x4b
                    ? "gnu-long-link"
                    : "special";
    const size = tarOctal(header, 124, 12);
    if (size > MAX_LAYER_BYTES) fail("RELEASE_IMAGE_TAR_BOUNDS");
    const contentOffset = offset + 512;
    const end = contentOffset + size;
    if (end > bytes.byteLength) fail("RELEASE_IMAGE_TAR_TRUNCATED");
    const content = bytes.subarray(contentOffset, end);
    const nextOffset = end + ((512 - (size % 512)) % 512);

    if (["pax", "gnu-long-name", "gnu-long-link"].includes(type)) {
      if (
        pendingExtension !== undefined ||
        size < 1 ||
        size > MAX_TAR_EXTENSION_BYTES
      ) {
        fail("RELEASE_IMAGE_TAR_EXTENSION");
      }
      pendingExtension =
        type === "pax"
          ? parsePaxExtension(content)
          : type === "gnu-long-name"
            ? Object.freeze({ path: decodeTarExtensionValue(content) })
            : Object.freeze({ linkpath: decodeTarExtensionValue(content) });
      offset = nextOffset;
      continue;
    }
    if (scope === "outer" && type !== "file" && type !== "directory") {
      fail("RELEASE_IMAGE_TAR_TYPE");
    }
    const extension = pendingExtension;
    pendingExtension = undefined;
    if (
      extension?.linkpath !== undefined &&
      type !== "symlink" &&
      type !== "hardlink"
    ) {
      fail("RELEASE_IMAGE_TAR_EXTENSION");
    }
    const path = canonicalTarPath(header, type, extension?.path);
    if (paths.has(path)) fail("RELEASE_IMAGE_TAR_DUPLICATE", path);
    paths.add(path);
    if (type !== "file" && size !== 0) fail("RELEASE_IMAGE_TAR_HEADER");
    entries.push(
      Object.freeze({
        path,
        type,
        size,
        mode: tarOctal(header, 100, 8),
        uid: tarOctal(header, 108, 8),
        gid: tarOctal(header, 116, 8),
        linkname: extension?.linkpath ?? tarString(header, 157, 100),
        content,
      }),
    );
    offset = nextOffset;
  }
  if (!sawTerminator) fail("RELEASE_IMAGE_TAR_TERMINATOR");
  return entries;
}

function parseJson(bytes) {
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_JSON_BYTES) {
    fail("RELEASE_IMAGE_JSON_BOUNDS");
  }
  try {
    return parseStrictJsonBytes(bytes, "RELEASE_IMAGE_JSON_INVALID");
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    fail("RELEASE_IMAGE_JSON_INVALID");
  }
}

function descriptor(value, allowedMediaTypes) {
  const item = record(value, "RELEASE_IMAGE_DESCRIPTOR");
  allowedKeys(item, ["mediaType", "digest", "size", "annotations", "platform", "urls"], "RELEASE_IMAGE_DESCRIPTOR");
  if (!allowedMediaTypes.has(item.mediaType)) fail("RELEASE_IMAGE_MEDIA_TYPE");
  const itemDigest = digest(item.digest);
  if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_LAYER_BYTES) {
    fail("RELEASE_IMAGE_DESCRIPTOR");
  }
  return Object.freeze({ mediaType: item.mediaType, digest: itemDigest, size: item.size, raw: item });
}

function assertBlob(entries, item) {
  const path = `blobs/sha256/${item.digest.slice(7)}`;
  const entry = entries.get(path);
  if (!entry || entry.type !== "file") fail("RELEASE_IMAGE_BLOB_MISSING");
  if (entry.size !== item.size) fail("RELEASE_IMAGE_BLOB_SIZE");
  if (sha256Digest(entry.content) !== item.digest) fail("RELEASE_IMAGE_BLOB_DIGEST");
  return entry.content;
}

function createSensitiveScanBudget() {
  return { sourceBytes: 0, tokens: 0, credentialKeys: 0, comments: 0 };
}

function chargeSensitiveSource(budget, bytes, path) {
  budget.sourceBytes += bytes;
  if (budget.sourceBytes > MAX_SENSITIVE_SOURCE_BYTES) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  }
}

function chargeSensitiveToken(state) {
  state.budget.tokens += 1;
  if (state.budget.tokens > MAX_SENSITIVE_TOKENS) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
  }
}

function chargeCredentialKey(budget, path) {
  budget.credentialKeys += 1;
  if (budget.credentialKeys > MAX_CREDENTIAL_KEY_MATCHES) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  }
}

function significantLiteralCharacters(source) {
  let count = 0;
  for (const character of source) {
    if (!/\s/.test(character)) count += 1;
    if (count >= MIN_CREDENTIAL_LITERAL_CHARACTERS) break;
  }
  return count;
}

function decodeUnicodeEscapes(source) {
  return source.replace(
    /\\u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))/g,
    (_, braced, fixed) => {
      const value = Number.parseInt(braced ?? fixed, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : "\ufffd";
    },
  );
}

function lexicalCredentialSegments(source) {
  return decodeUnicodeEscapes(source)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function lexicalCredentialTermAt(segments, index) {
  if (["password", "secret", "token", "credential", "credentials"].includes(segments[index])) {
    return 1;
  }
  return ["private", "api"].includes(segments[index]) && segments[index + 1] === "key"
    ? 2
    : 0;
}

function lexicalCredentialKey(source) {
  const segments = lexicalCredentialSegments(source);
  for (let index = 0; index < segments.length; index += 1) {
    const width = lexicalCredentialTermAt(segments, index);
    if (width === 0) continue;
    const suffix = segments[index + width];
    const laterCredential = segments.some(
      (_, laterIndex) =>
        laterIndex >= index + width && lexicalCredentialTermAt(segments, laterIndex) > 0,
    );
    const metadataRole = suffix !== undefined && CREDENTIAL_METADATA_SUFFIXES.has(suffix);
    if (laterCredential || !metadataRole) {
      return true;
    }
    index += width - 1;
  }
  return false;
}

function embeddedKeyBefore(source, keyEnd, recordStart) {
  let cursor = keyEnd - 1;
  if (cursor < recordStart) return "";
  if (["'", '"', "`"].includes(source[cursor])) {
    const quote = source[cursor];
    const end = cursor;
    cursor -= 1;
    while (cursor >= recordStart && end - cursor <= 128) {
      if (source[cursor] === quote && source[cursor - 1] !== "\\") {
        return source.slice(cursor + 1, end);
      }
      cursor -= 1;
    }
    return "";
  }
  const end = cursor + 1;
  while (
    cursor >= recordStart &&
    end - cursor <= 128 &&
    /[A-Za-z0-9_$ .\\-]/.test(source[cursor])
  ) {
    cursor -= 1;
  }
  return source.slice(cursor + 1, end).trim();
}

function embeddedValueCharacters(source, separator) {
  let cursor = separator + 1;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  const quote = ["'", '"', "`"].includes(source[cursor]) ? source[cursor++] : undefined;
  let count = 0;
  let escaped = false;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\0") {
      break;
    } else if (escaped) {
      escaped = false;
      if (!/\s/.test(character)) count += 1;
    } else if (character === "\\") {
      escaped = true;
    } else if ((quote && character === quote) || (!quote && /[\s,;}\]]/.test(character))) {
      break;
    } else if (!/\s/.test(character)) {
      count += 1;
    }
    if (count >= MIN_CREDENTIAL_LITERAL_CHARACTERS) break;
  }
  return count;
}

function embeddedQuotedValue(source, separator) {
  let cursor = separator + 1;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  const quote = source[cursor];
  if (quote !== "'" && quote !== '"') return undefined;
  const valueStart = ++cursor;
  while (cursor < source.length && source[cursor] !== quote) {
    if (
      source[cursor] === "\0" ||
      source[cursor] === "\\" ||
      source[cursor] === "\n" ||
      source[cursor] === "\r"
    ) {
      return undefined;
    }
    cursor += 1;
  }
  if (cursor >= source.length) return undefined;
  return { value: source.slice(valueStart, cursor), end: cursor + 1 };
}

function isSafeEmbeddedCredentialControl(source, valueSeparator, key) {
  if (lexicalCredentialSegments(key).join("_") !== "credentials") return false;
  const quoted = embeddedQuotedValue(source, valueSeparator);
  if (!quoted || !SAFE_CREDENTIAL_CONTROL_VALUES.has(quoted.value)) return false;
  let cursor = quoted.end;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor >= source.length || source[cursor] === "\0" || /[,;}\])]/.test(source[cursor]);
}

function hasEmbeddedCredentialAssignment(source) {
  let recordStart = 0;
  let blockCommentStart = -1;
  let blockCommentTriviaStart = -1;
  let trailingTriviaStart = -1;
  let operatorRunStart = -1;
  let operatorKeyEnd = -1;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\0") {
      recordStart = cursor + 1;
      blockCommentStart = -1;
      blockCommentTriviaStart = -1;
      trailingTriviaStart = -1;
      operatorRunStart = -1;
      operatorKeyEnd = -1;
      continue;
    }

    if (
      blockCommentStart >= recordStart &&
      source[cursor] === "*" &&
      source[cursor + 1] === "/"
    ) {
      blockCommentStart = -1;
      trailingTriviaStart = blockCommentTriviaStart;
      blockCommentTriviaStart = -1;
      operatorRunStart = -1;
      operatorKeyEnd = -1;
      cursor += 1;
      continue;
    }

    if (
      blockCommentStart < recordStart &&
      source[cursor] === "/" &&
      source[cursor + 1] === "*"
    ) {
      blockCommentStart = cursor;
      blockCommentTriviaStart =
        trailingTriviaStart >= recordStart ? trailingTriviaStart : cursor;
      trailingTriviaStart = -1;
      operatorRunStart = -1;
      operatorKeyEnd = -1;
      cursor += 1;
      continue;
    }

    const contextStart = blockCommentStart >= recordStart ? blockCommentStart + 2 : recordStart;
    if (source[cursor] === ":" || source[cursor] === "=") {
      const compoundAssignment =
        source[cursor] === "=" && operatorRunStart >= contextStart;
      const keyEnd = compoundAssignment
        ? operatorKeyEnd
        : trailingTriviaStart >= contextStart
          ? trailingTriviaStart
          : cursor;
      const key = embeddedKeyBefore(source, keyEnd, contextStart);
      const credentialControl = lexicalCredentialSegments(key).join("_") === "credentials";
      const quotedValue = credentialControl ? embeddedQuotedValue(source, cursor) : undefined;
      if (
        lexicalCredentialKey(key) &&
        !isSafeEmbeddedCredentialControl(source, cursor, key) &&
        (embeddedValueCharacters(source, cursor) >= MIN_CREDENTIAL_LITERAL_CHARACTERS ||
          (credentialControl && quotedValue !== undefined))
      ) {
        return true;
      }
      trailingTriviaStart = -1;
      operatorRunStart = -1;
      operatorKeyEnd = -1;
      continue;
    }

    if (/\s/.test(source[cursor])) {
      if (trailingTriviaStart < contextStart) trailingTriviaStart = cursor;
      operatorRunStart = -1;
      operatorKeyEnd = -1;
      continue;
    }

    if (/[|?&+\-*\/%]/.test(source[cursor])) {
      if (operatorRunStart < contextStart) {
        operatorRunStart = cursor;
        operatorKeyEnd =
          trailingTriviaStart >= contextStart ? trailingTriviaStart : cursor;
      }
      trailingTriviaStart = -1;
      continue;
    }

    trailingTriviaStart = -1;
    operatorRunStart = -1;
    operatorKeyEnd = -1;
  }
  return false;
}

function isLexicalWhitespace(character) {
  return character !== undefined && /\s/.test(character);
}

function isJsIdentifierStart(character) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return /[A-Za-z_$]/.test(character) || character === "\\" || code >= 0x80;
}

function isJsIdentifierPart(character) {
  return isJsIdentifierStart(character) || (character !== undefined && /[0-9]/.test(character));
}

function decodeJsEscape(source, cursor, path) {
  const escape = source[cursor + 1];
  if (escape === undefined) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  if (escape === "x") {
    const digits = source.slice(cursor + 2, cursor + 4);
    if (!/^[0-9A-Fa-f]{2}$/.test(digits)) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), cursor: cursor + 4 };
  }
  if (escape === "u") {
    if (source[cursor + 2] === "{") {
      const end = source.indexOf("}", cursor + 3);
      const digits = end === -1 ? "" : source.slice(cursor + 3, end);
      const value = Number.parseInt(digits, 16);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(digits) || value > 0x10ffff) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      return { value: String.fromCodePoint(value), cursor: end + 1 };
    }
    const digits = source.slice(cursor + 2, cursor + 6);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), cursor: cursor + 6 };
  }
  if (escape === "\n") return { value: "", cursor: cursor + 2 };
  if (escape === "\r") {
    return { value: "", cursor: cursor + (source[cursor + 2] === "\n" ? 3 : 2) };
  }
  const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
  return { value: simple[escape] ?? escape, cursor: cursor + 2 };
}

function pushLexicalToken(state, tokens, token) {
  chargeSensitiveToken(state);
  const lexicalToken = { ...token, lineBreakBefore: state.lineBreakBefore };
  tokens.push(lexicalToken);
  state.lineBreakBefore = false;
  return lexicalToken;
}

function inspectLexicalComment(state, content) {
  state.budget.comments += 1;
  if (
    state.budget.comments > MAX_CREDENTIAL_COMMENT_SPANS ||
    hasEmbeddedCredentialAssignment(content)
  ) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
  }
}

function skipLexicalTrivia(state) {
  const { source } = state;
  let progressed = true;
  while (progressed && state.cursor < source.length) {
    progressed = false;
    while (isLexicalWhitespace(source[state.cursor])) {
      if (source[state.cursor] === "\n" || source[state.cursor] === "\r") {
        state.lineBreakBefore = true;
      }
      state.cursor += 1;
      progressed = true;
    }
    if (source.startsWith("#!", state.cursor) && state.cursor === 0) {
      const end = source.indexOf("\n", state.cursor + 2);
      inspectLexicalComment(
        state,
        source.slice(state.cursor + 2, end === -1 ? source.length : end),
      );
      state.cursor = end === -1 ? source.length : end;
      progressed = true;
    } else if (source.startsWith("//", state.cursor)) {
      const end = source.indexOf("\n", state.cursor + 2);
      inspectLexicalComment(
        state,
        source.slice(state.cursor + 2, end === -1 ? source.length : end),
      );
      state.cursor = end === -1 ? source.length : end;
      progressed = true;
    } else if (source.startsWith("/*", state.cursor)) {
      const end = source.indexOf("*/", state.cursor + 2);
      if (end === -1) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
      const comment = source.slice(state.cursor + 2, end);
      if (comment.includes("\n") || comment.includes("\r")) state.lineBreakBefore = true;
      inspectLexicalComment(state, comment);
      state.cursor = end + 2;
      progressed = true;
    }
  }
}

function isEmbeddedJavaScriptSource(value) {
  if (value.length < 32) return false;
  const trimmed = value.trim();
  return (
    /^(?:"use strict"|'use strict');/.test(trimmed) ||
    (/^\{\s*["']/.test(trimmed) && trimmed.endsWith("}"))
  );
}

function scanEmbeddedJavaScriptSource(state, source) {
  const embeddedSourceDepth = (state.embeddedSourceDepth ?? 0) + 1;
  if (embeddedSourceDepth > MAX_TEMPLATE_NESTING) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
  }
  const embeddedState = {
    source,
    cursor: 0,
    path: state.path,
    budget: state.budget,
    lineBreakBefore: false,
    embeddedSourceDepth,
  };
  analyzeCredentialTokens(scanJsTokens(embeddedState), state.path, state.budget);
}

function scanJsString(state) {
  const { source, path } = state;
  const start = state.cursor;
  const quote = source[state.cursor++];
  let value = "";
  while (state.cursor < source.length) {
    const character = source[state.cursor];
    if (character === quote) {
      state.cursor += 1;
      if (isEmbeddedJavaScriptSource(value)) {
        scanEmbeddedJavaScriptSource(state, value);
      } else if (hasEmbeddedCredentialAssignment(value)) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      return { kind: "string", value, start, end: state.cursor };
    }
    if (character === "\n" || character === "\r") {
      fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
    }
    if (character === "\\") {
      const decoded = decodeJsEscape(source, state.cursor, path);
      value += decoded.value;
      state.cursor = decoded.cursor;
    } else {
      value += character;
      state.cursor += 1;
    }
  }
  fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
}

function scanJsIdentifier(state) {
  const { source, path } = state;
  const start = state.cursor;
  let value = "";
  while (state.cursor < source.length && isJsIdentifierPart(source[state.cursor])) {
    if (source[state.cursor] === "\\") {
      const decoded = decodeJsEscape(source, state.cursor, path);
      if (decoded.cursor === state.cursor + 2 || !isJsIdentifierPart(decoded.value)) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      value += decoded.value;
      state.cursor = decoded.cursor;
    } else {
      value += source[state.cursor++];
    }
  }
  return { kind: "identifier", value, start, end: state.cursor };
}

function scanJsNumber(state) {
  const start = state.cursor;
  const number = /(?:0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?n?|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?)/y;
  number.lastIndex = start;
  const match = number.exec(state.source);
  if (!match) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
  state.cursor = number.lastIndex;
  return { kind: "number", value: match[0], start, end: state.cursor };
}

function isPunctuator(token, value) {
  return token?.kind === "punctuator" && token.value === value;
}

function canStartRegex(tokens) {
  const previous = tokens.at(-1);
  if (!previous) return true;
  if (isPunctuator(previous, ")") && previous.closesControlParenthesis) return true;
  if (isPunctuator(previous, "}") && previous.closesBlock) return true;
  if (previous.contextualRegexPrefix) return true;
  if (["string", "number", "template", "regex"].includes(previous.kind)) return false;
  if (previous.kind === "identifier") {
    return [
      "await",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "return",
      "throw",
      "typeof",
      "void",
      "yield",
    ].includes(previous.value);
  }
  return !(
    previous.kind === "punctuator" &&
    [")", "]", "}", "++", "--"].includes(previous.value)
  );
}

function scanJsRegex(state) {
  const { source, path } = state;
  const start = state.cursor++;
  let escaped = false;
  let characterClass = false;
  while (state.cursor < source.length) {
    const character = source[state.cursor++];
    if (character === "\n" || character === "\r") {
      fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
    }
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "[") characterClass = true;
    else if (character === "]") characterClass = false;
    else if (character === "/" && !characterClass) {
      while (/[A-Za-z]/.test(source[state.cursor] ?? "")) state.cursor += 1;
      return {
        kind: "regex",
        value: source.slice(start, state.cursor),
        start,
        end: state.cursor,
      };
    }
  }
  fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
}

function scanJsPunctuator(state) {
  const start = state.cursor;
  const operators = [
    ">>>=", "===", "!==", "**=", "&&=", "||=", "??=", "<<=", ">>=", ">>>", "...",
    "=>", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "?.", "+=", "-=",
    "*=", "/=", "%=", "**", "<<", ">>", "&=", "|=", "^=",
  ];
  const value =
    operators.find((operator) => state.source.startsWith(operator, start)) ?? state.source[start];
  state.cursor += value.length;
  return { kind: "punctuator", value, start, end: state.cursor };
}

function scanJsTemplate(state, nesting) {
  if (nesting > MAX_TEMPLATE_NESTING) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
  }
  const { source, path } = state;
  const start = state.cursor++;
  const expressions = [];
  let staticCharacters = 0;
  let staticValue = "";
  while (state.cursor < source.length) {
    const character = source[state.cursor];
    if (character === "`") {
      state.cursor += 1;
      if (hasEmbeddedCredentialAssignment(staticValue)) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      staticCharacters = Math.min(
        MIN_CREDENTIAL_LITERAL_CHARACTERS,
        staticCharacters + significantLiteralCharacters(staticValue),
      );
      return {
        kind: "template",
        value: "",
        staticCharacters,
        expressions,
        start,
        end: state.cursor,
      };
    }
    if (source.startsWith("${", state.cursor)) {
      if (hasEmbeddedCredentialAssignment(staticValue)) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      staticCharacters = Math.min(
        MIN_CREDENTIAL_LITERAL_CHARACTERS,
        staticCharacters + significantLiteralCharacters(staticValue),
      );
      staticValue = "";
      state.cursor += 2;
      expressions.push(scanJsTokens(state, true, nesting + 1));
      continue;
    }
    if (character === "\\") {
      const decoded = decodeJsEscape(source, state.cursor, path);
      staticValue += decoded.value;
      state.cursor = decoded.cursor;
    } else {
      staticValue += character;
      state.cursor += 1;
    }
  }
  fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
}

function scanJsTokens(state, stopOnTemplateBrace = false, nesting = 0) {
  const tokens = [];
  const delimiters = [];
  let braceDepth = 0;
  while (state.cursor < state.source.length) {
    skipLexicalTrivia(state);
    if (state.cursor >= state.source.length) break;
    const character = state.source[state.cursor];
    if (stopOnTemplateBrace && character === "}" && braceDepth === 0) {
      state.cursor += 1;
      return tokens;
    }
    let token;
    if (character === "'" || character === '"') token = scanJsString(state);
    else if (character === "`") token = scanJsTemplate(state, nesting);
    else if (isJsIdentifierStart(character)) token = scanJsIdentifier(state);
    else if (
      /[0-9]/.test(character) ||
      (character === "." && /[0-9]/.test(state.source[state.cursor + 1] ?? ""))
    ) {
      token = scanJsNumber(state);
    } else if (
      character === "/" &&
      !state.source.startsWith("//", state.cursor) &&
      !state.source.startsWith("/*", state.cursor) &&
      canStartRegex(tokens)
    ) {
      token = scanJsRegex(state);
    } else {
      token = scanJsPunctuator(state);
    }
    if (token.kind === "punctuator" && [")", "]", "}"].includes(token.value)) {
      const active = delimiters.pop();
      if (isPunctuator(token, ")") && active?.value === "(") {
        token.closesControlParenthesis = active.control;
      } else if (isPunctuator(token, "}") && active?.value === "{") {
        token.closesBlock = active.block;
      }
    }
    const lexicalToken = pushLexicalToken(state, tokens, token);
    if (token.kind === "punctuator" && ["(", "[", "{"].includes(token.value)) {
      const previous = tokens.at(-2);
      const controlKeyword =
        isPunctuator(token, "(") &&
        previous?.kind === "identifier" &&
        ["catch", "for", "if", "switch", "while", "with"].includes(previous.value)
          ? previous.value
          : undefined;
      delimiters.push({
        value: token.value,
        control: controlKeyword !== undefined,
        controlKeyword,
        block:
          isPunctuator(token, "{") &&
          (previous?.closesControlParenthesis ||
            (previous?.kind === "identifier" &&
              ["do", "else", "finally", "try"].includes(previous.value)) ||
            isPunctuator(previous, "=>")),
      });
    }
    if (token.closesControlParenthesis) lexicalToken.closesControlParenthesis = true;
    if (token.closesBlock) lexicalToken.closesBlock = true;
    if (
      token.kind === "identifier" &&
      token.value === "of" &&
      delimiters.some(
        (delimiter) => delimiter.value === "(" && delimiter.controlKeyword === "for",
      )
    ) {
      lexicalToken.contextualRegexPrefix = true;
    }
    if (isPunctuator(token, "{")) braceDepth += 1;
    else if (isPunctuator(token, "}") && braceDepth > 0) braceDepth -= 1;
  }
  if (stopOnTemplateBrace) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", state.path);
  return tokens;
}

function canEndJsExpression(token) {
  if (token?.kind === "identifier") {
    return !["await", "delete", "new", "typeof", "void", "yield"].includes(token.value);
  }
  return (
    token !== undefined &&
    (["number", "regex", "string", "template"].includes(token.kind) ||
      (token.kind === "punctuator" && [")", "]", "}", "++", "--"].includes(token.value)))
  );
}

function credentialTokenContext(tokens, path) {
  const opening = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]);
  const closing = new Map([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  const stack = [];
  const parentheses = [];
  const depthBefore = [];
  const containingParenthesis = [];
  const boundary = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    depthBefore[index] = stack.length;
    containingParenthesis[index] = parentheses.at(-1);
    boundary[index] =
      (token.kind === "punctuator" && [",", ";", ")", "]", "}"].includes(token.value)) ||
      (token.lineBreakBefore &&
        token.kind === "identifier" &&
        (["class", "const", "export", "function", "import", "let", "var"].includes(
          token.value,
        ) ||
          canEndJsExpression(tokens[index - 1])));
    if (token.kind === "punctuator" && opening.has(token.value)) {
      stack.push({ value: token.value, index });
      if (isPunctuator(token, "(")) parentheses.push(index);
    } else if (token.kind === "punctuator" && closing.has(token.value)) {
      const active = stack.pop();
      if (active?.value !== closing.get(token.value)) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      if (isPunctuator(token, ")")) parentheses.pop();
    }
  }
  if (stack.length > 0) fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);

  const nextBoundaryAtDepth = new Map();
  const nextBoundary = [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    nextBoundary[index] = nextBoundaryAtDepth.get(depthBefore[index]) ?? tokens.length;
    if (boundary[index]) nextBoundaryAtDepth.set(depthBefore[index], index);
  }
  return { boundary, containingParenthesis, depthBefore, nextBoundary };
}

function lexicalCalleeBefore(tokens, openingParenthesis) {
  let cursor = openingParenthesis - 1;
  const parts = [];
  while (cursor >= 0 && parts.length < 64) {
    const token = tokens[cursor];
    if (token.kind === "identifier" || isPunctuator(token, ".") || isPunctuator(token, "?.")) {
      parts.unshift(isPunctuator(token, "?.") ? "." : token.value);
      cursor -= 1;
    } else {
      break;
    }
  }
  return parts.join("");
}

function isCredentialLookupString(tokens, index, context) {
  const token = tokens[index];
  const propertyPrefix = tokens[index - 1];
  const computedPropertyPrefix = tokens[index - 2];
  if (
    ((isPunctuator(propertyPrefix, "{") || isPunctuator(propertyPrefix, ",")) &&
      isPunctuator(tokens[index + 1], ":")) ||
    (isPunctuator(tokens[index - 1], "[") &&
      isPunctuator(tokens[index + 1], "]") &&
      isPunctuator(tokens[index + 2], ":") &&
      (isPunctuator(computedPropertyPrefix, "{") ||
        isPunctuator(computedPropertyPrefix, ",")))
  ) {
    return true;
  }
  if (!lexicalCredentialKey(token.value)) return false;
  if (isPunctuator(tokens[index - 1], "[") && isPunctuator(tokens[index + 1], "]")) {
    const base = tokens[index - 2];
    if (
      base &&
      (base.kind === "identifier" ||
        (base.kind === "punctuator" && [")", "]"].includes(base.value)))
    ) {
      return true;
    }
    const optionalBase = isPunctuator(base, "?.") ? tokens[index - 3] : undefined;
    if (
      optionalBase &&
      (optionalBase.kind === "identifier" ||
        (optionalBase.kind === "punctuator" && [")", "]"].includes(optionalBase.value)))
    ) {
      return true;
    }
  }
  const openingParenthesis = context.containingParenthesis[index];
  if (openingParenthesis === undefined) return false;
  const callee = lexicalCalleeBefore(tokens, openingParenthesis);
  return callee === "Reflect.get" || callee.endsWith(".get") || callee === "vault.read";
}

function numericLiteralCharacters(source) {
  const normalized = source.replaceAll("_", "").replace(/n$/i, "");
  const digits = /^0[xob]/i.test(normalized) ? normalized.slice(2) : normalized;
  return [...digits].filter((character) => /[0-9A-Fa-f]/.test(character)).length;
}

function credentialTokenLiteralWeight(tokens, index, context, templateCharacters) {
  const token = tokens[index];
  if (token.kind === "regex") return MIN_CREDENTIAL_LITERAL_CHARACTERS;
  if (
    token.kind === "number" &&
    numericLiteralCharacters(token.value) >= MIN_CREDENTIAL_LITERAL_CHARACTERS
  ) {
    return MIN_CREDENTIAL_LITERAL_CHARACTERS;
  }
  if (token.kind === "string" && !isCredentialLookupString(tokens, index, context)) {
    return significantLiteralCharacters(token.value);
  }
  if (token.kind === "template") {
    return token.staticCharacters + (templateCharacters.get(token) ?? 0);
  }
  return 0;
}

function isCredentialAssignmentOperator(token) {
  if (token?.kind !== "punctuator") return false;
  return [":", "=", "||=", "??=", "&&=", "+=", "-=", "*=", "/=", "%="].includes(
    token.value,
  );
}

function isObjectPropertyIntroducer(token) {
  return isPunctuator(token, "{") || isPunctuator(token, ",");
}

function credentialAssignmentTokenIndex(tokens, index) {
  const directOperator = tokens[index + 1];
  if (
    isCredentialAssignmentOperator(directOperator) &&
    (!isPunctuator(directOperator, ":") || isObjectPropertyIntroducer(tokens[index - 1]))
  ) {
    return index + 1;
  }
  const computedOperator = tokens[index + 2];
  if (
    isPunctuator(tokens[index - 1], "[") &&
    isPunctuator(tokens[index + 1], "]") &&
    isCredentialAssignmentOperator(computedOperator) &&
    (!isPunctuator(computedOperator, ":") || isObjectPropertyIntroducer(tokens[index - 2]))
  ) {
    return index + 2;
  }
  return undefined;
}

function isMemberCredentialKey(tokens, index) {
  return (
    isPunctuator(tokens[index - 1], ".") ||
    isPunctuator(tokens[index - 1], "?.") ||
    isPunctuator(tokens[index - 1], "[")
  );
}

function isCredentialComparisonOperator(token) {
  return (
    token?.kind === "punctuator" &&
    ["==", "===", "!=", "!==", "<", "<=", ">", ">="].includes(token.value)
  );
}

function isCallableCredentialExpression(key, tokens, start, end, context, literalWeight) {
  const segments = lexicalCredentialSegments(key.value);
  const callableRole =
    (segments.at(-1) === "error" &&
      segments.some((_, index) => lexicalCredentialTermAt(segments, index) > 0)) ||
    (CREDENTIAL_CODE_CALLABLE_PREFIXES.has(segments[0]) && segments.includes("token"));
  if (!callableRole) return false;
  let callable = false;
  if (
    tokens[start]?.kind === "identifier" &&
    (tokens[start].value === "function" ||
      (tokens[start].value === "async" && tokens[start + 1]?.value === "function"))
  ) {
    callable = true;
  }
  if (!callable) {
    const expressionDepth = context.depthBefore[start];
    for (let index = start; index < end; index += 1) {
      if (isPunctuator(tokens[index], "=>") && context.depthBefore[index] === expressionDepth) {
        callable = true;
        break;
      }
    }
  }
  if (!callable || literalWeight === 0) return callable;

  const allowedStrings =
    key.value === "TokenExpiredError"
      ? new Set(["TokenExpiredError"])
      : key.value === "getNextToken"
        ? new Set(["/", "BlockComment", "LineComment"])
        : undefined;
  if (!allowedStrings) return false;
  let allowedWeight = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.kind === "string") {
      if (!allowedStrings.has(token.value)) return false;
      allowedWeight += significantLiteralCharacters(token.value);
    } else if (token.kind === "regex" || token.kind === "template") {
      return false;
    } else if (
      token.kind === "number" &&
      numericLiteralCharacters(token.value) >= MIN_CREDENTIAL_LITERAL_CHARACTERS
    ) {
      return false;
    }
  }
  return allowedWeight === literalWeight;
}

function isDiagnosticCredentialExpression(key, tokens, start, end) {
  if (end - start !== 1 || tokens[start]?.kind !== "string") return false;
  const segments = lexicalCredentialSegments(key.value);
  return (
    segments[0] === "unexpected" &&
    segments.includes("token") &&
    /^unexpected token\b/i.test(tokens[start].value)
  );
}

function isPublicHeaderCredentialExpression(key, tokens, start, end) {
  if (end - start !== 1 || tokens[start]?.kind !== "string") return false;
  const segments = lexicalCredentialSegments(key.value);
  return (
    segments.at(-1) === "header" &&
    segments.some((segment) => ["key", "password", "secret", "token"].includes(segment)) &&
    /^x-[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(tokens[start].value)
  );
}

function isPredicateCredentialExpression(key, tokens, start, end) {
  const segments = lexicalCredentialSegments(key.value);
  if (
    segments[0] !== "is" ||
    tokens[start]?.kind !== "regex" ||
    tokens[start].value !== "/^(?:NODE_.+)|^(?:__.+)$/i"
  ) {
    return false;
  }
  for (let index = start + 1; index < end; index += 1) {
    if (
      tokens[index]?.kind === "identifier" &&
      tokens[index].value === "test" &&
      isPunctuator(tokens[index - 1], ".")
    ) {
      return true;
    }
  }
  return false;
}

function isMimeMetadataCredentialExpression(key, tokens, start) {
  return (
    key.kind === "string" &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(key.value) &&
    isPunctuator(tokens[start], "{")
  );
}

function hasOnlyCredentialRoleLiterals(tokens, start, end) {
  let controls = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.kind === "string") {
      if (!SAFE_CREDENTIAL_ROLE_VALUES.has(token.value)) return false;
      controls += 1;
    } else if (token.kind === "regex" || token.kind === "template") {
      return false;
    } else if (
      token.kind === "number" &&
      numericLiteralCharacters(token.value) >= MIN_CREDENTIAL_LITERAL_CHARACTERS
    ) {
      return false;
    }
  }
  return controls > 0;
}

function isFetchCredentialControlPredicate(tokens, start, end) {
  let comparisons = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.kind === "string") {
      if (
        !SAFE_CREDENTIAL_PREDICATE_VALUES.has(token.value) ||
        (!isCredentialComparisonOperator(tokens[index - 1]) &&
          !isCredentialComparisonOperator(tokens[index + 1]))
      ) {
        return false;
      }
      comparisons += 1;
    } else if (token.kind === "regex" || token.kind === "template") {
      return false;
    } else if (
      token.kind === "number" &&
      numericLiteralCharacters(token.value) >= MIN_CREDENTIAL_LITERAL_CHARACTERS
    ) {
      return false;
    }
  }
  return comparisons > 0;
}

function isPublicCharacterClassRegex(token) {
  return (
    token?.kind === "regex" &&
    /^\/\^\[(?:\\.|[^\]])+\]\+\$\/[A-Za-z]*$/.test(token.value)
  );
}

function isCodeMetadataCredentialExpression(key, tokens, start, end, literalWeight) {
  const segments = lexicalCredentialSegments(key.value);
  const credentialIndex = segments.findIndex(
    (_, index) => lexicalCredentialTermAt(segments, index) > 0,
  );
  const credentialWidth =
    credentialIndex === -1 ? 0 : lexicalCredentialTermAt(segments, credentialIndex);
  const suffix = segments[credentialIndex + credentialWidth];
  if (
    CREDENTIAL_CODE_METADATA_SUFFIXES.has(suffix) &&
    (literalWeight === 0 || (end - start === 1 && isPublicCharacterClassRegex(tokens[start])))
  ) {
    return true;
  }
  if (
    credentialIndex > 0 &&
    ["credential", "credentials"].includes(segments[credentialIndex]) &&
    CREDENTIAL_CONTROL_PREFIXES.has(segments[credentialIndex - 1]) &&
    suffix === undefined &&
    (literalWeight === 0 ||
      hasOnlyCredentialRoleLiterals(tokens, start, end) ||
      isFetchCredentialControlPredicate(tokens, start, end))
  ) {
    return true;
  }
  if (
    segments.length === 2 &&
    segments[0] === "strict" &&
    segments[1] === "token" &&
    isPunctuator(tokens[start], "[")
  ) {
    let stringCount = 0;
    let stringWeight = 0;
    for (let index = start; index < end; index += 1) {
      if (tokens[index].kind !== "string") continue;
      stringCount += 1;
      const weight = significantLiteralCharacters(tokens[index].value);
      if (weight > 1) return false;
      stringWeight += weight;
    }
    return stringCount > 0 && literalWeight === stringWeight;
  }
  return false;
}

function analyzeCredentialTokens(tokens, path, budget) {
  const templateCharacters = new Map();
  for (const token of tokens) {
    if (token.kind === "template") {
      let characters = 0;
      for (const expression of token.expressions) {
        characters += analyzeCredentialTokens(expression, path, budget);
      }
      templateCharacters.set(token, characters);
    }
  }
  const context = credentialTokenContext(tokens, path);
  const literalPrefix = [0];
  const dynamicInvalidPrefix = [0];
  const dynamicReferencePrefix = [0];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const credentialLookupString =
      token.kind === "string" && isCredentialLookupString(tokens, index, context);
    const safeCredentialComparisonString =
      token.kind === "string" &&
      SAFE_CREDENTIAL_PREDICATE_VALUES.has(token.value) &&
      (isCredentialComparisonOperator(tokens[index - 1]) ||
        isCredentialComparisonOperator(tokens[index + 1]));
    literalPrefix[index + 1] =
      literalPrefix[index] +
      credentialTokenLiteralWeight(tokens, index, context, templateCharacters);
    dynamicInvalidPrefix[index + 1] =
      dynamicInvalidPrefix[index] +
      Number(
        (token.kind === "identifier" &&
          ["Infinity", "NaN", "false", "null", "true", "undefined"].includes(token.value)) ||
          (token.kind === "string" &&
            !credentialLookupString &&
            !safeCredentialComparisonString &&
            !SAFE_CREDENTIAL_CONTROL_VALUES.has(token.value)) ||
          (token.kind !== "identifier" &&
            token.kind !== "string" &&
            (token.kind !== "punctuator" ||
              ![
                "(", ")", ",", ".", "?.", "??", "||", "[", "]", "?", ":", "==", "===",
                "!=", "!==", "<", "<=", ">", ">=",
              ].includes(token.value))),
      );
    dynamicReferencePrefix[index + 1] =
      dynamicReferencePrefix[index] +
      Number(
        token.kind === "identifier" &&
          !["Infinity", "NaN", "false", "null", "true", "undefined"].includes(token.value),
      );
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokens[index];
    if (!["identifier", "string"].includes(key.kind) || !lexicalCredentialKey(key.value)) {
      continue;
    }
    const operatorIndex = credentialAssignmentTokenIndex(tokens, index);
    if (operatorIndex === undefined) continue;
    chargeCredentialKey(budget, path);
    const start = operatorIndex + 1;
    const end =
      start >= tokens.length
        ? tokens.length
        : context.boundary[start]
          ? start
          : context.nextBoundary[start];
    if (key.value.toLowerCase() === "credentials") {
      const safeControl =
        end - start === 1 &&
        tokens[start].kind === "string" &&
        SAFE_CREDENTIAL_CONTROL_VALUES.has(tokens[start].value);
      const dynamicReference =
        dynamicInvalidPrefix[end] === dynamicInvalidPrefix[start] &&
        dynamicReferencePrefix[end] > dynamicReferencePrefix[start];
      const emptyDataObject =
        end - start === 2 &&
        isPunctuator(tokens[start], "{") &&
        isPunctuator(tokens[start + 1], "}");
      if (!safeControl && !dynamicReference && !emptyDataObject) {
        fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
      }
      continue;
    }
    const literalWeight = literalPrefix[end] - literalPrefix[start];
    const codeRole =
      isCallableCredentialExpression(key, tokens, start, end, context, literalWeight) ||
      isDiagnosticCredentialExpression(key, tokens, start, end) ||
      isPublicHeaderCredentialExpression(key, tokens, start, end) ||
      isPredicateCredentialExpression(key, tokens, start, end) ||
      isMimeMetadataCredentialExpression(key, tokens, start) ||
      isCodeMetadataCredentialExpression(key, tokens, start, end, literalWeight);
    if (
      (!codeRole && literalWeight >= MIN_CREDENTIAL_LITERAL_CHARACTERS) ||
      (!codeRole &&
        !isPunctuator(tokens[operatorIndex], ":") &&
        !isMemberCredentialKey(tokens, index) &&
        key.value === key.value.toUpperCase() &&
        end > start)
    ) {
      fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
    }
  }
  return literalPrefix.at(-1);
}

function assertSensitiveContentLexically(bytes, canary, path, budget) {
  chargeSensitiveSource(budget, bytes.byteLength, path);
  if (bytes.includes(Buffer.from(canary, "utf8"))) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  }
  const source = bytes.toString("latin1");
  if (
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(source)
  ) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  }
  if (!/\.(?:c|m)?js$/i.test(path)) {
    if (hasEmbeddedCredentialAssignment(source)) {
      fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
    }
    return;
  }
  const state = { source, cursor: 0, path, budget, lineBreakBefore: false };
  const tokens = scanJsTokens(state);
  analyzeCredentialTokens(tokens, path, budget);
}

function assertSensitiveContent(bytes, canary, path, budget) {
  assertSensitiveContentLexically(bytes, canary, path, budget);
}

function appRoot(path) {
  const parts = path.split("/");
  return parts[0] === "app" && parts.length > 2 && ALLOWED_APP_ROOTS.has(parts[1])
    ? parts[1]
    : undefined;
}

function assertAllowedAppLocation(path) {
  const parts = path.split("/");
  if (parts[0] !== "app") return false;
  if (path !== "app") {
    const root = parts[1];
    const allowed =
      path === "app/server.js" ||
      path === "app/package.json" ||
      ALLOWED_APP_ROOTS.has(root);
    const lower = parts.map((part) => part.toLowerCase());
    const forbiddenSegment = lower.some(
      (part) =>
        part === ".git" ||
        part.startsWith(".env") ||
        part === ".cache" ||
        part === "cache" ||
        part === ".pnpm-store" ||
        part === "coverage",
    );
    if (!allowed || forbiddenSegment) fail("RELEASE_IMAGE_FORBIDDEN_PATH", path);
  }
  return true;
}

function containedLinkTarget(entry) {
  const linkname = entry.linkname;
  if (
    typeof linkname !== "string" ||
    linkname.length < 1 ||
    linkname.length > 4096 ||
    posix.isAbsolute(linkname) ||
    linkname.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(linkname)
  ) {
    fail("RELEASE_IMAGE_APP_LINK", entry.path);
  }
  const target = posix.normalize(
    entry.type === "symlink"
      ? posix.join(posix.dirname(entry.path), linkname)
      : linkname,
  ).replace(/^\.\//, "");
  if (
    !target.startsWith("app/") ||
    !assertAllowedAppLocation(target) ||
    !appRoot(entry.path) ||
    appRoot(entry.path) !== appRoot(target)
  ) {
    fail("RELEASE_IMAGE_APP_LINK", entry.path);
  }
  return target;
}

function assertAppPath(entry) {
  const parts = entry.path.split("/");
  if (parts[0] !== "app") return false;
  if (!["file", "directory", "symlink", "hardlink"].includes(entry.type)) {
    fail("RELEASE_IMAGE_APP_TYPE", entry.path);
  }
  assertAllowedAppLocation(entry.path);
  if (entry.uid !== 0 || entry.gid !== 0) {
    fail("RELEASE_IMAGE_APP_OWNER", entry.path);
  }
  if (entry.type === "symlink" || entry.type === "hardlink") {
    containedLinkTarget(entry);
    return true;
  }
  if ((entry.mode & 0o7022) !== 0) fail("RELEASE_IMAGE_APP_MODE", entry.path);
  return true;
}

function assertResolvableAppLinks(finalApp) {
  const paths = [...finalApp.keys()];
  for (const entry of finalApp.values()) {
    if (entry.type !== "symlink" && entry.type !== "hardlink") continue;
    const visited = new Set([entry.path]);
    let current = entry;
    for (let depth = 0; depth < 64; depth += 1) {
      const target = containedLinkTarget(current);
      if (visited.has(target)) fail("RELEASE_IMAGE_APP_LINK", entry.path);
      visited.add(target);
      const targetEntry = finalApp.get(target);
      if (!targetEntry) {
        if (
          current.type === "symlink" &&
          paths.some((path) => path.startsWith(`${target}/`))
        ) {
          break;
        }
        fail("RELEASE_IMAGE_APP_LINK", entry.path);
      }
      if (current.type === "hardlink" && targetEntry.type !== "file") {
        fail("RELEASE_IMAGE_APP_LINK", entry.path);
      }
      if (targetEntry.type !== "symlink" && targetEntry.type !== "hardlink") break;
      current = targetEntry;
      if (depth === 63) fail("RELEASE_IMAGE_APP_LINK", entry.path);
    }
  }
}

function assertRuntimeBaseAncestry(layerDescriptors, config) {
  const rootfs = record(config.rootfs, "RELEASE_IMAGE_ROOTFS");
  exactKeys(rootfs, ["type", "diff_ids"], "RELEASE_IMAGE_ROOTFS");
  if (rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids) || rootfs.diff_ids.length !== layerDescriptors.length) {
    fail("RELEASE_IMAGE_ROOTFS");
  }
  if (
    !Array.isArray(RUNTIME_BASE_IMAGE.layers) ||
    !Array.isArray(RUNTIME_BASE_IMAGE.diffIds) ||
    RUNTIME_BASE_IMAGE.layers.length !== RUNTIME_BASE_IMAGE.diffIds.length ||
    layerDescriptors.length <= RUNTIME_BASE_IMAGE.layers.length
  ) {
    fail("RELEASE_IMAGE_BASE_ANCESTRY");
  }
  for (let index = 0; index < RUNTIME_BASE_IMAGE.layers.length; index += 1) {
    const actualLayer = layerDescriptors[index];
    const expectedLayer = RUNTIME_BASE_IMAGE.layers[index];
    if (
      !actualLayer ||
      actualLayer.mediaType !== expectedLayer.mediaType ||
      actualLayer.digest !== expectedLayer.digest ||
      actualLayer.size !== expectedLayer.size ||
      rootfs.diff_ids[index] !== RUNTIME_BASE_IMAGE.diffIds[index]
    ) {
      fail("RELEASE_IMAGE_BASE_ANCESTRY");
    }
  }
  return RUNTIME_BASE_IMAGE.layers.length;
}

function inspectLayers(layerDescriptors, blobEntries, config, canary, baseLayerCount, scanBudget) {
  const rootfs = record(config.rootfs, "RELEASE_IMAGE_ROOTFS");
  const finalApp = new Map();
  let scannedBytes = 0;
  let totalLayerBytes = 0;
  let totalTarEntries = 0;
  layerDescriptors.forEach((item, index) => {
    if (index < baseLayerCount) {
      const optionalBaseBlob = blobEntries.get(`blobs/sha256/${item.digest.slice(7)}`);
      if (optionalBaseBlob !== undefined) assertBlob(blobEntries, item);
      return;
    }
    const compressed = assertBlob(blobEntries, item);
    let layer;
    try {
      layer =
        item.mediaType === "application/vnd.oci.image.layer.v1.tar+gzip"
          ? gunzipSync(compressed, { maxOutputLength: MAX_LAYER_BYTES })
          : Buffer.from(compressed);
    } catch {
      fail("RELEASE_IMAGE_LAYER_COMPRESSION");
    }
    if (digest(rootfs.diff_ids[index]) !== sha256Digest(layer)) {
      fail("RELEASE_IMAGE_LAYER_DIFF_ID");
    }
    totalLayerBytes += layer.byteLength;
    if (totalLayerBytes > MAX_TOTAL_LAYER_BYTES) fail("RELEASE_IMAGE_LAYER_BOUNDS");
    const layerEntries = parseTar(layer, "layer");
    totalTarEntries += layerEntries.length;
    if (totalTarEntries > MAX_TOTAL_TAR_ENTRIES) fail("RELEASE_IMAGE_TAR_BOUNDS");
    for (const entry of layerEntries) {
      if (!assertAppPath(entry)) fail("RELEASE_IMAGE_NON_BASE_PATH", entry.path);
      if (entry.type === "file") {
        if (entry.size > MAX_APP_FILE_BYTES) fail("RELEASE_IMAGE_APP_BOUNDS", entry.path);
        scannedBytes += entry.size;
        if (scannedBytes > MAX_APP_SCAN_BYTES) fail("RELEASE_IMAGE_APP_BOUNDS");
        assertSensitiveContent(entry.content, canary, entry.path, scanBudget);
      }
      finalApp.set(
        entry.path,
        Object.freeze({ path: entry.path, type: entry.type, linkname: entry.linkname }),
      );
    }
  });
  assertResolvableAppLinks(finalApp);
  const server = finalApp.get("app/server.js");
  if (!server || server.type !== "file") fail("RELEASE_IMAGE_SERVER_MISSING");
}

function inspectArchive(archive, arguments_) {
  const outer = parseTar(archive, "outer");
  const entries = new Map(outer.map((entry) => [entry.path, entry]));
  for (const entry of outer) {
    const allowedDirectory = entry.type === "directory" && ["blobs", "blobs/sha256"].includes(entry.path);
    const allowedFile =
      entry.type === "file" &&
      (entry.path === "oci-layout" ||
        entry.path === "index.json" ||
        /^blobs\/sha256\/[a-f0-9]{64}$/.test(entry.path));
    if (!allowedDirectory && !allowedFile) fail("RELEASE_IMAGE_OCI_PATH", entry.path);
  }

  const layoutEntry = entries.get("oci-layout");
  const indexEntry = entries.get("index.json");
  if (!layoutEntry || !indexEntry || layoutEntry.type !== "file" || indexEntry.type !== "file") {
    fail("RELEASE_IMAGE_OCI_LAYOUT");
  }
  const layout = parseJson(layoutEntry.content);
  exactKeys(layout, ["imageLayoutVersion"], "RELEASE_IMAGE_OCI_LAYOUT");
  if (layout.imageLayoutVersion !== "1.0.0") fail("RELEASE_IMAGE_OCI_LAYOUT");

  const index = record(parseJson(indexEntry.content), "RELEASE_IMAGE_INDEX");
  allowedKeys(index, ["schemaVersion", "mediaType", "manifests", "annotations"], "RELEASE_IMAGE_INDEX");
  if (index.schemaVersion !== 2 || index.mediaType !== INDEX_MEDIA_TYPE || !Array.isArray(index.manifests)) {
    fail("RELEASE_IMAGE_INDEX");
  }
  if (index.manifests.length !== 1) fail("RELEASE_IMAGE_MANIFEST_COUNT");
  const manifestDescriptor = descriptor(index.manifests[0], new Set([MANIFEST_MEDIA_TYPE]));
  if (manifestDescriptor.raw.platform !== undefined) {
    const platform = record(manifestDescriptor.raw.platform, "RELEASE_IMAGE_PLATFORM");
    allowedKeys(platform, ["os", "architecture", "variant", "os.version", "os.features"], "RELEASE_IMAGE_PLATFORM");
    if (platform.os !== RELEASE_PLATFORM.os || platform.architecture !== RELEASE_PLATFORM.architecture) {
      fail("RELEASE_IMAGE_PLATFORM");
    }
  }
  const manifestBytes = assertBlob(entries, manifestDescriptor);
  const manifest = record(parseJson(manifestBytes), "RELEASE_IMAGE_MANIFEST");
  allowedKeys(manifest, ["schemaVersion", "mediaType", "config", "layers", "annotations", "subject"], "RELEASE_IMAGE_MANIFEST");
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== MANIFEST_MEDIA_TYPE || !Array.isArray(manifest.layers)) {
    fail("RELEASE_IMAGE_MANIFEST");
  }
  if (manifest.layers.length < 1 || manifest.layers.length > 256) fail("RELEASE_IMAGE_LAYER_COUNT");
  const configDescriptor = descriptor(manifest.config, new Set([CONFIG_MEDIA_TYPE]));
  const layerDescriptors = manifest.layers.map((item) => descriptor(item, LAYER_MEDIA_TYPES));
  const configBytes = assertBlob(entries, configDescriptor);
  const config = record(parseJson(configBytes), "RELEASE_IMAGE_CONFIG");
  const baseLayerCount = assertRuntimeBaseAncestry(layerDescriptors, config);

  const referencedBlobs = new Set([
    manifestDescriptor.digest,
    configDescriptor.digest,
    ...layerDescriptors.map((item) => item.digest),
  ]);
  const blobPaths = outer
    .filter((entry) => entry.type === "file" && entry.path.startsWith("blobs/sha256/"))
    .map((entry) => `sha256:${entry.path.slice("blobs/sha256/".length)}`);
  const presentBlobs = new Set(blobPaths);
  const requiredBlobs = new Set([
    manifestDescriptor.digest,
    configDescriptor.digest,
    ...layerDescriptors.slice(baseLayerCount).map((item) => item.digest),
  ]);
  if (
    blobPaths.some((value) => !referencedBlobs.has(value)) ||
    [...requiredBlobs].some((value) => !presentBlobs.has(value))
  ) {
    fail("RELEASE_IMAGE_ORPHAN_BLOB");
  }

  if (config.os !== RELEASE_PLATFORM.os || config.architecture !== RELEASE_PLATFORM.architecture) {
    fail("RELEASE_IMAGE_PLATFORM");
  }
  const runtime = record(config.config, "RELEASE_IMAGE_CONFIG");
  allowedKeys(runtime, RELEASE_RUNTIME_CONFIG_FIELDS, "RELEASE_IMAGE_CONFIG");
  const expectedEnvironment = expectedReleaseRuntimeEnvironment(
    arguments_.surface,
    arguments_.sourceSha,
  );
  if (
    !Array.isArray(runtime.Env) ||
    runtime.Env.length !== expectedEnvironment.length ||
    runtime.Env.some((entry, index) => entry !== expectedEnvironment[index])
  ) {
    fail("RELEASE_IMAGE_ENVIRONMENT");
  }
  const exposedPorts = record(
    runtime.ExposedPorts,
    "RELEASE_IMAGE_EXPOSED_PORTS",
  );
  exactKeys(exposedPorts, ["3000/tcp"], "RELEASE_IMAGE_EXPOSED_PORTS");
  exactKeys(
    record(exposedPorts["3000/tcp"], "RELEASE_IMAGE_EXPOSED_PORTS"),
    [],
    "RELEASE_IMAGE_EXPOSED_PORTS",
  );
  if (runtime.User !== "65532:65532") fail("RELEASE_IMAGE_USER");
  if (runtime.WorkingDir !== "/app") fail("RELEASE_IMAGE_WORKDIR");
  if (
    !Array.isArray(runtime.Cmd) ||
    runtime.Cmd.length !== 2 ||
    runtime.Cmd[0] !== "/nodejs/bin/node" ||
    runtime.Cmd[1] !== "server.js"
  ) {
    fail("RELEASE_IMAGE_COMMAND");
  }
  if (runtime.ArgsEscaped !== true) fail("RELEASE_IMAGE_ARGS_ESCAPED");
  if (
    runtime.Entrypoint !== undefined &&
    runtime.Entrypoint !== null &&
    (!Array.isArray(runtime.Entrypoint) || runtime.Entrypoint.length !== 0)
  ) {
    fail("RELEASE_IMAGE_ENTRYPOINT");
  }
  const labels = record(runtime.Labels, "RELEASE_IMAGE_LABELS");
  exactKeys(labels, REQUIRED_LABELS, "RELEASE_IMAGE_LABELS");
  if (
    labels["org.opencontainers.image.source"] !== EXPECTED_SOURCE ||
    labels["org.opencontainers.image.revision"] !== arguments_.sourceSha ||
    labels["org.opencontainers.image.version"] !== arguments_.sourceSha ||
    labels["com.salamland.product-surface"] !== arguments_.surface
  ) {
    fail("RELEASE_IMAGE_LABELS");
  }
  const scanBudget = createSensitiveScanBudget();
  assertSensitiveContent(configBytes, arguments_.canary, "image-config", scanBudget);
  inspectLayers(
    layerDescriptors,
    entries,
    config,
    arguments_.canary,
    baseLayerCount,
    scanBudget,
  );

  return Object.freeze({
    manifestDigest: manifestDescriptor.digest,
    configDigest: configDescriptor.digest,
  });
}

function writeExclusive(path, source) {
  try {
    lstatSync(path);
    fail("RELEASE_IMAGE_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      fail("RELEASE_IMAGE_OUTPUT_PATH");
    }
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, source, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    if (error && typeof error === "object" && error.code === "EEXIST") {
      fail("RELEASE_IMAGE_OUTPUT_EXISTS");
    }
    fail("RELEASE_IMAGE_OUTPUT_PATH");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  activeCanary = arguments_.canary;
  const archive = readStableArchive(arguments_.archivePath);
  const artifactDigest = sha256Digest(archive);
  const image = inspectArchive(archive, arguments_);
  const metadata = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    sourceSha: arguments_.sourceSha,
    surface: arguments_.surface,
    appVersion: arguments_.sourceSha,
    baseImageDigest: RUNTIME_BASE_IMAGE.indexDigest,
    baseImagePlatformDigest: RUNTIME_BASE_IMAGE.platformDigest,
    platform: { ...RELEASE_PLATFORM },
    imageReference: `${arguments_.surface}-ci@${image.manifestDigest}`,
    imageManifestDigest: image.manifestDigest,
    imageConfigDigest: image.configDigest,
    imageArtifactSha256: artifactDigest,
  };
  writeExclusive(arguments_.outputPath, canonicalJson(metadata));
}

try {
  main();
} catch (error) {
  if (error instanceof InspectionError) {
    const safePath =
      error.safePath && activeCanary && error.safePath.includes(activeCanary)
        ? "[redacted-path]"
        : error.safePath;
    const suffix = safePath ? `:${safePath}` : "";
    process.stderr.write(`${error.code}${suffix}\n`);
  } else {
    process.stderr.write("RELEASE_IMAGE_INTERNAL\n");
  }
  process.exitCode = 1;
}
