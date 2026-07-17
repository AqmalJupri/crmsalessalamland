import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerModuleUrl = pathToFileURL(
  join(repositoryRoot, "scripts/ci/run-next-runtime-smoke.mjs"),
).href;
const trackedPidFiles = new Set<string>();
const trackedDirectories = new Set<string>();

interface ProcessCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface RuntimeOwnerOptions {
  baseUrl: string;
  forceKillTimeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  smokeCommand: ProcessCommand;
  smokeTimeoutMs: number;
  startCommand: ProcessCommand;
  startupTimeoutMs: number;
  terminationGraceMs: number;
}

interface RuntimeOwnerModule {
  runNextRuntimeSmoke(options: RuntimeOwnerOptions): Promise<void>;
  runNextRuntimeSmokeCli(options: RuntimeOwnerOptions): Promise<void>;
}

interface TreeFixture {
  directory: string;
  options: RuntimeOwnerOptions;
  pidFile: string;
  signalFile: string;
}

const treeFixtureSource = String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const mode = process.env.TREE_MODE;
const pidFile = process.env.TREE_PID_FILE;
const signalFile = process.env.TREE_SIGNAL_FILE;
const port = Number(process.env.TREE_PORT);
if (!mode || !pidFile || !signalFile || !Number.isInteger(port)) process.exit(91);

const grandchildSource = [
  'const { appendFileSync } = require("node:fs");',
  'const signalFile = process.env.TREE_SIGNAL_FILE;',
  'process.on("SIGTERM", () => appendFileSync(signalFile, "SIGTERM:" + process.pid + "\\n"));',
  'if (process.send) process.send("ready");',
  'setInterval(() => undefined, 1000);',
].join("\n");
const grandchild = spawn(process.execPath, ["-e", grandchildSource], {
  env: { ...process.env, TREE_SIGNAL_FILE: signalFile },
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
if (!grandchild.pid) process.exit(92);

process.on("SIGTERM", () => {
  appendFileSync(signalFile, "SIGTERM:" + process.pid + "\n");
});
grandchild.once("message", (message) => {
  if (message !== "ready") process.exit(93);
  writeFileSync(pidFile, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));

  if (mode === "hang") {
    setInterval(() => undefined, 1000);
  } else if (mode === "startup-fail") {
    setTimeout(() => process.exit(17), 40);
  } else {
    createServer((request, response) => {
      if (request.url === "/api/health/live") {
        response.writeHead(mode === "no-live" ? 503 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: mode === "no-live" ? "starting" : "ok" }));
        return;
      }
      if (request.url === "/api/health/ready") {
        response.writeHead(mode === "ready-fail" ? 503 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: mode === "ready-fail" ? "unavailable" : "ok" }));
        return;
      }
      response.writeHead(404);
      response.end();
    }).listen(port, "127.0.0.1");
  }
});
`;

async function loadOwner(): Promise<RuntimeOwnerModule> {
  return import(/* @vite-ignore */ ownerModuleUrl) as Promise<RuntimeOwnerModule>;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port was allocated.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function fixture(mode: "hang" | "healthy" | "no-live" | "ready-fail" | "startup-fail", smokeExitCode = 0): Promise<TreeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "crm-runtime-owner-"));
  const fixturePath = join(directory, "process-tree.mjs");
  const pidFile = join(directory, "pids.json");
  const signalFile = join(directory, "signals.log");
  const port = await unusedPort();
  await writeFile(fixturePath, treeFixtureSource, "utf8");
  trackedPidFiles.add(pidFile);
  trackedDirectories.add(directory);

  return {
    directory,
    pidFile,
    signalFile,
    options: {
      baseUrl: `http://127.0.0.1:${port}`,
      forceKillTimeoutMs: 1_000,
      pollIntervalMs: 20,
      requestTimeoutMs: 100,
      smokeCommand: {
        command: process.execPath,
        args: ["-e", `process.exit(${smokeExitCode})`],
        cwd: directory,
      },
      smokeTimeoutMs: 1_000,
      startCommand: {
        command: process.execPath,
        args: [fixturePath],
        cwd: directory,
        env: {
          TREE_MODE: mode,
          TREE_PID_FILE: pidFile,
          TREE_PORT: String(port),
          TREE_SIGNAL_FILE: signalFile,
        },
      },
      startupTimeoutMs: mode === "no-live" ? 180 : 1_000,
      terminationGraceMs: 100,
    },
  };
}

async function readPids(pidFile: string): Promise<{ parent: number; grandchild: number }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(pidFile, "utf8")) as {
        parent: number;
        grandchild: number;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${pidFile}.`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(processExists(pid), `PID ${pid} must be gone`).toBe(false);
}

async function expectTreeCleaned(tree: TreeFixture): Promise<void> {
  const pids = await readPids(tree.pidFile);
  await expectGone(pids.parent);
  await expectGone(pids.grandchild);
  const signals = await readFile(tree.signalFile, "utf8");
  expect(signals).toContain(`SIGTERM:${pids.grandchild}`);
}

async function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

async function waitForText(path: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(path, "utf8");
      if (pattern.test(value)) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}.`);
}

