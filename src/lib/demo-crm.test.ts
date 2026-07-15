import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeadsWorkspace } from "@/components/crm/leads-workspace";
import * as demoCrm from "@/lib/demo-crm";

interface DesiredDemoCrmHelpers {
  getLeadStageFilterOptions?: (leads: readonly { stage: string }[]) => Array<{
    value: string;
    label: string;
  }>;
  getLeadStagePresentation?: (stage: string) => {
    label: string;
    variant: "neutral" | "success" | "danger" | "info";
  };
  getProviderLabel?: (providerKey: string) => string;
  opportunityStageTotalMinor?: (items: readonly { valueMinor: number }[]) => number;
}

const helpers = demoCrm as typeof demoCrm & DesiredDemoCrmHelpers;

describe("demo CRM fixture invariants", () => {
  it("keeps monetary value out of Lead records and UI", () => {
    expect(demoCrm.demoLeads.every((lead) => !("valueMinor" in lead))).toBe(true);

    const html = renderToStaticMarkup(
      createElement(LeadsWorkspace, {
        businessUnitId: "00000000-0000-4000-8000-000000000101",
        canCreate: true,
        initialLeads: demoCrm.demoLeads,
      }),
    );
    expect(html).not.toContain("Nilai");
  });

  it("stores Lead product interest under the canonical field name", () => {
    expect(demoCrm.demoLeads.every((lead) => "productInterest" in lead && !("product" in lead))).toBe(true);
  });

  it("stores canonical provider keys and presents known and unknown providers safely", () => {
    expect(demoCrm.demoLeads.every((lead) => /^[a-z][a-z0-9_-]{1,63}$/.test(lead.source))).toBe(true);
    expect(typeof helpers.getProviderLabel).toBe("function");
    if (!helpers.getProviderLabel) return;

    expect(helpers.getProviderLabel("meta")).toBe("Meta");
    expect(helpers.getProviderLabel("partner_portal")).toBe("Partner portal");
    expect(helpers.getProviderLabel("google.ads")).toBe("Google ads");
    expect(helpers.getProviderLabel("<script>alert(1)</script>")).toBe("Sumber lain");
  });

  it("uses a neutral, readable fallback for an arbitrary API stage code", () => {
    expect(typeof helpers.getLeadStagePresentation).toBe("function");
    if (!helpers.getLeadStagePresentation) return;

    expect(helpers.getLeadStagePresentation("qualified")).toEqual({ label: "Layak", variant: "success" });
    expect(helpers.getLeadStagePresentation("awaiting-documents")).toEqual({
      label: "Awaiting documents",
      variant: "neutral",
    });
    expect(helpers.getLeadStagePresentation("<script>")).toEqual({
      label: "Status lain",
      variant: "neutral",
    });
  });

  it("derives filter options only from stages present in the current Lead data", () => {
    expect(typeof helpers.getLeadStageFilterOptions).toBe("function");
    if (!helpers.getLeadStageFilterOptions) return;

    const options = helpers.getLeadStageFilterOptions([
      { stage: "new" },
      { stage: "awaiting-documents" },
      { stage: "new" },
    ]);
    expect(options).toEqual([
      { value: "awaiting-documents", label: "Awaiting documents" },
      { value: "new", label: "Baharu" },
    ]);
    expect(options.some((option) => option.value === "qualified")).toBe(false);
  });

  it("marks every Lead represented by an Opportunity as converted", () => {
    const leadsByName = new Map(demoCrm.demoLeads.map((lead) => [lead.name, lead]));

    for (const opportunity of demoCrm.opportunityStages.flatMap((stage) => stage.items)) {
      const originatingLead = leadsByName.get(opportunity.title);
      if (originatingLead) expect(originatingLead.stage).toBe("converted");
    }
  });

  it("stores Opportunity values in minor units and derives stage totals from cards", () => {
    const allItems = demoCrm.opportunityStages.flatMap((stage) => stage.items);
    expect(allItems.every((item) => typeof item.valueMinor === "number" && !("value" in item))).toBe(true);
    expect(demoCrm.opportunityStages.every((stage) => !("value" in stage))).toBe(true);
    expect(typeof helpers.opportunityStageTotalMinor).toBe("function");
    if (!helpers.opportunityStageTotalMinor) return;

    const qualification = demoCrm.opportunityStages.find((stage) => stage.id === "qualification");
    expect(qualification).toBeDefined();
    expect(helpers.opportunityStageTotalMinor(qualification!.items)).toBe(50_500_000);

    const [moved, ...remaining] = qualification!.items;
    expect(helpers.opportunityStageTotalMinor(remaining)).toBe(32_000_000);
    expect(helpers.opportunityStageTotalMinor([moved!])).toBe(18_500_000);
  });
});
