import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/server/auth/viewer";

const mocks = vi.hoisted(() => ({ getViewer: vi.fn() }));

vi.mock("@/server/auth/viewer", () => ({ getViewer: mocks.getViewer }));
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
  ],
  activeMembershipId: "00000000-0000-4000-8000-000000000201",
  membershipIds: ["00000000-0000-4000-8000-000000000201"],
  capabilities: ["finance.read"],
  capabilityRecordScopes: {},
  demo: false,
};

describe("CRM parent layout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets the nested module boundary own the exact unauthenticated redirect", async () => {
    mocks.getViewer.mockResolvedValue(null);

    await expect(CrmLayout({ children: "protected child" })).resolves.toBe("protected child");
  });

  it("renders the application shell only after a viewer is authenticated", async () => {
    mocks.getViewer.mockResolvedValue(viewer);

    const result = await CrmLayout({ children: "protected child" });
    expect(result).toMatchObject({
      props: {
        children: "protected child",
        viewer: {
          businessUnitId: viewer.businessUnitId,
          capabilities: viewer.capabilities,
          demo: false,
          displayName: viewer.displayName,
        },
      },
    });
  });
});