async function runSignalPath(tree: TreeFixture, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const harnessPath = join(tree.directory, "owner-harness.mjs");
  await writeFile(
    harnessPath,
    `import { runNextRuntimeSmokeCli } from ${JSON.stringify(ownerModuleUrl)};\nawait runNextRuntimeSmokeCli(JSON.parse(process.env.RUNTIME_OWNER_OPTIONS));\n`,
    "utf8",
  );
  const child = spawn(process.execPath, [harnessPath], {
    cwd: tree.directory,
    env: {
      ...process.env,
      RUNTIME_OWNER_OPTIONS: JSON.stringify({
        ...tree.options,
        startupTimeoutMs: 10_000,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = childExit(child);
  await readPids(tree.pidFile);
  child.kill(signal);
  const result = await exit;

  expect(result.signal, result.output).toBeNull();
  expect(result.code, result.output).toBe(signal === "SIGINT" ? 130 : 143);
  await expectTreeCleaned(tree);
}

async function runLateCleanupSignalPath(
  tree: TreeFixture,
  signal: "SIGINT" | "SIGTERM",
): Promise<void> {
  const harnessPath = join(tree.directory, "owner-late-signal-harness.mjs");
  await writeFile(
    harnessPath,
    `import { runNextRuntimeSmokeCli } from ${JSON.stringify(ownerModuleUrl)};\nawait runNextRuntimeSmokeCli(JSON.parse(process.env.RUNTIME_OWNER_OPTIONS));\n`,
    "utf8",
  );
  const child = spawn(process.execPath, [harnessPath], {
    cwd: tree.directory,
    env: {
      ...process.env,
      RUNTIME_OWNER_OPTIONS: JSON.stringify({
        ...tree.options,
        forceKillTimeoutMs: 1_000,
        terminationGraceMs: 1_000,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = childExit(child);
  await readPids(tree.pidFile);
  await waitForText(tree.signalFile, /SIGTERM:/);
  child.kill(signal);
  const result = await exit;

  expect(result.signal, result.output).toBeNull();
  expect(result.code, result.output).toBe(signal === "SIGINT" ? 130 : 143);
  await expectTreeCleaned(tree);
}

afterEach(async () => {
  for (const pidFile of trackedPidFiles) {
    try {
      const pids = await readPids(pidFile);
      for (const pid of [pids.parent, pids.grandchild]) {
        if (!processExists(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    } catch (error) {
      if (!String(error).includes("Timed out waiting")) throw error;
    }
  }
  trackedPidFiles.clear();
  await Promise.all(
    [...trackedDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  trackedDirectories.clear();
});

describe.sequential("portable production runtime process owner", () => {
  it("rejects a compatible server that already owns the configured port", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crm-runtime-owner-decoy-"));
    trackedDirectories.add(directory);
    const port = await unusedPort();
    const decoy = createServer((request, response) => {
      if (request.url === "/api/health/live" || request.url === "/api/health/ready") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      decoy.once("error", reject);
      decoy.listen(port, "127.0.0.1", resolve);
    });
    const owner = await loadOwner();

    try {
      await expect(owner.runNextRuntimeSmoke({
        baseUrl: `http://127.0.0.1:${port}`,
        forceKillTimeoutMs: 1_000,
        pollIntervalMs: 20,
        requestTimeoutMs: 100,
        smokeCommand: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: directory,
        },
        smokeTimeoutMs: 1_000,
        startCommand: {
          command: process.execPath,
          args: ["-e", "setInterval(() => undefined, 1000)"],
          cwd: directory,
        },
        startupTimeoutMs: 1_000,
        terminationGraceMs: 100,
      })).rejects.toThrow(/already|occupied|port/i);

      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        decoy.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 10_000);

  it("cleans the detached parent and grandchild after a successful smoke", async () => {
    const tree = await fixture("healthy");
    const owner = await loadOwner();

    await owner.runNextRuntimeSmoke(tree.options);

    await expectTreeCleaned(tree);
  }, 10_000);

  it("cleans a surviving grandchild when startup exits early", async () => {
    const tree = await fixture("startup-fail");
    const owner = await loadOwner();

    await expect(owner.runNextRuntimeSmoke(tree.options)).rejects.toThrow(/startup|17/i);

    await expectTreeCleaned(tree);
  }, 10_000);

  it("cleans the complete tree when the runtime smoke command fails", async () => {
    const tree = await fixture("healthy", 23);
    const owner = await loadOwner();

    await expect(owner.runNextRuntimeSmoke(tree.options)).rejects.toThrow(/smoke|23/i);

    await expectTreeCleaned(tree);
  }, 10_000);

  it("fails closed and cleans the tree when readiness is unavailable", async () => {
    const tree = await fixture("ready-fail");
    const owner = await loadOwner();

    await expect(owner.runNextRuntimeSmoke(tree.options)).rejects.toThrow(/ready|503/i);

    await expectTreeCleaned(tree);
  }, 10_000);

  it("bounds live-probe startup timeout and cleans the complete tree", async () => {
    const tree = await fixture("no-live");
    const owner = await loadOwner();

    await expect(owner.runNextRuntimeSmoke(tree.options)).rejects.toThrow(/live|timeout/i);

    await expectTreeCleaned(tree);
  }, 10_000);

  it("bounds a hanging smoke command and cleans both detached trees", async () => {
    const server = await fixture("healthy");
    const smoke = await fixture("hang");
    const owner = await loadOwner();

    await expect(owner.runNextRuntimeSmoke({
      ...server.options,
      smokeCommand: smoke.options.startCommand,
      smokeTimeoutMs: 180,
    })).rejects.toThrow(/smoke|timeout/i);

    await expectTreeCleaned(smoke);
    await expectTreeCleaned(server);
  }, 10_000);

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cleans both PIDs before exiting for %s",
    async (signal) => {
      const tree = await fixture("no-live");
      await runSignalPath(tree, signal);
    },
    10_000,
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "preserves %s exit semantics when it arrives during cleanup",
    async (signal) => {
      const tree = await fixture("healthy");
      await runLateCleanupSignalPath(tree, signal);
    },
    10_000,
  );
});
