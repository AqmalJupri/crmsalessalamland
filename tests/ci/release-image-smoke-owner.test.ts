import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerPath = `${repositoryRoot}scripts/ci/run-release-image-smoke.mjs`;
const ownerUrl = pathToFileURL(ownerPath).href;
const sourceSha = "1".repeat(40);
const imageManifestDigest = `sha256:${"2".repeat(64)}`;
const imageConfigDigest = `sha256:${"3".repeat(64)}`;
const imageManifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const baseDigest =
  "sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50";
const basePlatformDigest =
  "sha256:6eae66c49774276f50ae1818db25bb89735971a909fb833633dd1400dbc450a1";
const postgresImage =
  "postgres:16.14-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const probeImage =
  "node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const temporaryDirectories: string[] = [];

interface RunOptions {
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly stdin?: string | Buffer;
  readonly timeoutMs?: number;
}

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface RuntimeOwnerModule {
  createDockerCommandRunner(): {
    run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
  };
  runReleaseImageSmoke(input: Record<string, unknown>): Promise<void>;
  runReleaseImageSmokeCli(input: Record<string, unknown>): Promise<void>;
}

interface EvidenceFixture {
  readonly databaseDumpPath: string;
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

function sha256(source: string | Buffer): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path: string, value: unknown): string {
  const source = canonical(value);
  writeFileSync(path, source, { encoding: "utf8", flag: "wx" });
  return source;
}

