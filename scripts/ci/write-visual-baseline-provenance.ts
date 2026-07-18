import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  computeVisualComparisonBinding,
  computeVisualReferenceLock,
  computeVisualSourceBinding,
} from "./visual-baseline-binding";

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const snapshotsRoot = join(repositoryRoot, "tests/e2e/__snapshots__");
const provenancePath = join(snapshotsRoot, "provenance.json");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function filesRecursively(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(path) : [path];
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    fail("Visual baseline provenance can only be produced by Linux.");
  }
  if (process.env.VISUAL_BASELINE_CAPTURE !== "reviewed-linux") {
    fail("VISUAL_BASELINE_CAPTURE must be exactly reviewed-linux.");
  }
  if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "")) {
    fail("GITHUB_SHA must be the exact captured commit.");
  }
  if (!process.env.ImageOS) {
    fail("ImageOS must identify the exact Linux runner image.");
  }
  if (!process.env.RUNNER_ARCH) {
    fail("RUNNER_ARCH must identify the exact Linux runner architecture.");
  }

  const packagePath = require.resolve("@playwright/test/package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (packageJson.version !== "1.61.1") {
    fail("The visual runtime must use Playwright 1.61.1.");
  }

  const pngPaths = filesRecursively(snapshotsRoot)
    .filter((path) => path.endsWith(".png"))
    .sort((left, right) =>
      Buffer.from(relative(snapshotsRoot, left)).compare(
        Buffer.from(relative(snapshotsRoot, right)),
      ),
    );
  if (pngPaths.length !== 60) {
    fail(`Expected exactly 60 visual baselines, received ${pngPaths.length}.`);
  }

  const assets = Object.fromEntries(
    pngPaths.map((path) => [
      relative(snapshotsRoot, path).replaceAll("\\", "/"),
      sha256(readFileSync(path)),
    ]),
  );

  const browser = await chromium.launch({ headless: true });
  let browserVersion: string;
  try {
    browserVersion = browser.version();
  } finally {
    await browser.close();
  }

  const provenance = {
    schemaVersion: 3,
    sourceCommit: process.env.GITHUB_SHA,
    sourceBinding: computeVisualSourceBinding(repositoryRoot),
    comparisonBinding: computeVisualComparisonBinding(repositoryRoot),
    syntheticOnly: true,
    dynamicData: "none-present",
    capturedAt: new Date().toISOString(),
    capture: {
      os: "Linux",
      runnerImage: process.env.ImageOS,
      runnerArch: process.env.RUNNER_ARCH,
      playwrightVersion: packageJson.version,
      browserName: "chromium",
      browserVersion,
    },
    review: {
      status: "candidate",
      referenceLock: computeVisualReferenceLock(repositoryRoot),
      reviewer: "PENDING",
    },
    assets,
  };

  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o644,
  });
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_000)
      : "Unknown provenance writer failure.";
  process.stderr.write(`Visual baseline provenance generation failed: ${message}\n`);
  process.exitCode = 1;
});
