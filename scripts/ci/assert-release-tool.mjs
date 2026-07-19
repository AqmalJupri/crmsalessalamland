import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import {
  ReleaseContractError,
  assertExactKeys,
  assertPlainRecord,
  failReleaseContract,
  parseStrictJsonBytes,
} from "./release-image-contract.mjs";

const LOCK_LIMIT_BYTES = 64 * 1024;
const ARTIFACT_LIMIT_BYTES = 200 * 1024 * 1024;
const TOOL_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_MEMBER = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function parseArguments(argv) {
  const expected = new Set(["--lock", "--tool", "--artifact"]);
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!expected.has(key) || typeof value !== "string" || !value || parsed.has(key)) {
      failReleaseContract("RELEASE_TOOL_ARGUMENT");
    }
    parsed.set(key, value);
  }
  if (parsed.size !== expected.size || argv.length !== expected.size * 2) {
    failReleaseContract("RELEASE_TOOL_ARGUMENT");
  }
  return {
    lockPath: parsed.get("--lock"),
    tool: parsed.get("--tool"),
    artifactPath: parsed.get("--artifact"),
  };
}

function readLock(path) {
  let bytes;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > LOCK_LIMIT_BYTES) {
      failReleaseContract("RELEASE_TOOL_LOCK");
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    failReleaseContract("RELEASE_TOOL_LOCK");
  }
  return parseStrictJsonBytes(bytes, "RELEASE_TOOL_LOCK");
}

function validateLock(raw) {
  assertExactKeys(raw, ["schemaVersion", "platform", "tools"], "RELEASE_TOOL_LOCK");
  if (raw.schemaVersion !== 1 || raw.platform !== "linux-amd64") {
    failReleaseContract("RELEASE_TOOL_LOCK");
  }
  const tools = assertPlainRecord(raw.tools, "RELEASE_TOOL_LOCK");
  const names = Object.keys(tools);
  if (
    names.length < 1 ||
    names.length > 16 ||
    names.some((name) => !TOOL_NAME.test(name)) ||
    names.some((name, index) => index > 0 && names[index - 1].localeCompare(name, "en") >= 0)
  ) {
    failReleaseContract("RELEASE_TOOL_LOCK");
  }
  for (const name of names) {
    const entry = assertPlainRecord(tools[name], "RELEASE_TOOL_LOCK");
    assertExactKeys(
      entry,
      ["version", "sourceUrl", "sha256", "size", "format", "members"],
      "RELEASE_TOOL_LOCK",
    );
    if (typeof entry.version !== "string" || !VERSION.test(entry.version)) {
      failReleaseContract("RELEASE_TOOL_LOCK");
    }
    if (typeof entry.sourceUrl !== "string") failReleaseContract("RELEASE_TOOL_LOCK");
    let source;
    try {
      source = new URL(entry.sourceUrl);
    } catch {
      failReleaseContract("RELEASE_TOOL_LOCK");
    }
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      source.hash ||
      !source.hostname ||
      source.port
    ) {
      failReleaseContract("RELEASE_TOOL_LOCK");
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      failReleaseContract("RELEASE_TOOL_LOCK");
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > ARTIFACT_LIMIT_BYTES ||
      !["binary", "tar.gz"].includes(entry.format) ||
      !Array.isArray(entry.members) ||
      entry.members.some((member) => typeof member !== "string" || !SAFE_MEMBER.test(member)) ||
      new Set(entry.members).size !== entry.members.length ||
      (entry.format === "binary" && entry.members.length !== 0) ||
      (entry.format === "tar.gz" && entry.members.length === 0)
    ) {
      failReleaseContract("RELEASE_TOOL_LOCK");
    }
  }
  return tools;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    failReleaseContract("RELEASE_TOOL_INTEGRITY");
  }
}

async function main() {
  const { lockPath, tool, artifactPath } = parseArguments(process.argv.slice(2));
  if (!TOOL_NAME.test(tool)) failReleaseContract("RELEASE_TOOL_ARGUMENT");
  const tools = validateLock(readLock(lockPath));
  const expected = tools[tool];
  if (!expected) failReleaseContract("RELEASE_TOOL_LOCK");

  let stat;
  try {
    stat = lstatSync(artifactPath);
  } catch {
    failReleaseContract("RELEASE_TOOL_INTEGRITY");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== expected.size ||
    stat.size > ARTIFACT_LIMIT_BYTES
  ) {
    failReleaseContract("RELEASE_TOOL_INTEGRITY");
  }
  if ((await sha256File(artifactPath)) !== expected.sha256) {
    failReleaseContract("RELEASE_TOOL_INTEGRITY");
  }
  process.stdout.write(`RELEASE_TOOL_OK ${tool}\n`);
}

main().catch((error) => {
  const code = error instanceof ReleaseContractError ? error.code : "RELEASE_TOOL_INTERNAL";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