function createEvidence(): EvidenceFixture {
  const directory = mkdtempSync(join(tmpdir(), "crm-release-image-smoke-"));
  temporaryDirectories.push(directory);

  const imageArchive = Buffer.from("synthetic exact OCI archive\n", "utf8");
  const imageArtifactSha256 = sha256(imageArchive);
  writeFileSync(join(directory, "image.oci.tar"), imageArchive, { flag: "wx" });

  const ledger = {
    schemaVersion: 1,
    entries: EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({ filename, checksum })),
  };
  const ledgerSource = writeJson(join(directory, "migration-ledger.json"), ledger);

  const cyclonedx = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { name: "crm", version: sourceSha } },
  };
  const cyclonedxSource = writeJson(join(directory, "sbom.cdx.json"), cyclonedx);
  const spdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "crm",
    documentNamespace: `https://sbom.salamland.test/crm/${sourceSha}`,
  };
  const spdxSource = writeJson(join(directory, "sbom.spdx.json"), spdx);
  const binding = {
    schemaVersion: 1,
    sourceSha,
    surface: "crm",
    syft: {
      version: "1.48.0",
      command: "scan",
      source: "oci-archive:image.oci.tar",
      platform: "linux/amd64",
      sourceName: "crm",
      sourceVersion: sourceSha,
    },
    image: {
      manifestDigest: imageManifestDigest,
      configDigest: imageConfigDigest,
      artifactSha256: imageArtifactSha256,
    },
    sboms: {
      cyclonedx: {
        filename: "sbom.cdx.json",
        format: "cyclonedx-json",
        specVersion: "1.6",
        sha256: sha256(cyclonedxSource),
      },
      spdx: {
        filename: "sbom.spdx.json",
        format: "spdx-json",
        specVersion: "2.3",
        sha256: sha256(spdxSource),
      },
    },
  };
  const bindingSource = writeJson(join(directory, "sbom-binding.json"), binding);
  const scan = {
    schemaVersion: 1,
    sourceSha,
    surface: "crm",
    result: "pass",
  };
  const scanSource = writeJson(join(directory, "scan-report.json"), scan);
  const trivyReportSource = writeJson(join(directory, "trivy-raw.json"), {
    SchemaVersion: 2,
    Results: [{ Target: "crm-ci", Vulnerabilities: [] }],
  });
  const trivySecretReportSource = writeJson(
    join(directory, "trivy-secret-raw.json"),
    { SchemaVersion: 2, Results: [{ Target: "crm-ci", Secrets: [] }] },
  );
  const trivyVersionSource = writeJson(join(directory, "trivy-version.json"), {
    Version: "0.72.0",
  });
  const policy = { schemaVersion: 1, version: "2026-07-19", exceptions: [] };
  const policySource = writeJson(join(directory, "policy.json"), policy);

  writeJson(join(directory, "image-metadata.json"), {
    schemaVersion: 1,
    sourceSha,
    surface: "crm",
    appVersion: sourceSha,
    baseImageDigest: baseDigest,
    baseImagePlatformDigest: basePlatformDigest,
    platform: { os: "linux", architecture: "amd64" },
    imageReference: `crm-ci@${imageManifestDigest}`,
    imageManifestDigest,
    imageConfigDigest,
    imageArtifactSha256,
  });

  const manifest = {
    schemaVersion: 1,
    sourceSha,
    surface: "crm",
    appVersion: sourceSha,
    baseImageDigest: baseDigest,
    baseImagePlatformDigest: basePlatformDigest,
    platform: { os: "linux", architecture: "amd64" },
    image: {
      reference: `crm-ci@${imageManifestDigest}`,
      manifestDigest: imageManifestDigest,
      configDigest: imageConfigDigest,
      artifactSha256: imageArtifactSha256,
    },
    migrationLedger: {
      entryCount: 7,
      sha256: sha256(ledgerSource),
      entries: ledger.entries,
    },
    sboms: {
      binding: { filename: "sbom-binding.json", sha256: sha256(bindingSource) },
      cyclonedx: { filename: "sbom.cdx.json", sha256: sha256(cyclonedxSource) },
      spdx: { filename: "sbom.spdx.json", sha256: sha256(spdxSource) },
    },
    scan: {
      result: "pass",
      evaluatedAt: "2026-07-19T00:02:00.000Z",
      reportSha256: sha256(scanSource),
      rawReportSha256: sha256(trivyReportSource),
      secretReportSha256: sha256(trivySecretReportSource),
      versionReportSha256: sha256(trivyVersionSource),
      scanner: { engine: "trivy", version: "0.69.3" },
      policy: { version: "2026-07-19", sha256: sha256(policySource) },
      vulnerabilityDatabase: {
        source: "ghcr.io/aquasecurity/trivy-db:2",
        version: "2026-07-19",
        updatedAt: "2026-07-19T00:00:00.000Z",
        nextUpdate: "2026-07-20T00:00:00.000Z",
        downloadedAt: "2026-07-19T00:01:00.000Z",
        sha256: `sha256:${"6".repeat(64)}`,
      },
    },
  };
  writeJson(join(directory, "release-manifest.json"), manifest);

  const databaseDumpPath = join(directory, "crm_salam_codex_migration_platform.dump");
  writeFileSync(databaseDumpPath, "synthetic pg custom dump\n", {
    encoding: "utf8",
    flag: "wx",
  });
  return { databaseDumpPath, directory, manifest };
}

function commandText(call: CommandCall): string {
  return [call.command, ...call.args].join(" ");
}

class FakeRunner {
  readonly calls: CommandCall[] = [];
  failPattern: RegExp | undefined;
  hangPattern: RegExp | undefined;
  imageDescriptorDigest = imageManifestDigest;
  imageDescriptorMediaType = imageManifestMediaType;
  imageId = imageManifestDigest;
  networkNames: { app?: string; database?: string } = {};
  ledger: Array<{ filename: string; checksum: string }> = EXPECTED_MIGRATIONS.map(
    ({ filename, checksum }) => ({ filename, checksum }),
  );

