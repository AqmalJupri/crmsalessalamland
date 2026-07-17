import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateReadiness: vi.fn(async () => ({
    body: { status: "ready" },
    statusCode: 200,
  })),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(() => ({ execute: vi.fn() })),
}));
vi.mock("@/server/db/migration-manifest", () => ({
  assertMigrationLedgerCurrent: vi.fn(),
}));
vi.mock("@/server/env", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));
vi.mock("@/server/health/readiness", () => ({
  evaluateReadiness: mocks.evaluateReadiness,
}));

import { GET as getLive } from "./live/route";
import { GET as getReady } from "./ready/route";

const originalInstanceId = process.env.RUNTIME_SMOKE_INSTANCE_ID;
const instanceId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  if (originalInstanceId === undefined) {
    delete process.env.RUNTIME_SMOKE_INSTANCE_ID;
  } else {
    process.env.RUNTIME_SMOKE_INSTANCE_ID = originalInstanceId;
  }
  vi.clearAllMocks();
});

describe("runtime health instance identity", () => {
  it.each([
    ["live", () => getLive()],
    ["ready", () => getReady()],
  ] as const)("echoes the reviewed per-run identity on %s health", async (_name, request) => {
    process.env.RUNTIME_SMOKE_INSTANCE_ID = instanceId;

    const response = await request();

    expect(response.headers.get("x-runtime-smoke-instance")).toBe(instanceId);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-reviewed-runtime-instance"],
  ] as const)("does not reflect a %s runtime identity", async (_name, value) => {
    if (value === undefined) delete process.env.RUNTIME_SMOKE_INSTANCE_ID;
    else process.env.RUNTIME_SMOKE_INSTANCE_ID = value;

    expect((await getLive()).headers.get("x-runtime-smoke-instance")).toBeNull();
    expect((await getReady()).headers.get("x-runtime-smoke-instance")).toBeNull();
  });
});
