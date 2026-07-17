/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import { MetricCard, createMetricScope } from "./metric";

const units = [
  {
    id: "unit-salam",
    name: "Salam Land",
    code: "salam-land",
    slug: "salam-land",
    membershipIds: ["membership-salam"],
    capabilities: ["lead.read"],
    capabilityRecordScopes: {},
  },
  {
    id: "unit-bumi",
    name: "Bumi Hayat",
    code: "bumi-hayat",
    slug: "bumi-hayat",
    membershipIds: ["membership-bumi"],
    capabilities: ["task.read"],
    capabilityRecordScopes: {},
  },
] as const;

const allScope: BusinessUnitReadScope = {
  kind: "ALL",
  queryValue: "all",
  units,
  unitIds: units.map((unit) => unit.id),
  writable: false,
};

const reportEnabledScope: BusinessUnitReadScope = {
  kind: "ALL",
  queryValue: "all",
  units: [
    { ...units[0], capabilities: ["lead.read", "report.read"] },
    units[1],
  ],
  unitIds: units.map((unit) => unit.id),
  writable: false,
};

afterEach(cleanup);

describe("MetricScope", () => {
  it("carries only units authorised for the metric capability and scoped drill-down", () => {
    expect(createMetricScope({
      scope: allScope,
      capability: "lead.read",
      dateBasis: "Tarikh diterima",
      periodLabel: "30 hari",
      asOf: "2026-07-17T12:00:00+08:00",
      freshness: "stale",
      attributionModel: null,
      definitionHref: "/leads?definition=lead-baharu",
      drilldownPath: "/leads?stage=new",
    })).toEqual({
      businessUnitIds: ["unit-salam"],
      businessUnitCodes: ["salam-land"],
      dateBasis: "Tarikh diterima",
      periodLabel: "30 hari",
      timezone: "Asia/Kuala_Lumpur",
      asOf: "2026-07-17T12:00:00+08:00",
      freshness: "stale",
      attributionModel: null,
      definitionHref: "/leads?definition=lead-baharu&bu=all",
      drilldownHref: "/leads?stage=new&bu=all",
    });
  });

  it("uses the owning module for a module-only viewer's definition", () => {
    const scope = createMetricScope({
      scope: allScope,
      capability: "lead.read",
      dateBasis: "Tarikh diterima",
      periodLabel: "30 hari",
      asOf: "2026-07-17T12:00:00+08:00",
      freshness: "stale",
      attributionModel: "Sentuhan terakhir",
      definitionHref: "/leads?definition=lead-baharu",
      drilldownPath: "/leads?stage=new",
    });
    render(createElement(MetricCard, { label: "Lead baharu", value: "42", scope }));

    expect(screen.getByRole("link", { name: "Lihat rekod Lead baharu" }).getAttribute("href"))
      .toBe("/leads?stage=new&bu=all");
    expect(screen.getByText("salam-land · 30 hari")).toBeTruthy();
    expect(screen.getByText("Tarikh diterima · Lewat")).toBeTruthy();
    const timestamp = document.querySelector("time") as HTMLTimeElement | null;
    expect(timestamp?.dateTime).toBe("2026-07-17T12:00:00+08:00");
    expect(timestamp?.textContent).toMatch(/17 Jul 2026/i);
    expect(timestamp?.textContent).not.toContain("T12:00:00");
    expect(screen.getByRole("link", { name: "Lihat definisi Lead baharu" }).getAttribute("href"))
      .toBe("/leads?definition=lead-baharu&bu=all");
  });

  it("renders the scoped definition link only with report access", () => {
    const scope = createMetricScope({
      scope: reportEnabledScope,
      capability: "lead.read",
      dateBasis: "Tarikh diterima",
      periodLabel: "30 hari",
      asOf: "2026-07-17T12:00:00+08:00",
      freshness: "stale",
      attributionModel: null,
      definitionHref: "/leads?definition=lead-baharu",
      drilldownPath: "/leads?stage=new",
    });
    render(createElement(MetricCard, { label: "Lead baharu", value: "42", scope }));

    expect(screen.getByRole("link", { name: "Lihat definisi Lead baharu" }).getAttribute("href"))
      .toBe("/leads?definition=lead-baharu&bu=all");
  });

  it("renders an unknown timestamp without inventing an as-of date", () => {
    const scope = createMetricScope({
      scope: allScope,
      capability: "lead.read",
      dateBasis: "Masa pemeriksaan",
      periodLabel: "Semasa",
      asOf: null,
      freshness: "unknown",
      attributionModel: null,
      definitionHref: "/settings?definition=unknown",
      drilldownPath: "/settings?metric=unknown",
    });
    const { container } = render(
      createElement(MetricCard, { label: "Status tidak diketahui", value: "1", scope }),
    );

    expect(screen.getByText("Masa pemeriksaan · Tidak diketahui")).toBeTruthy();
    expect(document.querySelector("time")).toBeNull();
    const scopeDetails = container.querySelector(".crm-metric__scope");
    expect(scopeDetails?.textContent?.match(/Tidak diketahui/g)).toHaveLength(1);
    expect(scopeDetails?.children).toHaveLength(3);
  });

  it("rejects an invalid KPI as-of timestamp", () => {
    expect(() => createMetricScope({
      scope: allScope,
      capability: "lead.read",
      dateBasis: "Tarikh diterima",
      periodLabel: "30 hari",
      asOf: "not-a-date",
      freshness: "unknown",
      attributionModel: null,
      definitionHref: "/reports/definitions/lead-baharu",
      drilldownPath: "/leads",
    })).toThrow("Metric as-of timestamp is invalid");
  });

  it.each(["fresh", "stale"] as const)(
    "rejects %s freshness when no as-of evidence exists",
    (freshness) => {
      expect(() => createMetricScope({
        scope: allScope,
        capability: "lead.read",
        dateBasis: "Masa pemeriksaan",
        periodLabel: "Semasa",
        asOf: null,
        freshness,
        attributionModel: null,
        definitionHref: "/settings?definition=unknown",
        drilldownPath: "/settings?metric=unknown",
      })).toThrow("Metric freshness requires an as-of timestamp");
    },
  );
});
