import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/server/auth/viewer";

const mocks = vi.hoisted(() => ({
  forbidden: vi.fn(),
  getRuntimeConfig: vi.fn(),
  getViewer: vi.fn(),
  headers: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/server/auth/viewer", () => ({ getViewer: mocks.getViewer }));
vi.mock("@/server/env", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  forbidden: mocks.forbidden,
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("@/components/crm/application-shell", () => ({
  ApplicationShell: "application-shell",
}));

import CrmLayout from "./layout";

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
    {
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat",
      code: "bumi-hayat",
      slug: "bumi-hayat",
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
      capabilityRecordScopes: { "finance.read": ["BUSINESS_UNIT"] },
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

describe("CRM parent layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });
    mocks.headers.mockResolvedValue(new Headers({ "x-salam-request-path": "/" }));
    mocks.notFound.mockImplementation(() => {
      throw new Error("not-found");
    });
  });

  it("lets the nested module boundary own the exact unauthenticated redirect", async () => {
    mocks.getViewer.mockResolvedValue(null);

    await expect(CrmLayout({ children: "protected child" })).resolves.toBe("protected child");
    expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce();
    expect(mocks.headers).toHaveBeenCalledOnce();
    expect(mocks.headers.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getViewer.mock.invocationCallOrder[0]!,
    );
  });

  it("passes only a Tasha Salam-safe capability projection to the client shell", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({ "x-salam-request-path": "/finance" }),
    );
    mocks.getViewer.mockResolvedValue(viewer);

    const result = await CrmLayout({ children: "protected child" });
    expect(result).toMatchObject({
      props: {
        children: "protected child",
        surface: "tasha",
        viewer: {
          businessUnitId: viewer.businessUnitId,
          businessUnitAccess: [
            {
              id: "00000000-0000-4000-8000-000000000101",
              name: "Salam Land",
              code: "salam-land",
              capabilities: ["finance.read"],
            },
          ],
          demo: false,
          displayName: viewer.displayName,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("membership");
    expect(JSON.stringify(result)).not.toContain("recordScope");
    expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("never leaks a non-Salam active preference into the Tasha client boundary", async () => {
    mocks.headers.mockResolvedValue(new Headers({ "x-salam-request-path": "/finance" }));
    mocks.getViewer.mockResolvedValue({
      ...viewer,
      businessUnitId: "00000000-0000-4000-8000-000000000102",
      activeMembershipId: "00000000-0000-4000-8000-000000000202",
      membershipIds: ["00000000-0000-4000-8000-000000000202"],
      capabilities: ["task.read"],
    });

    const result = await CrmLayout({ children: "protected child" });
    expect(result).toMatchObject({
      props: {
        viewer: {
          businessUnitId: "00000000-0000-4000-8000-000000000101",
          businessUnitAccess: [
            expect.objectContaining({
              id: "00000000-0000-4000-8000-000000000101",
              code: "salam-land",
            }),
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("00000000-0000-4000-8000-000000000102");
    expect(JSON.stringify(result)).not.toContain("00000000-0000-4000-8000-000000000202");
  });

  it("404s a CRM-only Tasha route before any viewer or auth interrupt work", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({ "x-salam-request-path": "/leads/lead-123" }),
    );
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(CrmLayout({ children: "hidden" })).rejects.toThrow("not-found");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getViewer).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("fails closed before viewer work when the proxy path is missing", async () => {
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(CrmLayout({ children: "missing" })).rejects.toThrow("not-found");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getViewer).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });

  it("fails closed before viewer work for an unknown path", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });
    mocks.headers.mockResolvedValue(
      new Headers({ "x-salam-request-path": "/unknown" }),
    );
    mocks.getViewer.mockResolvedValue(viewer);

    await expect(CrmLayout({ children: "unknown" })).rejects.toThrow("not-found");
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getViewer).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.forbidden).not.toHaveBeenCalled();
  });
});
