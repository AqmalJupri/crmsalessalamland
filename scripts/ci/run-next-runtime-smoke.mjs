import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SMOKE_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATION_GRACE_MS = 3_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3_000;
const RUNTIME_SMOKE_INSTANCE_HEADER = "x-runtime-smoke-instance";

export class RuntimeInterruptedError extends Error {
  constructor(signal) {
    super(`Production runtime smoke interrupted by ${signal}.`);
    this.name = "RuntimeInterruptedError";
    this.signal = signal;
  }
}

function positiveInteger(value, fallback, label) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return candidate;
}

function configuredBaseUrl(explicit) {
  if (explicit !== undefined) return explicit;
  const rawPort = process.env.PORT;
  if (!rawPort || !/^\d+$/.test(rawPort)) {
    throw new Error("PORT must be an explicit decimal port for the runtime owner.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("PORT must be between 1024 and 65535.");
  }
  return `http://127.0.0.1:${port}`;
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("Runtime smoke baseUrl must be an HTTP 127.0.0.1 origin.");
  }
  return parsed.origin;
}

function normalizeCommand(value, fallback, label) {
  const command = value ?? fallback;
  if (
    !command ||
    typeof command.command !== "string" ||
    command.command.length === 0 ||
    !Array.isArray(command.args) ||
    command.args.some((argument) => typeof argument !== "string") ||
    typeof command.cwd !== "string" ||
    command.cwd.length === 0
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return {
    command: command.command,
    args: [...command.args],
    cwd: command.cwd,
    env: { ...(command.env ?? {}) },
  };
}

function normalizeOptions(input = {}) {
  if (process.platform === "win32") {
    throw new Error("The detached runtime process-group owner requires macOS or Linux.");
  }
  const baseUrl = normalizeBaseUrl(configuredBaseUrl(input.baseUrl));
  return {
    baseUrl,
    fetchImpl: input.fetchImpl ?? fetch,
    forceKillTimeoutMs: positiveInteger(
      input.forceKillTimeoutMs,
      DEFAULT_FORCE_KILL_TIMEOUT_MS,
      "forceKillTimeoutMs",
    ),
    pollIntervalMs: positiveInteger(
      input.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    ),
    requestTimeoutMs: positiveInteger(
      input.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    ),
    signal: input.signal,
    smokeCommand: normalizeCommand(
      input.smokeCommand,
      { command: "pnpm", args: ["test:runtime"], cwd: repositoryRoot },
      "smokeCommand",
    ),
    smokeTimeoutMs: positiveInteger(
      input.smokeTimeoutMs,
      DEFAULT_SMOKE_TIMEOUT_MS,
      "smokeTimeoutMs",
    ),
    startCommand: normalizeCommand(
      input.startCommand,
      { command: "pnpm", args: ["start"], cwd: process.cwd() },
      "startCommand",
    ),
    startupTimeoutMs: positiveInteger(
      input.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    ),
    terminationGraceMs: positiveInteger(
      input.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      "terminationGraceMs",
    ),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Production runtime smoke aborted.");
}

function assertPortAvailable(baseUrl, timeoutMs, signal) {
  throwIfAborted(signal);
  const parsed = new URL(baseUrl);
  const port = Number(parsed.port || "80");

  return new Promise((resolveAvailable, rejectAvailable) => {
    let settled = false;
    const socket = connect({ host: parsed.hostname, port });
    const timeout = setTimeout(() => {
      finish(() => rejectAvailable(
        new Error(`Runtime smoke could not prove port ${port} is available.`),
      ));
    }, timeoutMs);
    const onAbort = () => {
      finish(() => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          rejectAvailable(error);
        }
      });
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      finish(() => rejectAvailable(
        new Error(`Runtime smoke port ${port} is already occupied.`),
      ));
    });
    socket.once("error", (error) => {
      finish(() => {
        if (error?.code === "ECONNREFUSED") {
          resolveAvailable();
          return;
        }
        rejectAvailable(new Error(
          `Runtime smoke could not verify port ${port}: ${error?.message ?? "unknown socket error"}.`,
        ));
      });
    });
  });
}

function observeCommand(command, extraEnvironment = {}) {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    detached: true,
    env: {
      ...process.env,
      ...command.env,
      ...extraEnvironment,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });

  const state = {
    child,
    exitResult: null,
    pid: child.pid,
    exitPromise: undefined,
  };
  state.exitPromise = new Promise((resolveExit) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      state.exitResult = result;
      resolveExit(result);
    };
    child.once("error", (error) => settle({ kind: "error", error }));
    child.once("exit", (code, signal) => settle({ kind: "exit", code, signal }));
  });
  return state;
}

function exitDescription(result) {
  if (!result) return "without an exit result";
  if (result.kind === "error") return `with spawn error ${result.error.message}`;
  if (result.code !== null) return `with exit code ${result.code}`;
  return `from signal ${result.signal ?? "unknown"}`;
}

