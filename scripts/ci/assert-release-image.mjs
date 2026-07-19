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

function assertSensitiveContent(bytes, canary, path) {
  if (bytes.includes(Buffer.from(canary, "utf8"))) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  }
  const source = bytes.toString("latin1");
  const patterns = [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY)\s*[:=]\s*["']?[A-Za-z0-9_./+:-]{8,}/i,
    /\bAPI_KEY\s*[:=]\s*["']?[A-Za-z0-9_./+:-]{8,}/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  ];
  if (patterns.some((pattern) => pattern.test(source))) {
    fail("RELEASE_IMAGE_SENSITIVE_CONTENT", path);
  }
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

function inspectLayers(layerDescriptors, blobEntries, config, canary, baseLayerCount) {
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
        assertSensitiveContent(entry.content, canary, entry.path);
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
  assertSensitiveContent(configBytes, arguments_.canary, "image-config");
  inspectLayers(
    layerDescriptors,
    entries,
    config,
    arguments_.canary,
    baseLayerCount,
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
