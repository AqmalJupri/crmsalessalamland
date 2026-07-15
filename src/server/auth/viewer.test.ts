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

import { getViewer } from "./viewer";

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

    await expect(getViewer()).resolves.toMatchObject({ demo: true });
    expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(2);
  });
});
