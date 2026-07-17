import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "./viewer";

const mocks = vi.hoisted(() => ({
  forbidden: vi.fn(),
  getViewer: vi.fn(),
  getRuntimeConfig: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  forbidden: mocks.forbidden,
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));

vi.mock("./viewer", () => ({
  getViewer: mocks.getViewer,
}));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import * as pageAccess from "./page-access";

const { createCrmModuleLayout, requirePageViewer, requireScopedPageViewer } = pageAccess;
const { canRenderDemoFixtures } = pageAccess;

const viewer: Viewer = {
  userId: "00000000-0000-4000-8000-000000000001",
  displayName: "Scoped Viewer",
  sessionExpiresAt: new Date("2026-07-17T12:00:00.000Z"),
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
  businessUnitAccess: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      name: "Salam Land",
      code: "salam-land",
      slug: "salam-land",
      membershipIds: ["00000000-0000-4000-8000-000000000201"],
      capabilities: ["finance.read"],
      capabilityRecordScopes: {},
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["00000000-0000-4000-8000-000000000202"],
      capabilities: ["task.read"],
      capabilityRecordScopes: {},
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
    mocks.getRuntimeConfig.mockReturnValue({
      demoMode: false,
      nodeEnv: "test",
      productSurface: "crm",
    });
    mocks.redirect.mockImplementation(() => {
      throw new Error("redirected");
    });
    mocks.forbidden.mockImplementation(() => {
      throw new Error("forbidden");
    });
    mocks.notFound.mockImplementation(() => {
      throw new Error("not-found");
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

describe("requireScopedPageViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });
    mocks.redirect.mockImplementation(() => {
      throw new Error("redirected");
    });
    mocks.forbidden.mockImplementation(() => {
      throw new Error("forbidden");
    });
    mocks.notFound.mockImplementation(() => {
      throw new Error("not-found");
    });
  });

  it("validates duplicate scope before authentication or redirects", async () => {
    mocks.getViewer.mockResolvedValue(null);

    await expect(
      requireScopedPageViewer(["salam-land", "bumi-hayat"], "finance.read", "/finance"),
    ).rejects.toThrow("not-found");
    expect(mocks.getViewer).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("preserves the exact validated scope in an unauthenticated return target", async () => {
    mocks.getViewer.mockResolvedValue(null);

    await expect(
      requireScopedPageViewer("salam-land", "finance.read", "/finance", {
        bu: "salam-land",
        tab: "aging",
      }),
    ).rejects.toThrow("redirected");
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/login?returnTo=%2Ffinance%3Ftab%3Daging%26bu%3Dsalam-land",
    );
  });

  it("canonicalizes an omitted scope to the resolved unit without losing safe query values", async () => {
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(
      requireScopedPageViewer(undefined, "finance.read", "/finance", {
        tab: "aging",
        filter: ["open", "late"],
      }),
    ).rejects.toThrow("redirected");
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/finance?tab=aging&filter=open&filter=late&bu=salam-land",
    );
  });

  it("canonicalizes to the first capability-eligible unit when the active preference is ineligible", async () => {
    mocks.getViewer.mockResolvedValue({
      ...viewer,
      businessUnitId: "00000000-0000-4000-8000-000000000102",
    });

    await expect(
      requireScopedPageViewer(undefined, "finance.read", "/finance", { view: "aging" }),
    ).rejects.toThrow("redirected");
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/finance?view=aging&bu=salam-land",
    );
  });

  it("does not redirect an already canonical scope", async () => {
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(
      requireScopedPageViewer("salam-land", "finance.read", "/finance", {
        bu: "salam-land",
        tab: "aging",
      }),
    ).resolves.toMatchObject({ scope: { queryValue: "salam-land" } });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("resolves per-unit capability access instead of the active cookie capabilities", async () => {
    mocks.getViewer.mockResolvedValue({
      ...viewer,
      capabilities: [],
      businessUnitId: "00000000-0000-4000-8000-000000000102",
    });

    await expect(
      requireScopedPageViewer("salam-land", "finance.read", "/finance"),
    ).resolves.toMatchObject({
      viewer: { businessUnitId: "00000000-0000-4000-8000-000000000102" },
      scope: {
        kind: "UNIT",
        businessUnitCode: "salam-land",
        businessUnitId: "00000000-0000-4000-8000-000000000101",
      },
    });
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("returns 403 for a valid but unauthorised unit", async () => {
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(
      requireScopedPageViewer("bumi-hayat", "finance.read", "/finance"),
    ).rejects.toThrow("forbidden");
    expect(mocks.forbidden).toHaveBeenCalledOnce();
  });

  it("limits Tasha scopes to Salam Land", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(
      requireScopedPageViewer("bumi-hayat", "task.read", "/tasks"),
    ).rejects.toThrow("forbidden");
  });
});

describe("createCrmModuleLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({
      demoMode: false,
      nodeEnv: "test",
      productSurface: "crm",
    });
    mocks.notFound.mockImplementation(() => {
      throw new Error("not-found");
    });
    mocks.redirect.mockImplementation(() => {
      throw new Error("redirected");
    });
    mocks.forbidden.mockImplementation(() => {
      throw new Error("forbidden");
    });
  });

  it("leaves authentication and query-aware capability checks to the page helper", async () => {
    mocks.getViewer.mockResolvedValue(null);
    const FinanceLayout = createCrmModuleLayout("finance");
    const child = "child";

    await expect(FinanceLayout({ children: child })).resolves.toBe(child);
    expect(mocks.getViewer).not.toHaveBeenCalled();
  });

  it("returns a cross-surface 404 before viewer, redirect, or forbidden work", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      demoMode: false,
      nodeEnv: "test",
      productSurface: "tasha",
    });
    mocks.getViewer.mockResolvedValue(null);
    const LeadsLayout = createCrmModuleLayout("leads");

    await expect(LeadsLayout({ children: "hidden" })).rejects.toThrow("not-found");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getViewer).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("keeps a shared Tasha route behind only the immutable surface boundary", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      demoMode: false,
      nodeEnv: "test",
      productSurface: "tasha",
    });
    mocks.getViewer.mockResolvedValue(viewer);
    const FinanceLayout = createCrmModuleLayout("finance");

    await expect(FinanceLayout({ children: "shared" })).resolves.toBe("shared");
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.getViewer).not.toHaveBeenCalled();
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