function delay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        rejectDelay(error);
      }
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function healthStatus(
  fetchImpl,
  url,
  timeoutMs,
  signal,
  expectedInstanceId,
) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (
      response.headers.get(RUNTIME_SMOKE_INSTANCE_HEADER) !== expectedInstanceId
    ) {
      throw new Error("Runtime health instance identity does not match the spawned process.");
    }
    return response.status;
  } catch (error) {
    throwIfAborted(signal);
    if (controller.signal.aborted) return null;
    if (error instanceof TypeError) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function waitForLive(server, options) {
  const deadline = Date.now() + options.startupTimeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    assertOwnedProcessGroup(server, "Production runtime startup");
    lastStatus = await healthStatus(
      options.fetchImpl,
      `${options.baseUrl}/api/health/live`,
      options.requestTimeoutMs,
      options.signal,
      options.instanceId,
    );
    assertOwnedProcessGroup(server, "Production runtime startup");
    if (lastStatus === 200) return;
    await delay(
      Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())),
      options.signal,
    );
  }
  throw new Error(
    `Production runtime live health timeout${lastStatus === null ? "" : ` (last status ${lastStatus})`}.`,
  );
}

function waitForCommand(state, timeoutMs, signal, label) {
  throwIfAborted(signal);
  return new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() => rejectExit(new Error(`${label} timeout.`)));
    }, timeoutMs);
    const onAbort = () => {
      finish(() => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          rejectExit(error);
        }
      });
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    state.exitPromise.then((result) => {
      finish(() => {
        if (result.kind === "error") {
          rejectExit(new Error(`${label} failed to spawn: ${result.error.message}.`));
        } else if (result.code !== 0) {
          rejectExit(
            new Error(`${label} failed ${exitDescription(result)}.`),
          );
        } else {
          resolveExit();
        }
      });
    });
  });
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function assertOwnedProcessGroup(state, label) {
  const result = state?.exitResult;
  if (
    result?.kind === "error" ||
    (result?.kind === "exit" && result.code !== 0)
  ) {
    throw new Error(`${label} exited ${exitDescription(result)}.`);
  }
  if (
    !Number.isSafeInteger(state?.pid) ||
    state.pid <= 0 ||
    !processGroupExists(state.pid)
  ) {
    throw new Error(`${label} process group is not running.`);
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return !processGroupExists(pid);
}

export async function terminateProcessGroup(state, options) {
  if (!Number.isSafeInteger(state?.pid) || state.pid <= 0) return;
  signalProcessGroup(state.pid, "SIGTERM");
  if (await waitForGroupExit(state.pid, options.terminationGraceMs)) return;

  signalProcessGroup(state.pid, "SIGKILL");
  if (!(await waitForGroupExit(state.pid, options.forceKillTimeoutMs))) {
    throw new Error(`Process group ${state.pid} survived SIGKILL.`);
  }
}

async function cleanupStates(states, options, primaryError) {
  const cleanupErrors = [];
  for (const state of states) {
    if (!state) continue;
    try {
      await terminateProcessGroup(state, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      primaryError instanceof Error
        ? primaryError.message
        : "Runtime smoke and process cleanup failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Runtime process cleanup failed.");
  }
}

export async function runNextRuntimeSmoke(input = {}) {
  const options = { ...normalizeOptions(input), instanceId: randomUUID() };
  let server = null;
  let smoke = null;
  let primaryError = null;
  try {
    throwIfAborted(options.signal);
    await assertPortAvailable(
      options.baseUrl,
      options.requestTimeoutMs,
      options.signal,
    );
    throwIfAborted(options.signal);
    server = observeCommand(options.startCommand, {
      RUNTIME_SMOKE_INSTANCE_ID: options.instanceId,
    });
    if (!Number.isSafeInteger(server.pid) || server.pid <= 0) {
      const result = await server.exitPromise;
      throw new Error(`Production runtime startup failed ${exitDescription(result)}.`);
    }
    await waitForLive(server, options);
    assertOwnedProcessGroup(server, "Production runtime");

    smoke = observeCommand(options.smokeCommand, {
      PRODUCTION_SMOKE_URL: options.baseUrl,
    });
    await waitForCommand(
      smoke,
      options.smokeTimeoutMs,
      options.signal,
      "Production runtime smoke",
    );
    assertOwnedProcessGroup(server, "Production runtime");

    const readyStatus = await healthStatus(
      options.fetchImpl,
      `${options.baseUrl}/api/health/ready`,
      options.requestTimeoutMs,
      options.signal,
      options.instanceId,
    );
    assertOwnedProcessGroup(server, "Production runtime");
    if (readyStatus !== 200) {
      throw new Error(
        `Production runtime ready health failed${readyStatus === null ? "" : ` with status ${readyStatus}`}.`,
      );
    }
  } catch (error) {
    primaryError = error;
  }

  await cleanupStates([smoke, server], options, primaryError);
}

export async function runNextRuntimeSmokeCli(input = {}) {
  const controller = new AbortController();
  const combinedSignal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let receivedSignal = null;
  const handlers = Object.fromEntries(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => {
        if (receivedSignal) return;
        receivedSignal = signal;
        controller.abort(new RuntimeInterruptedError(signal));
      },
    ]),
  );
  for (const [signal, handler] of Object.entries(handlers)) {
    process.on(signal, handler);
  }
  try {
    await runNextRuntimeSmoke({ ...input, signal: combinedSignal });
  } catch (error) {
    if (isMatchingRuntimeInterrupt(error, receivedSignal)) return;
    throw error;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) {
      process.removeListener(signal, handler);
    }
    if (receivedSignal) {
      process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    }
  }
}

export function isMatchingRuntimeInterrupt(error, receivedSignal) {
  return Boolean(
    receivedSignal &&
    error instanceof RuntimeInterruptedError &&
    error.signal === receivedSignal,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await runNextRuntimeSmokeCli();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
