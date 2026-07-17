import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";

const mocks = vi.hoisted(() => ({
  canRenderDemoFixtures: vi.fn(),
  requireScopedPageViewer: vi.fn(),
}));

vi.mock("@/server/auth/page-access", () => ({
  canRenderDemoFixtures: mocks.canRenderDemoFixtures,
  requireScopedPageViewer: mocks.requireScopedPageViewer,
}));

import SettingsPage from "./page";

const access = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["settings.read"],
  capabilityRecordScopes: {},
} as const;
const scope: BusinessUnitReadScope = {
  kind: "UNIT",
  queryValue: access.code,
  businessUnitId: access.id,
  businessUnitCode: access.code,
  access,
  writable: true,
};

describe("SettingsPage integration health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canRenderDemoFixtures.mockReturnValue(true);
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { demo: true }, scope });
  });

  it("renders unknown health until timestamped evidence exists", async () => {
    const html = renderToStaticMarkup(await SettingsPage({
      searchParams: Promise.resolve({
        bu: "salam-land",
        metric: "unknown",
        definition: "unknown",
      }),
    }));

    expect(html).toContain("Tidak diketahui");
    expect(html).toContain("Status tidak diketahui");
    expect(html).toContain("Bilangan integrasi tanpa bukti masa pemeriksaan.");
    expect(html).toContain("Tapis: Status tidak diketahui · 1 rekod");
    expect(html).not.toContain("17 Jul 2026");
    expect(html).not.toMatch(/\bSihat\b|Perlu semak|(?:2|4|18) min/);
  });
});
