import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeadsWorkspace } from "@/components/crm/leads-workspace";
import * as demoCrm from "@/lib/demo-crm";

interface DesiredDemoCrmHelpers {
  demoFinanceReceipts?: ReadonlyArray<{
    businessUnitId: string;
    amountMinor: number;
  }>;
  aggregateDemoKpiInputs?: (
    inputs: typeof demoCrm.demoKpis,
    unitIds: readonly string[],
  ) => {
    leadNewCount: number;
    overdueTaskCount: number;
    pipelineValueMinor: number;
    collectionMinor: number;
  };
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
  it("binds every synthetic record to a named company and filters by exact IDs", () => {
    const recordGroups = [
      demoCrm.demoLeads,
      demoCrm.demoTasks,
      demoCrm.demoActivities,
      demoCrm.demoKpis,
      demoCrm.opportunityStages.flatMap((stage) => stage.items),
    ];
    for (const records of recordGroups) {
      expect(records.every((record) =>
        "businessUnitId" in record &&
        "businessUnitCode" in record &&
        "businessUnitName" in record
      )).toBe(true);
    }

    const salamId = "00000000-0000-4000-8000-000000000101";
    const scopedLeads = demoCrm.filterDemoRecordsByUnitIds(demoCrm.demoLeads, [salamId]);
    expect(scopedLeads.length).toBeGreaterThan(0);
    expect(scopedLeads.every((record) => record.businessUnitId === salamId)).toBe(true);
    const scopedStages = demoCrm.filterOpportunityStagesByUnitIds(
      demoCrm.opportunityStages,
      [salamId],
    );
    expect(scopedStages.flatMap((stage) => stage.items).every(
      (record) => record.businessUnitId === salamId,
    )).toBe(true);
  });

  it("stores one non-negative KPI fixture per company for scoped aggregation", () => {
    expect(demoCrm.demoKpis.map((kpi) => kpi.businessUnitId).sort()).toEqual(
      Object.values(demoCrm.demoBusinessUnits).map((unit) => unit.businessUnitId).sort(),
    );
    for (const kpi of demoCrm.demoKpis) {
      expect(kpi.leadNewCount).toBeGreaterThanOrEqual(0);
      expect(kpi.overdueTaskCount).toBeGreaterThanOrEqual(0);
      expect(kpi.pipelineValueMinor).toBeGreaterThanOrEqual(0);
      expect(kpi.collectionMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it("aggregates exact per-company KPI inputs for Salam, restricted Semua, and full Semua", () => {
    expect(typeof helpers.aggregateDemoKpiInputs).toBe("function");
    if (!helpers.aggregateDemoKpiInputs) return;
    const { salam, bumi, barakah } = demoCrm.demoBusinessUnits;

    expect(helpers.aggregateDemoKpiInputs(demoCrm.demoKpis, [salam.businessUnitId])).toEqual({
      leadNewCount: 0,
      overdueTaskCount: 1,
      pipelineValueMinor: 69_500_000,
      collectionMinor: 1_250_000,
    });
    expect(helpers.aggregateDemoKpiInputs(demoCrm.demoKpis, [salam.businessUnitId, bumi.businessUnitId])).toEqual({
      leadNewCount: 1,
      overdueTaskCount: 1,
      pipelineValueMinor: 88_300_000,
      collectionMinor: 2_050_000,
    });
    expect(helpers.aggregateDemoKpiInputs(demoCrm.demoKpis, [
      salam.businessUnitId,
      bumi.businessUnitId,
      barakah.businessUnitId,
    ])).toEqual({
      leadNewCount: 1,
      overdueTaskCount: 2,
      pipelineValueMinor: 126_900_000,
      collectionMinor: 3_900_000,
    });
  });

  it("reconciles every KPI input to its visible drill-down population", () => {
    expect(helpers.demoFinanceReceipts).toBeDefined();
    if (!helpers.demoFinanceReceipts) return;
    for (const kpi of demoCrm.demoKpis) {
      const unitId = kpi.businessUnitId;
      expect(kpi.leadNewCount).toBe(
        demoCrm.demoLeads.filter((lead) => lead.businessUnitId === unitId && lead.stage === "new").length,
      );
      expect(kpi.overdueTaskCount).toBe(
        demoCrm.demoTasks.filter((task) =>
          task.businessUnitId === unitId && "status" in task && task.status === "overdue"
        ).length,
      );
      expect(kpi.pipelineValueMinor).toBe(
        demoCrm.opportunityStages
          .filter((stage) => stage.id !== "won")
          .flatMap((stage) => stage.items)
          .filter((item) => item.businessUnitId === unitId)
          .reduce((sum, item) => sum + item.valueMinor, 0),
      );
      expect(kpi.collectionMinor).toBe(
        helpers.demoFinanceReceipts
          .filter((receipt) => receipt.businessUnitId === unitId)
          .reduce((sum, receipt) => sum + receipt.amountMinor, 0),
      );
    }
  });

  it("keeps monetary value out of Lead records and UI", () => {
    expect(demoCrm.demoLeads.every((lead) => !("valueMinor" in lead))).toBe(true);

    const html = renderToStaticMarkup(
      createElement(LeadsWorkspace, {
        scope: {
          kind: "UNIT",
          queryValue: "salam-land",
          businessUnitId: "00000000-0000-4000-8000-000000000101",
          businessUnitCode: "salam-land",
          businessUnitName: "Salam Land",
        },
        canCreate: true,
        initialLeads: demoCrm.demoLeads,
        initialStageFilter: null,
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
