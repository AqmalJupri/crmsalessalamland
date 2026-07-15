import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "./viewer";

const mocks = vi.hoisted(() => ({
  forbidden: vi.fn(),
  getViewer: vi.fn(),
  getRuntimeConfig: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  forbidden: mocks.forbidden,
  redirect: mocks.redirect,
}));

vi.mock("./viewer", () => ({
  getViewer: mocks.getViewer,
}));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import * as pageAccess from "./page-access";

const { createCrmModuleLayout, requirePageViewer } = pageAccess;
const { canRenderDemoFixtures } = pageAccess;

const viewer: Viewer = {
  userId: "00000000-0000-4000-8000-000000000001",
  displayName: "Scoped Viewer",
  organizationId: "00000000-0000-4000-8000-000000000010",
  businessUnitId: "00000000-0000-4000-8000-000000000101",
  businessUnits: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      name: "Salam Land",
      code: "salam-land",
      slug: "salam-land",
    },
  ],
  activeMembershipId: "00000000-0000-4000-8000-000000000201",
  membershipIds: ["00000000-0000-4000-8000-000000000201"],
  capabilities: ["finance.read"],
  capabilityRecordScopes: {},
  demo: false,
};

describe("requirePageViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation(() => {
      throw new Error("redirected");
    });
    mocks.forbidden.mockImplementation(() => {
      throw new Error("forbidden");
    });
  });

  it("preserves the exact safe deep link when authentication is required", async () => {
    mocks.getViewer.mockResolvedValue(null);

    await expect(
      requirePageViewer("finance.read", "/finance?tab=aging#overdue"),
    ).rejects.toThrow("redirected");
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/login?returnTo=%2Ffinance%3Ftab%3Daging%23overdue",
    );
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("renders the 403 boundary for an authenticated viewer without the module capability", async () => {
    mocks.getViewer.mockResolvedValue({ ...viewer, capabilities: [] });

    await expect(requirePageViewer("finance.read", "/finance")).rejects.toThrow("forbidden");
    expect(mocks.forbidden).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("returns an authenticated viewer with the required capability", async () => {
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(requirePageViewer("finance.read", "/finance")).resolves.toBe(viewer);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("supports an auth-only page without inventing a capability", async () => {
    mocks.getViewer.mockResolvedValue({ ...viewer, capabilities: [] });

    await expect(requirePageViewer(undefined, "/")).resolves.toMatchObject({ userId: viewer.userId });
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });
});

describe("createCrmModuleLayout", () => {
  it("binds the module capability and exact return path to the server layout", async () => {
    vi.clearAllMocks();
    mocks.getViewer.mockResolvedValue(viewer);
    const FinanceLayout = createCrmModuleLayout("finance");
    const child = "child";

    await expect(FinanceLayout({ children: child })).resolves.toBe(child);
    expect(mocks.getViewer).toHaveBeenCalledOnce();
  });
});

describe("canRenderDemoFixtures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses static fixtures in production even when the demo switch is set", () => {
    mocks.getRuntimeConfig.mockReturnValue({ demoMode: true, nodeEnv: "production" });

    expect(canRenderDemoFixtures()).toBe(false);
    expect(mocks.getViewer).not.toHaveBeenCalled();
  });

  it("allows static fixtures only when demo mode is explicit outside production", () => {
    mocks.getRuntimeConfig.mockReturnValue({ demoMode: true, nodeEnv: "development" });

    expect(canRenderDemoFixtures()).toBe(true);
    expect(mocks.getViewer).not.toHaveBeenCalled();
  });

  it("refuses static fixtures when the demo switch is off", () => {
    mocks.getRuntimeConfig.mockReturnValue({ demoMode: false, nodeEnv: "development" });

    expect(canRenderDemoFixtures()).toBe(false);
    expect(mocks.getViewer).not.toHaveBeenCalled();
  });
});
