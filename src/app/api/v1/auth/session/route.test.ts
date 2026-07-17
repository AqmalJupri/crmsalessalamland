import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/server/auth/viewer";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  getViewer: vi.fn(),
}));

vi.mock("@/server/auth/viewer", () => ({ getViewer: mocks.getViewer }));
vi.mock("@/server/env", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));

import { GET } from "./route";

function recursiveKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(recursiveKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...recursiveKeys(nested)]);
}

const viewer = {
  userId: "user-secret",
  displayName: "Aqmal Jupri",
  organizationId: "organization-secret",
  businessUnitId: "unit-salam",
  businessUnits: [{ id: "unit-salam", name: "Salam Land", code: "salam-land", slug: "salam-land" }],
  businessUnitAccess: [{
    id: "unit-salam",
    name: "Salam Land",
    code: "salam-land",
    slug: "salam-land",
    membershipIds: ["membership-secret"],
    capabilities: ["lead.read"],
    capabilityRecordScopes: { "lead.read": ["OWN"] },
  }],
  activeMembershipId: "membership-secret",
  membershipIds: ["membership-secret"],
  capabilities: ["lead.read"],
  capabilityRecordScopes: { "lead.read": ["OWN"] },
  demo: false,
} as unknown as Viewer;

describe("GET /api/v1/auth/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });
  });

  it("returns only the centralized public viewer projection", async () => {
    mocks.getViewer.mockResolvedValue(viewer);

    const response = await GET(new Request("https://crm.test/api/v1/auth/session"));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: true,
      viewer: {
        displayName: "Aqmal Jupri",
        businessUnitId: "unit-salam",
        businessUnitAccess: [{
          id: "unit-salam",
          name: "Salam Land",
          code: "salam-land",
          capabilities: ["lead.read"],
        }],
        demo: false,
      },
    });
    const keys = recursiveKeys(body);
    for (const internalKey of [
      "userId",
      "organizationId",
      "activeMembershipId",
      "membershipIds",
      "capabilityRecordScopes",
      "recordScopes",
      "slug",
    ]) expect(keys).not.toContain(internalKey);
  });

  it("keeps Tasha's public projection Salam-only", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });
    mocks.getViewer.mockResolvedValue({
      ...viewer,
      businessUnitId: "unit-bumi",
      businessUnitAccess: [
        viewer.businessUnitAccess[0],
        { ...viewer.businessUnitAccess[0], id: "unit-bumi", code: "bumi-hayat", name: "Bumi Hayat" },
      ],
    });

    const response = await GET(new Request("https://tasha.test/api/v1/auth/session"));
    const body = await response.json() as { viewer: { businessUnitId: string | null; businessUnitAccess: Array<{ code: string }> } };

    expect(body.viewer.businessUnitId).toBe("unit-salam");
    expect(body.viewer.businessUnitAccess.map((unit) => unit.code)).toEqual(["salam-land"]);
  });
});