  async run(
    command: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    const source = commandText(call);

    if (this.hangPattern?.test(source)) {
      return new Promise((_, reject) => {
        const fail = () => reject(options.signal?.reason ?? new Error("aborted"));
        if (options.signal?.aborted) fail();
        else options.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (this.failPattern?.test(source)) {
      throw new Error("injected-secret-value-must-not-leak");
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return {
        stdout: canonical([{
          Id: this.imageId,
          Descriptor: {
            digest: this.imageDescriptorDigest,
            mediaType: this.imageDescriptorMediaType,
          },
          RepoDigests: [`crm-ci@${imageManifestDigest}`],
          Config: {
            User: "65532:65532",
            Labels: {
              "org.opencontainers.image.source":
                "https://github.com/AqmalJupri/crmsalessalamland",
              "org.opencontainers.image.revision": sourceSha,
              "org.opencontainers.image.version": sourceSha,
              "com.salamland.product-surface": "crm",
            },
          },
        }]),
        stderr: "",
      };
    }
    if (args[0] === "inspect" && args.includes("--format") && source.includes("crm-smoke-db-")) {
      return { stdout: "172.30.0.2\n", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("--format") && source.includes("crm-smoke-app-")) {
      return { stdout: "172.30.0.3\n", stderr: "" };
    }
    if (args[0] === "port") return { stdout: "127.0.0.1:55001\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") {
      return {
        stdout: canonical([{
          Internal: true,
          Containers: {
            a: { Name: this.networkNames.app },
            b: { Name: this.networkNames.database },
          },
        }]),
        stderr: "",
      };
    }
    if (
      (args[0] === "container" || args[0] === "network") &&
      args[1] === "ls"
    ) {
      return { stdout: `${"a".repeat(64)}\n`, stderr: "" };
    }
    if (args[0] === "run" && args.includes(postgresImage)) {
      this.networkNames.database = args[args.indexOf("--name") + 1]!;
    } else if (
      args[0] === "run" &&
      (args.includes(imageManifestDigest) || args.includes(imageConfigDigest))
    ) {
      this.networkNames.app = args[args.indexOf("--name") + 1]!;
    }
    if (args[0] === "exec" && source.includes("json_agg")) {
      return { stdout: `${JSON.stringify(this.ledger)}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

async function loadOwner(): Promise<RuntimeOwnerModule> {
  return import(/* @vite-ignore */ ownerUrl) as Promise<RuntimeOwnerModule>;
}

function healthyFetch() {
  return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
}

function options(
  fixture: EvidenceFixture,
  runner: FakeRunner,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    databaseDumpPath: fixture.databaseDumpPath,
    evidenceDirectory: fixture.directory,
    fetchImpl: healthyFetch,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    runner,
    smokeTimeoutMs: 100,
    sourceSha,
    surface: "crm",
    ...overrides,
  };
}

function expectCleanup(runner: FakeRunner): void {
  const calls = runner.calls.map(commandText);
  expect(calls.some((call) => /docker rm --force crm-smoke-probe-/.test(call))).toBe(true);
  expect(calls.some((call) => /docker rm --force crm-smoke-app-/.test(call))).toBe(true);
  expect(calls.some((call) => /docker rm --force crm-smoke-db-/.test(call))).toBe(true);
  expect(calls.some((call) => /docker network rm crm-smoke-net-/.test(call))).toBe(true);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("restricted exact release-image runtime owner", () => {
  it("provides the reviewed runtime owner", () => {
    expect(existsSync(ownerPath), "scripts/ci/run-release-image-smoke.mjs must exist").toBe(true);
  });

  it("does not return from an interrupted command until its owned child process exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-release-command-owner-"));
    temporaryDirectories.push(directory);
    const pidPath = join(directory, "pid");
    const childPath = join(directory, "child.mjs");
    writeFileSync(
      childPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 75));',
        "setInterval(() => undefined, 1_000);",
      ].join("\n"),
      "utf8",
    );
    const owner = await loadOwner();
    const controller = new AbortController();
    const running = owner.createDockerCommandRunner().run(
      process.execPath,
      [childPath],
      { signal: controller.signal },
    );
    const deadline = Date.now() + 1_000;
    while (!existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const pid = Number(readFileSync(pidPath, "utf8"));
    controller.abort(new Error("test interrupt"));
    await expect(running).rejects.toThrow(/test interrupt/);

    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("accepts Docker 29 containerd inspection identity as the manifest target digest", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.imageId = imageManifestDigest;
    const owner = await loadOwner();

    await owner.runReleaseImageSmoke(options(fixture, runner));

    const imageInspection = runner.calls.find(
      (call) => call.args[0] === "image" && call.args[1] === "inspect",
    );
    expect(imageInspection?.args).toEqual(["image", "inspect", imageManifestDigest]);
    expect(imageInspection?.args).not.toContain(imageConfigDigest);

    const appRun = runner.calls.find(
      (call) => call.args[0] === "run" && call.args.includes(imageManifestDigest),
    );
    expect(appRun).toBeDefined();
    expect(appRun?.args).not.toContain(imageConfigDigest);
  });

  it("rejects a loaded image that resolves to a different manifest target digest", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.imageId = `sha256:${"9".repeat(64)}`;
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /IMAGE_INSPECTION_MISMATCH/,
    );
    expect(runner.calls.some(
      (call) => call.args[0] === "network" && call.args[1] === "create",
    )).toBe(false);
  });

  it("rejects classic-store config-digest identity before networking", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.imageId = imageConfigDigest;
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /IMAGE_INSPECTION_MISMATCH/,
    );
    expect(runner.calls.some(
      (call) => call.args[0] === "network" && call.args[1] === "create",
    )).toBe(false);
  });

  it("rejects an inspected image with a different descriptor digest before networking", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.imageDescriptorDigest = `sha256:${"8".repeat(64)}`;
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /IMAGE_INSPECTION_MISMATCH/,
    );
    expect(runner.calls.some(
      (call) => call.args[0] === "network" && call.args[1] === "create",
    )).toBe(false);
  });

  it("rejects an inspected image with a non-OCI manifest descriptor before networking", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.imageDescriptorMediaType = "application/vnd.oci.image.index.v1+json";
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /IMAGE_INSPECTION_MISMATCH/,
    );
    expect(runner.calls.some(
      (call) => call.args[0] === "network" && call.args[1] === "create",
    )).toBe(false);
  });

  it("reruns the exact production smoke probe after restarting the app", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    const owner = await loadOwner();

    await owner.runReleaseImageSmoke(options(fixture, runner));

    const probeRuns = runner.calls.filter(
      (call) => call.args[0] === "run" && call.args.includes(probeImage),
    );
    expect(probeRuns).toHaveLength(2);
    expect(probeRuns[1]?.args).toEqual(probeRuns[0]?.args);
  });

  it("loads without rebuilding and runs the exact image and restored database on one restricted internal network", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    const owner = await loadOwner();

    await owner.runReleaseImageSmoke(options(fixture, runner));

    const calls = runner.calls.map(commandText);
    expect(calls.some((call) =>
      call.includes("docker load --input ") && call.endsWith("/image.oci.tar"),
    )).toBe(true);
    expect(calls.some((call) => /docker (?:build|buildx|pull)\b/.test(call))).toBe(false);
    expect(calls.some((call) =>
      /docker exec crm-smoke-app-.*\/nodejs\/bin\/node --input-type=module --eval/.test(call),
    )).toBe(true);
    expect(calls).toContainEqual(expect.stringMatching(
      /docker network create --driver bridge --internal .*crm-smoke-net-/,
    ));

    const databaseRun = runner.calls.find(
      (call) => call.args[0] === "run" && call.args.includes(postgresImage),
    );
    expect(databaseRun).toBeDefined();
    expect(databaseRun!.args).toEqual(expect.arrayContaining([
      "--detach",
      "--network",
      expect.stringMatching(/^crm-smoke-net-/),
      "--network-alias",
      "postgres",
      "--pull",
      "always",
      postgresImage,
    ]));
    expect(databaseRun!.args).not.toEqual(expect.arrayContaining(["--publish", "-p"]));
    expect(calls.some((call) => call.includes("docker cp") && call.includes(fixture.databaseDumpPath))).toBe(true);
    expect(calls.some((call) => call.includes("pg_restore") && call.includes("--no-owner") && call.includes("--no-privileges"))).toBe(true);
    expect(calls.some((call) => call.includes("json_agg") && call.includes("schema_migrations"))).toBe(true);

    const appRun = runner.calls.find(
      (call) => call.args[0] === "run" && call.args.includes(imageManifestDigest),
    );
    expect(appRun).toBeDefined();
    expect(appRun!.args).toEqual(expect.arrayContaining([
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--cpus",
      "1.0",
      "--user",
      "65532:65532",
      "--dns",
      "127.0.0.1",
      "--publish",
      "127.0.0.1::3000",
    ]));
    const tmpfsValues = appRun!.args.flatMap((value, index, values) =>
      value === "--tmpfs" ? [values[index + 1]!] : [],
    );
    expect(tmpfsValues).toEqual([
      "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
      "/app/.next/cache:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
    ]);
    expect(appRun!.args).not.toEqual(expect.arrayContaining([
      "--mount",
      "--volume",
      "-v",
      "--network=host",
      "--add-host",
      "host-gateway",
    ]));
    expect(calls.some((call) => /^node .*tests\/production\/runtime-smoke\.mjs/.test(call))).toBe(false);
    expect(calls.some((call) => call.includes("docker cp") && call.includes("runtime-smoke.mjs"))).toBe(false);
    const probeRuns = runner.calls.filter(
      (call) => call.args[0] === "run" && call.args.includes(probeImage),
    );
    expect(probeRuns).toHaveLength(2);
    expect(probeRuns[1]?.args).toEqual(probeRuns[0]?.args);
    const probeRun = probeRuns[0];
    expect(probeRun).toBeDefined();
    expect(probeRun!.args).toEqual(expect.arrayContaining([
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--network",
      expect.stringMatching(/^crm-smoke-net-/),
      "--dns",
      "127.0.0.1",
      "--user",
      "10001:10001",
      "--pull",
      "always",
      probeImage,
      "node",
      "/probe/tests/runtime-smoke.mjs",
    ]));
    const probeMounts = probeRun!.args.flatMap((value, index, values) =>
      value === "--mount" ? [values[index + 1]!] : [],
    );
    expect(probeMounts).toHaveLength(2);
    expect(probeMounts.every((mount) => mount.endsWith(",readonly"))).toBe(true);
    expect(probeMounts.some((mount) => mount.includes("dst=/probe/tests"))).toBe(true);
    expect(probeMounts.some((mount) => mount.includes("dst=/probe/node_modules"))).toBe(true);
    expect(calls.some((call) => call.includes("169.254.169.254") && call.includes("192.168.1.1") && call.includes("93.184.216.34"))).toBe(true);
    expect(calls.some((call) => /docker stop .*crm-smoke-app-/.test(call))).toBe(true);
    expect(calls.some((call) => /docker start crm-smoke-app-/.test(call))).toBe(true);
    expectCleanup(runner);
  });

  it.each([
    ["image start", /docker run .*sha256:2{64}/, /APP_START_FAILED/],
    ["readiness", undefined, /APP_READINESS_FAILED/],
    ["runtime smoke", /docker run .*runtime-smoke\.mjs/, /RUNTIME_SMOKE_FAILED/],
  ] as const)("cleans every owned Docker object after %s failure", async (_label, failPattern, code) => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    if (failPattern) runner.failPattern = failPattern;
    const owner = await loadOwner();
    const fetchImpl = failPattern
      ? healthyFetch
      : () => Promise.resolve(new Response("unavailable", { status: 503 }));

    await expect(owner.runReleaseImageSmoke(options(fixture, runner, {
      fetchImpl,
      readinessTimeoutMs: 10,
    }))).rejects.toThrow(code);
    expectCleanup(runner);
  });

  it("bounds a hanging runtime smoke and removes its container, database, and network", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.hangPattern = /docker run .*runtime-smoke\.mjs/;
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner, {
      smokeTimeoutMs: 10,
    }))).rejects.toThrow(/RUNTIME_SMOKE_TIMEOUT/);
    expectCleanup(runner);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("waits for cleanup before preserving %s exit semantics", async (signal, exitCode) => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.hangPattern = /docker run .*runtime-smoke\.mjs/;
    const processTarget = new EventEmitter() as EventEmitter & { exitCode?: number };
    const owner = await loadOwner();

    const running = owner.runReleaseImageSmokeCli(options(fixture, runner, {
      processTarget,
      smokeTimeoutMs: 10_000,
    }));
    const observed = running.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + 1_000;
    while (
      !runner.calls.some((call) => /docker run .*runtime-smoke\.mjs/.test(commandText(call))) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    processTarget.emit(signal);
    const outcome = await observed;
    if (outcome.error) throw outcome.error;

    expect(processTarget.exitCode).toBe(exitCode);
    expectCleanup(runner);
    expect(processTarget.listenerCount("SIGINT")).toBe(0);
    expect(processTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("fails closed on a stale restored ledger before starting the app", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.ledger[6] = { ...runner.ledger[6]!, checksum: "0".repeat(64) };
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /DATABASE_LEDGER_MISMATCH/,
    );
    expect(runner.calls.some((call) =>
      call.args[0] === "run" && call.args.includes(imageManifestDigest),
    )).toBe(false);
    expectCleanup(runner);
  });

  it("rejects changed bound evidence before loading or starting any image", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    writeFileSync(join(fixture.directory, "sbom.cdx.json"), "{}\n", "utf8");
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /EVIDENCE_DIGEST_MISMATCH/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("requires the bound SBOM sidecar before any Docker action", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    rmSync(join(fixture.directory, "sbom-binding.json"));
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /EVIDENCE_MISSING/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a digest-preserving SBOM binding identity tamper before Docker access", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    const bindingPath = join(fixture.directory, "sbom-binding.json");
    const manifestPath = join(fixture.directory, "release-manifest.json");
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    const image = binding.image as Record<string, unknown>;
    image.configDigest = `sha256:${"9".repeat(64)}`;
    const bindingSource = canonical(binding);
    writeFileSync(bindingPath, bindingSource, "utf8");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      sboms: { binding: { sha256: string } };
    };
    manifest.sboms.binding.sha256 = sha256(bindingSource);
    writeFileSync(manifestPath, canonical(manifest), "utf8");
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /EVIDENCE_CONTENT_INVALID/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("requires the manifest SBOM descriptors to have the exact binding schema", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    const manifestPath = join(fixture.directory, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      sboms: { binding: Record<string, unknown> };
    };
    manifest.sboms.binding.unreviewed = true;
    writeFileSync(manifestPath, canonical(manifest), "utf8");
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /MANIFEST_CONTRACT_INVALID/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects changed raw vulnerability or secret scanner evidence", async () => {
    for (const filename of ["trivy-raw.json", "trivy-secret-raw.json"]) {
      const fixture = createEvidence();
      writeFileSync(join(fixture.directory, filename), "{}\n", "utf8");
      const runner = new FakeRunner();
      const owner = await loadOwner();

      await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
        /EVIDENCE_DIGEST_MISMATCH/,
      );
      expect(runner.calls).toHaveLength(0);
    }
  });

  it("rejects duplicate keys in untrusted image metadata", async () => {
    const fixture = createEvidence();
    const path = join(fixture.directory, "image-metadata.json");
    const source = readFileSync(path, "utf8").replace(
      '  "surface": "crm",',
      '  "surface": "crm",\n  "surface": "crm",',
    );
    writeFileSync(path, source, "utf8");
    const runner = new FakeRunner();
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /EVIDENCE_CONTENT_INVALID/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects non-canonical or unknown manifest fields before Docker access", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    const manifest = JSON.parse(
      readFileSync(join(fixture.directory, "release-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.unreviewed = true;
    writeFileSync(join(fixture.directory, "release-manifest.json"), canonical(manifest), "utf8");
    const owner = await loadOwner();

    await expect(owner.runReleaseImageSmoke(options(fixture, runner))).rejects.toThrow(
      /MANIFEST_CONTRACT_INVALID/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("reports safe failure codes without exposing command errors or synthetic credentials", async () => {
    const fixture = createEvidence();
    const runner = new FakeRunner();
    runner.failPattern = /docker run .*sha256:2{64}/;
    const owner = await loadOwner();

    const failure = await owner.runReleaseImageSmoke(options(fixture, runner)).catch((error) => error);
    expect(String(failure)).toMatch(/APP_START_FAILED/);
    expect(String(failure)).not.toMatch(/injected-secret|crm_local_only|AUTH_HASH_KEY/i);
    expectCleanup(runner);
  });
});
