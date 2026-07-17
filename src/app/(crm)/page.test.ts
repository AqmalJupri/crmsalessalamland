import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  requirePageViewer: vi.fn(),
}));

vi.mock("@/server/auth/page-access", () => ({
  requirePageViewer: mocks.requirePageViewer,
}));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("@/components/crm/surface-home", () => ({
  SurfaceHome: "surface-home",
}));

import DashboardPage from "./page";

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePageViewer.mockResolvedValue({ demo: true });
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });
  });

  it("keeps the auth-only root boundary and passes the server CRM surface", async () => {
    await expect(DashboardPage()).resolves.toMatchObject({
      type: "surface-home",
      props: { demo: true, surface: "crm" },
    });
    expect(mocks.requirePageViewer).toHaveBeenCalledWith(undefined, "/");
    expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("passes Tasha and the real viewer demo flag without request-host inference", async () => {
    mocks.requirePageViewer.mockResolvedValue({ demo: false });
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });

    await expect(DashboardPage()).resolves.toMatchObject({
      type: "surface-home",
      props: { demo: false, surface: "tasha" },
    });
  });
});
