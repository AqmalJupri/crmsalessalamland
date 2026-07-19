import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sanitizerPath = `${repositoryRoot}scripts/ci/sanitize-standalone-package.mjs`;
const dockerfileSource = readFileSync(`${repositoryRoot}Dockerfile`, "utf8");
const temporaryDirectories: string[] = [];
const expectedRuntimeManifest = {
  name: "crm-salam-fortress",
  version: "0.1.0",
  private: true,
};
const testEnvironment = {
  NODE_ENV: process.env.NODE_ENV ?? "test",
  PATH: process.env.PATH,
};

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "crm-standalone-package-"));
  temporaryDirectories.push(directory);
  return realpathSync(directory);
}

function runSanitizer(path: string) {
  return spawnSync(process.execPath, [sanitizerPath, path], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 5_000,
    env: testEnvironment,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("standalone runtime package sanitizer", () => {
  it("is wired into both image build stages before permission normalization", () => {
    expect(existsSync(sanitizerPath), "runtime package sanitizer must exist").toBe(true);
    const command =
      "node scripts/ci/sanitize-standalone-package.mjs /app/.next/standalone/package.json";

    for (const surface of ["crm", "tasha"] as const) {
      const start = dockerfileSource.indexOf(`FROM dependencies AS build-${surface}`);
      const end = dockerfileSource.indexOf("\nFROM ", start + 1);
      const stage = dockerfileSource.slice(start, end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(stage.split(command)).toHaveLength(2);
      expect(stage.indexOf(command)).toBeGreaterThan(stage.indexOf("RUN pnpm build"));
      expect(stage.indexOf(command)).toBeLessThan(stage.indexOf("RUN find "));
    }
  });

  it("replaces development metadata with one canonical runtime-only manifest", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "package.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...expectedRuntimeManifest,
        packageManager: "pnpm@11.9.0",
        scripts: {
          e2e: "DATABASE_URL=postgresql://crm:local-password@127.0.0.1/crm AUTH_HASH_KEY=synthetic-hash-key playwright test",
        },
        dependencies: { next: "16.2.10" },
        devDependencies: { vitest: "4.1.10" },
      }),
    );

    const result = runSanitizer(path);
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify(expectedRuntimeManifest, null, 2)}\n`,
    );
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
  });

  it("fails closed for malformed, unexpected, symlinked, or extra arguments", () => {
    for (const manifest of [
      "not-json",
      "[]",
      JSON.stringify({ ...expectedRuntimeManifest, name: "unexpected" }),
      JSON.stringify({ ...expectedRuntimeManifest, version: "1.0.0" }),
      JSON.stringify({ ...expectedRuntimeManifest, private: false }),
      JSON.stringify({ ...expectedRuntimeManifest, type: "module" }),
      JSON.stringify({ ...expectedRuntimeManifest, imports: { "#runtime": "./runtime.js" } }),
      JSON.stringify({ ...expectedRuntimeManifest, exports: "./server.js" }),
      JSON.stringify({ ...expectedRuntimeManifest, main: "./server.js" }),
      JSON.stringify({ ...expectedRuntimeManifest, bin: "./server.js" }),
      JSON.stringify({ ...expectedRuntimeManifest, workspaces: ["packages/*"] }),
      JSON.stringify({ ...expectedRuntimeManifest, unexpectedMetadata: true }),
    ]) {
      const directory = temporaryDirectory();
      const path = join(directory, "package.json");
      writeFileSync(path, manifest);
      const result = runSanitizer(path);
      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("RUNTIME_PACKAGE_SANITIZE_FAILED\n");
      expect(result.stderr).not.toContain(manifest);
    }

    const directory = temporaryDirectory();
    const target = join(directory, "target.json");
    const link = join(directory, "package.json");
    writeFileSync(target, JSON.stringify(expectedRuntimeManifest));
    symlinkSync(target, link);
    const symlinkResult = runSanitizer(link);
    expect(symlinkResult.status).not.toBe(0);
    expect(symlinkResult.stderr).toBe("RUNTIME_PACKAGE_SANITIZE_FAILED\n");

    const extraArgumentResult = spawnSync(process.execPath, [sanitizerPath, target, "extra"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: testEnvironment,
    });
    expect(extraArgumentResult.status).not.toBe(0);
    expect(extraArgumentResult.stderr).toBe("RUNTIME_PACKAGE_SANITIZE_FAILED\n");
  });

  it("rejects symlinked ancestor directories and multiply linked package files", () => {
    const directory = temporaryDirectory();
    const realStandalone = join(directory, "real-standalone");
    const linkedStandalone = join(directory, "standalone");
    mkdirSync(realStandalone);
    const target = join(realStandalone, "package.json");
    const original = JSON.stringify(expectedRuntimeManifest);
    writeFileSync(target, original);
    symlinkSync(realStandalone, linkedStandalone, "dir");

    const ancestorResult = runSanitizer(join(linkedStandalone, "package.json"));
    expect(ancestorResult.status).not.toBe(0);
    expect(ancestorResult.stderr).toBe("RUNTIME_PACKAGE_SANITIZE_FAILED\n");
    expect(readFileSync(target, "utf8")).toBe(original);

    const hardlinkDirectory = temporaryDirectory();
    const source = join(hardlinkDirectory, "source.json");
    const packagePath = join(hardlinkDirectory, "package.json");
    writeFileSync(source, original);
    linkSync(source, packagePath);
    const hardlinkResult = runSanitizer(packagePath);
    expect(hardlinkResult.status).not.toBe(0);
    expect(hardlinkResult.stderr).toBe("RUNTIME_PACKAGE_SANITIZE_FAILED\n");
    expect(readFileSync(source, "utf8")).toBe(original);
    expect(readFileSync(packagePath, "utf8")).toBe(original);
  });
});
