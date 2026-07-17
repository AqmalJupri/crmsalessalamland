import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const snapshotsRoot = join(repositoryRoot, "tests/e2e/__snapshots__");
const provenancePath = join(snapshotsRoot, "provenance.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function filesRecursively(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(path) : [path];
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.platform !== "linux") {
  fail("Visual baseline provenance can only be produced by Linux.");
}
if (process.env.VISUAL_BASELINE_CAPTURE !== "reviewed-linux") {
  fail("VISUAL_BASELINE_CAPTURE must be exactly reviewed-linux.");
}
if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "")) {
  fail("GITHUB_SHA must be the exact captured commit.");
}

const packagePath = require.resolve("@playwright/test/package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
if (packageJson.version !== "1.61.1") {
  fail("The visual runtime must use Playwright 1.61.1.");
}

const pngPaths = filesRecursively(snapshotsRoot)
  .filter((path) => path.endsWith(".png"))
  .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
if (pngPaths.length !== 60) {
  fail(`Expected exactly 60 visual baselines, received ${pngPaths.length}.`);
}

const assets = Object.fromEntries(
  pngPaths.map((path) => [
    relative(snapshotsRoot, path).replaceAll("\\", "/"),
    sha256(readFileSync(path)),
  ]),
);
const referenceLock = sha256(
  readFileSync(join(repositoryRoot, "docs/design/reference/2026-07-16/sha256.txt")),
);

const browser = await chromium.launch({ headless: true });
let browserVersion;
try {
  browserVersion = browser.version();
} finally {
  await browser.close();
}

const provenance = {
  schemaVersion: 1,
  sourceCommit: process.env.GITHUB_SHA,
  syntheticOnly: true,
  dynamicData: "none-present",
  capturedAt: new Date().toISOString(),
  capture: {
    os: "Linux",
    runnerImage: process.env.ImageOS ?? "ubuntu-unknown",
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    playwrightVersion: packageJson.version,
    browserName: "chromium",
    browserVersion,
  },
  review: {
    status: "candidate",
    referenceLock,
    reviewer: "PENDING",
  },
  assets,
};

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
  encoding: "utf8",
  flag: "w",
  mode: 0o644,
});
