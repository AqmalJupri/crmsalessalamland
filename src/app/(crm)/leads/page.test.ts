import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";
import type { DemoLead } from "@/lib/demo-crm";

const mocks = vi.hoisted(() => ({ requireScopedPageViewer: vi.fn() }));

vi.mock("@/server/auth/page-access", () => ({
  requireScopedPageViewer: mocks.requireScopedPageViewer,
}));

import LeadsPage from "./page";

interface LeadsPageProps {
  scope: ClientBusinessScope;
  canCreate: boolean;
  initialLeads: DemoLead[];
  initialStageFilter: string | null;
}

const access = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["lead.read", "lead.create"],
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
const baseViewer = {
  demo: false,
};

describe("LeadsPage fixture boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: baseViewer, scope });
  });

  it("passes an empty initial collection to every non-demo viewer", async () => {
    const page = (await LeadsPage({ searchParams: Promise.resolve({ bu: "salam-land" }) })) as ReactElement<LeadsPageProps>;

    expect(mocks.requireScopedPageViewer).toHaveBeenCalledWith(
      "salam-land",
      "lead.read",
      "/leads",
      { bu: "salam-land" },
    );
    expect(page.props.initialLeads).toEqual([]);
    expect(page.props.canCreate).toBe(true);
    expect(page.props.scope).toEqual({
      kind: "UNIT",
      queryValue: "salam-land",
      businessUnitId: access.id,
      businessUnitCode: "salam-land",
      businessUnitName: "Salam Land",
    });
    expect(JSON.stringify(page.props.scope)).not.toMatch(/membership|capabilit|recordScope|constraint/i);
    expect(page.props.initialStageFilter).toBeNull();
  });

  it("passes only the selected company's seeded leads to the client", async () => {
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { ...baseViewer, demo: true }, scope });

    const page = (await LeadsPage({ searchParams: Promise.resolve({ bu: "salam-land" }) })) as ReactElement<LeadsPageProps>;

    expect(page.props.initialLeads.length).toBeGreaterThan(0);
    expect(page.props.initialLeads.some((lead) => lead.name === "Nur Aisyah")).toBe(true);
    expect(page.props.initialLeads.every((lead) => lead.businessUnitId === access.id)).toBe(true);
  });

  it("passes only an allowlisted stage drill-down to the workspace", async () => {
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { ...baseViewer, demo: true }, scope });

    const accepted = (await LeadsPage({
      searchParams: Promise.resolve({ bu: "salam-land", stage: "new" }),
    })) as ReactElement<LeadsPageProps>;
    const rejected = (await LeadsPage({
      searchParams: Promise.resolve({ bu: "salam-land", stage: "../all" }),
    })) as ReactElement<LeadsPageProps>;

    expect(accepted.props.initialStageFilter).toBe("new");
    expect(rejected.props.initialStageFilter).toBeNull();
  });

  it("renders the owning-module Lead definition without report access", async () => {
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { ...baseViewer, demo: true }, scope });

    const page = await LeadsPage({
      searchParams: Promise.resolve({ bu: "salam-land", definition: "lead-baharu" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Definisi Lead baharu");
    expect(html).toContain("Bilangan lead berstatus Baharu.");
    expect(html).toContain("Rekod lead demo.");
    expect(html).toContain("Tarikh diterima");
  });
});
