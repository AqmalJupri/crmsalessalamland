import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const requestState = {
    id: "request-a",
    values: new Map<string, unknown>(),
  };

  return {
    requestState,
    cache: vi.fn(
      (resolver: () => unknown) => () => {
        if (!requestState.values.has(requestState.id)) {
          requestState.values.set(requestState.id, resolver());
        }
        return requestState.values.get(requestState.id);
      },
    ),
    getRuntimeConfig: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("react", () => ({
  cache: mocks.cache,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({
  getDatabase: vi.fn(),
}));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import { getViewer, requireApiViewerForBusinessUnit } from "./viewer";

const demoViewerSource = readFileSync(new URL("./viewer.ts", import.meta.url), "utf8");

describe("getViewer request memoization", () => {
  beforeEach(() => {
    mocks.requestState.id = "request-a";
    mocks.requestState.values.clear();
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({ demoMode: true, nodeEnv: "test" });
  });

  it("deduplicates one request while resolving again for the next request", async () => {
    const [firstRead, secondRead] = await Promise.all([getViewer(), getViewer()]);

    expect(firstRead).toBe(secondRead);
    expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce();

    mocks.requestState.id = "request-b";

    await expect(getViewer()).resolves.toMatchObject({ demo: true, sessionExpiresAt: null });
    expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it("uses an explicitly synthetic demo identity", async () => {
    await expect(getViewer()).resolves.toMatchObject({
      demo: true,
      displayName: "Pengguna Demo",
    });
  });

  it("rejects the previous real-looking identity from browser-reachable demo source", () => {
    expect(demoViewerSource).not.toContain("Aqmal Jupri");
  });
});

describe("requireApiViewerForBusinessUnit", () => {
  beforeEach(() => {
    mocks.requestState.id = crypto.randomUUID();
    mocks.requestState.values.clear();
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({ demoMode: true, nodeEnv: "test" });
  });

  it("returns the requested unit's memberships and capabilities", async () => {
    await expect(requireApiViewerForBusinessUnit(
      "lead.create",
      "00000000-0000-4000-8000-000000000102",
    )).resolves.toMatchObject({
      businessUnitId: "00000000-0000-4000-8000-000000000102",
      activeMembershipId: "00000000-0000-4000-8000-000000000202",
      membershipIds: ["00000000-0000-4000-8000-000000000202"],
    });
  });

  it("rejects a unit outside the per-unit capability projection", async () => {
    await expect(requireApiViewerForBusinessUnit(
      "lead.create",
      "00000000-0000-4000-8000-000000000199",
    )).rejects.toMatchObject({ status: 403, code: "BUSINESS_UNIT_FORBIDDEN" });
  });
});
