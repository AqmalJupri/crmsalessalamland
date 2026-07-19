import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const verifier = join(repositoryRoot, "scripts/ci/assert-release-tool.mjs");
const productionLockPath = join(
  repositoryRoot,
  "security/release-tool-lock.json",
);
const temporaryDirectories: string[] = [];
const unsafeLockCases: Array<
  readonly [string, string | undefined, Record<string, unknown>]
> = [
  ["duplicate JSON key", '{"schemaVersion":1,"schemaVersion":1}', {}],
  ["unknown root field", undefined, { environment: "production" }],
  ["non-HTTPS source", undefined, { sourceUrl: "http://example.test/tool" }],
  ["unsafe archive member", undefined, { format: "tar.gz", members: ["../tool"] }],
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureLock(
  artifact: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    platform: "linux-amd64",
    tools: {
      buildx: {
        version: "0.35.0",
        sourceUrl:
          "https://github.com/docker/buildx/releases/download/v0.35.0/buildx-v0.35.0.linux-amd64",
        sha256: sha256(artifact),
        size: artifact.length,
        format: "binary",
        members: [],
        ...overrides,
      },
    },
  };
}

function runVerifier(
  artifact: Buffer,
  lock: Record<string, unknown>,
  lockSource?: string,
) {
  const directory = mkdtempSync(join(tmpdir(), "crm-release-tool-lock-"));
  temporaryDirectories.push(directory);
  const artifactPath = join(directory, "artifact");
  const lockPath = join(directory, "lock.json");
  writeFileSync(artifactPath, artifact);
  writeFileSync(lockPath, lockSource ?? `${JSON.stringify(lock)}\n`);
  return spawnSync(
    process.execPath,
    [
      verifier,
      "--lock",
      lockPath,
      "--tool",
      "buildx",
      "--artifact",
      artifactPath,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("release tool integrity lock", () => {
  it("accepts only an artifact matching the exact byte length and SHA-256", () => {
    const artifact = Buffer.from("reviewed-buildx-binary");
    const result = runVerifier(artifact, fixtureLock(artifact));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RELEASE_TOOL_OK buildx\n");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["digest", { sha256: "0".repeat(64) }],
    ["size", { size: 1 }],
  ])("fails closed on a mismatched %s without printing artifact bytes", (_label, overrides) => {
    const artifact = Buffer.from("do-not-print-this-artifact");
    const result = runVerifier(artifact, fixtureLock(artifact, overrides));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RELEASE_TOOL_INTEGRITY");
    expect(result.stderr).not.toContain(artifact.toString("utf8"));
  });

  for (const [_label, rawSource, toolOverrides] of unsafeLockCases) {
    it(`rejects a ${_label} in the lock`, () => {
      const artifact = Buffer.from("reviewed-tool");
      const lock = fixtureLock(artifact, toolOverrides);
      const mutated =
        _label === "unknown root field"
          ? { ...lock, environment: "production" }
          : lock;
      const result = runVerifier(artifact, mutated, rawSource);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/RELEASE_TOOL_(?:LOCK|INTEGRITY)/);
    });
  }

  it("locks every hosted release tool to the reviewed Linux amd64 asset", () => {
    const lock = JSON.parse(readFileSync(productionLockPath, "utf8")) as {
      schemaVersion: number;
      platform: string;
      tools: Record<
        string,
        {
          version: string;
          sourceUrl: string;
          sha256: string;
          size: number;
          format: string;
          members: string[];
        }
      >;
    };

    expect(lock).toEqual({
      schemaVersion: 1,
      platform: "linux-amd64",
      tools: {
        buildx: {
          version: "0.35.0",
          sourceUrl:
            "https://github.com/docker/buildx/releases/download/v0.35.0/buildx-v0.35.0.linux-amd64",
          sha256: "d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda",
          size: 65_265_826,
          format: "binary",
          members: [],
        },
        docker: {
          version: "29.6.2",
          sourceUrl:
            "https://download.docker.com/linux/static/stable/x86_64/docker-29.6.2.tgz",
          sha256: "d6204aea92238e2453d5445c885b9d2e5eb8f82915568ec50edf9dbe12a3ac74",
          size: 87_312_398,
          format: "tar.gz",
          members: [
            "docker/containerd",
            "docker/containerd-shim-runc-v2",
            "docker/ctr",
            "docker/docker",
            "docker/docker-init",
            "docker/docker-proxy",
            "docker/dockerd",
            "docker/runc",
          ],
        },
        syft: {
          version: "1.48.0",
          sourceUrl:
            "https://github.com/anchore/syft/releases/download/v1.48.0/syft_1.48.0_linux_amd64.tar.gz",
          sha256: "6cef9a7f37220d9067eaf9cfaaa2fce986e9f320a8d42cbc36658c99af78ea04",
          size: 28_569_058,
          format: "tar.gz",
          members: ["syft"],
        },
        trivy: {
          version: "0.72.0",
          sourceUrl:
            "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_Linux-64bit.tar.gz",
          sha256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea",
          size: 50_352_156,
          format: "tar.gz",
          members: ["trivy"],
        },
      },
    });
  });
});
