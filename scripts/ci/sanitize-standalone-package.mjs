import {
  closeSync,
  constants as fileConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const MAX_PACKAGE_BYTES = 64 * 1024;
const EXPECTED_RUNTIME_PACKAGE = Object.freeze({
  name: "crm-salam-fortress",
  version: "0.1.0",
  private: true,
});
const ALLOWED_SOURCE_KEYS = new Set([
  "name",
  "version",
  "private",
  "packageManager",
  "engines",
  "scripts",
  "dependencies",
  "devDependencies",
]);

function fail() {
  throw new Error("RUNTIME_PACKAGE_SANITIZE_FAILED");
}

function assertUnlinkedAncestors(path) {
  let current = dirname(path);
  while (true) {
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      fail();
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function openStablePackage(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail();
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 2 ||
    metadata.size > MAX_PACKAGE_BYTES
  ) {
    fail();
  }

  let descriptor;
  try {
    descriptor = openSync(path, fileConstants.O_RDWR | fileConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size !== metadata.size ||
      before.dev !== metadata.dev ||
      before.ino !== metadata.ino ||
      before.nlink !== 1
    ) {
      fail();
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.nlink !== 1
    ) {
      fail();
    }
    return { descriptor, bytes, metadata: before };
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    fail();
  }
}

function assertExpectedPackage(bytes) {
  let source;
  let parsed;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch {
    fail();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => !ALLOWED_SOURCE_KEYS.has(key)) ||
    parsed.name !== EXPECTED_RUNTIME_PACKAGE.name ||
    parsed.version !== EXPECTED_RUNTIME_PACKAGE.version ||
    parsed.private !== EXPECTED_RUNTIME_PACKAGE.private
  ) {
    fail();
  }
}

function replaceWithRuntimeManifest(packageFile) {
  const content = Buffer.from(`${JSON.stringify(EXPECTED_RUNTIME_PACKAGE, null, 2)}\n`, "utf8");
  try {
    const before = fstatSync(packageFile.descriptor);
    if (
      !before.isFile() ||
      before.dev !== packageFile.metadata.dev ||
      before.ino !== packageFile.metadata.ino ||
      before.size !== packageFile.metadata.size ||
      before.mtimeMs !== packageFile.metadata.mtimeMs ||
      before.nlink !== 1
    ) {
      fail();
    }
    if (writeSync(packageFile.descriptor, content, 0, content.byteLength, 0) !== content.byteLength) {
      fail();
    }
    ftruncateSync(packageFile.descriptor, content.byteLength);
    fchmodSync(packageFile.descriptor, 0o644);
    fsyncSync(packageFile.descriptor);
    const after = fstatSync(packageFile.descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.size !== content.byteLength ||
      (after.mode & 0o777) !== 0o644
    ) {
      fail();
    }
  } catch {
    fail();
  }
}

let packageFile;
try {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1) fail();
  const path = resolve(arguments_[0]);
  if (basename(path) !== "package.json") fail();
  assertUnlinkedAncestors(path);
  packageFile = openStablePackage(path);
  assertExpectedPackage(packageFile.bytes);
  replaceWithRuntimeManifest(packageFile);
} catch {
  process.stderr.write("RUNTIME_PACKAGE_SANITIZE_FAILED\n");
  process.exitCode = 1;
} finally {
  if (packageFile !== undefined) closeSync(packageFile.descriptor);
}
