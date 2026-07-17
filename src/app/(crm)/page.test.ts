import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  requireScopedPageViewer: vi.fn(),
}));

vi.mock("@/server/auth/page-access", () => ({
  requireScopedPageViewer: mocks.requireScopedPageViewer,
}));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("@/components/crm/surface-home", () => ({
  SurfaceHome: "surface-home",
}));

import DashboardPage from "./page";

const access = {
  id: "unit-salam",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["lead.read"],
  capabilityRecordScopes: {},
};
const scope = {
  kind: "UNIT" as const,
  queryValue: "salam-land",
  businessUnitId: "unit-salam",
  businessUnitCode: "salam-land",
  access,
  writable: true as const,
};

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { demo: true }, scope });
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });
  });

  it("keeps the auth-only root boundary and passes the server CRM surface", async () => {
    await expect(DashboardPage({ searchParams: Promise.resolve({ bu: "salam-land" }) })).resolves.toMatchObject({
      type: "surface-home",
      props: { demo: true, surface: "crm", scope },
    });
    expect(mocks.requireScopedPageViewer).toHaveBeenCalledWith(
      "salam-land",
      undefined,
      "/",
      { bu: "salam-land" },
    );
    expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("passes Tasha and the real viewer demo flag without request-host inference", async () => {
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { demo: false }, scope });
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });

    await expect(DashboardPage({ searchParams: Promise.resolve({}) })).resolves.toMatchObject({
      type: "surface-home",
      props: { demo: false, surface: "tasha", scope },
    });
  });
});
