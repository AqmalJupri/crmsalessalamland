import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";
import { opportunityStages, type DemoOpportunityStage } from "@/lib/demo-crm";

const mocks = vi.hoisted(() => ({
  canRenderDemoFixtures: vi.fn(),
  requireScopedPageViewer: vi.fn(),
}));

vi.mock("@/server/auth/page-access", () => ({
  canRenderDemoFixtures: mocks.canRenderDemoFixtures,
  requireScopedPageViewer: mocks.requireScopedPageViewer,
}));

import PipelinePage from "./page";

interface PipelinePageProps {
  initialStages: DemoOpportunityStage[];
  sourcePopulationCount: number;
  scope: ClientBusinessScope;
  populationKey: "all" | "active";
  activeFilterLabel?: string | null;
}

const access = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["opportunity.read"],
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

describe("PipelinePage fixture boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canRenderDemoFixtures.mockReturnValue(false);
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { demo: false }, scope });
  });

  it("passes no demo opportunities to a non-demo viewer", async () => {
    const page = (await PipelinePage({ searchParams: Promise.resolve({ bu: "salam-land" }) })) as ReactElement<PipelinePageProps>;

    expect(mocks.requireScopedPageViewer).toHaveBeenCalledWith(
      "salam-land",
      "opportunity.read",
      "/pipeline",
      { bu: "salam-land" },
    );
    expect(mocks.canRenderDemoFixtures).toHaveBeenCalledWith();
    expect(page.props.initialStages).toEqual([]);
    expect(page.props.sourcePopulationCount).toBe(0);
    expect(page.props.populationKey).toBe("all");
    expect(page.props.scope).toEqual({
      kind: "UNIT",
      queryValue: "salam-land",
      businessUnitId: access.id,
      businessUnitCode: "salam-land",
      businessUnitName: "Salam Land",
    });
    expect(JSON.stringify(page.props.scope)).not.toMatch(/membership|capabilit|recordScope|constraint/i);
  });

  it("passes only the selected company's seeded opportunities to the client", async () => {
    mocks.canRenderDemoFixtures.mockReturnValue(true);

    const page = (await PipelinePage({ searchParams: Promise.resolve({ bu: "salam-land" }) })) as ReactElement<PipelinePageProps>;

    expect(page.props.initialStages.length).toBeGreaterThan(0);
    expect(page.props.initialStages.flatMap((stage) => stage.items).length).toBeGreaterThan(0);
    expect(page.props.initialStages.flatMap((stage) => stage.items)
      .every((item) => item.businessUnitId === access.id)).toBe(true);
    expect(page.props.sourcePopulationCount).toBe(
      page.props.initialStages.flatMap((stage) => stage.items).length,
    );
  });

  it("applies the active pipeline population and exposes its truthful definition", async () => {
    mocks.canRenderDemoFixtures.mockReturnValue(true);

    const filtered = (await PipelinePage({
      searchParams: Promise.resolve({ bu: "salam-land", metric: "active" }),
    })) as ReactElement<PipelinePageProps>;
    expect(filtered.props.activeFilterLabel).toBe("Pipeline aktif");
    expect(filtered.props.populationKey).toBe("active");
    expect(filtered.props.initialStages.some((stage) => stage.id === "won")).toBe(false);
    expect(filtered.props.initialStages.flatMap((stage) => stage.items)
      .reduce((sum, item) => sum + item.valueMinor, 0)).toBe(69_500_000);
    expect(filtered.props.sourcePopulationCount).toBe(
      opportunityStages
        .flatMap((stage) => stage.items)
        .filter((item) => item.businessUnitId === access.id).length,
    );

    const definition = await PipelinePage({
      searchParams: Promise.resolve({ bu: "salam-land", definition: "active" }),
    });
    const html = renderToStaticMarkup(definition);
    expect(html).toContain("Definisi Nilai pipeline");
    expect(html).toContain("Jumlah nilai peluang selain peringkat Menang.");
    expect(html).toContain("Rekod peluang demo.");
  });
});
