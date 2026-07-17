/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import type { MetricScope } from "./metric";
import { createDemoModuleMetrics, OperationalModule } from "./operational-module";

const access = [
  {
    id: "unit-salam", name: "Salam Land", code: "salam-land", slug: "salam-land",
    membershipIds: ["membership-salam"], capabilities: ["order.read"], capabilityRecordScopes: {},
  },
  {
    id: "unit-bumi", name: "Bumi Hayat", code: "bumi-hayat", slug: "bumi-hayat",
    membershipIds: ["membership-bumi"], capabilities: ["order.read"], capabilityRecordScopes: {},
  },
] as const;
const allScope: BusinessUnitReadScope = {
  kind: "ALL", queryValue: "all", units: access, unitIds: access.map((unit) => unit.id), writable: false,
};
const metricScope: MetricScope = {
  businessUnitIds: access.map((unit) => unit.id),
  businessUnitCodes: access.map((unit) => unit.code),
  dateBasis: "Tarikh pesanan",
  periodLabel: "30 hari",
  timezone: "Asia/Kuala_Lumpur",
  asOf: "2026-07-17T12:00:00+08:00",
  freshness: "stale",
  attributionModel: null,
  definitionHref: "/reports/definitions/orders?bu=all",
  drilldownHref: "/orders?bu=all",
};
const rows = [
  { id: "row-salam", businessUnitId: "unit-salam", businessUnitCode: "salam-land", businessUnitName: "Salam Land", order: "SL-1" },
  { id: "row-bumi", businessUnitId: "unit-bumi", businessUnitCode: "bumi-hayat", businessUnitName: "Bumi Hayat", order: "BH-1" },
];

afterEach(cleanup);

describe("OperationalModule scope", () => {
  it("builds real in-module drill-downs and definitions for module-only viewers", () => {
    expect(createDemoModuleMetrics({
      scope: allScope,
      capability: "order.read",
      modulePath: "/orders",
      dateBasis: "Tarikh pesanan",
      periodLabel: "30 hari",
      rows,
      metrics: [
        {
          key: "active",
          label: "Aktif",
          filterLabel: "Pesanan aktif",
          definition: { formula: "Bilangan pesanan aktif.", source: "Rekod pesanan." },
          matches: () => true,
        },
        {
          key: "salam",
          label: "Salam",
          filterLabel: "Pesanan Salam Land",
          definition: { formula: "Bilangan pesanan Salam Land.", source: "Rekod pesanan." },
          matches: (row) => row.businessUnitCode === "salam-land",
          attributionModel: "Pesanan disahkan",
        },
      ],
    })).toMatchObject([
      {
        label: "Aktif",
        scope: {
          businessUnitCodes: ["salam-land", "bumi-hayat"],
          definitionHref: "/orders?definition=active&bu=all",
          drilldownHref: "/orders?metric=active&bu=all",
          attributionModel: null,
        },
        value: "2",
      },
      {
        label: "Salam",
        scope: {
          definitionHref: "/orders?definition=salam&bu=all",
          drilldownHref: "/orders?metric=salam&bu=all",
          attributionModel: "Pesanan disahkan",
        },
        value: "1",
      },
    ]);
  });

  it("builds a real scoped definition destination when report access is proven", () => {
    const reportScope: BusinessUnitReadScope = {
      ...allScope,
      units: access.map((unit) => ({
        ...unit,
        capabilities: [...unit.capabilities, "report.read"],
      })),
    };

    expect(createDemoModuleMetrics({
      scope: reportScope,
      capability: "order.read",
      modulePath: "/orders",
      dateBasis: "Tarikh pesanan",
      periodLabel: "30 hari",
      rows,
      metrics: [{
        key: "active",
        label: "Aktif",
        filterLabel: "Pesanan aktif",
        definition: { formula: "Bilangan pesanan aktif.", source: "Rekod pesanan." },
        matches: () => true,
      }],
    })[0]?.scope).toMatchObject({
      definitionHref: "/orders?definition=active&bu=all",
      drilldownHref: "/orders?metric=active&bu=all",
    });
  });

  it("rejects an unsafe metric key before constructing links", () => {
    expect(() => createDemoModuleMetrics({
      scope: allScope,
      capability: "order.read",
      modulePath: "/orders",
      dateBasis: "Tarikh pesanan",
      periodLabel: "30 hari",
      rows,
      metrics: [{
        key: "../finance",
        label: "Aktif",
        filterLabel: "Aktif",
        definition: { formula: "Bilangan.", source: "Rekod." },
        matches: () => true,
      }],
    })).toThrow("Metric key is invalid");
  });

  it("shows a company column and scoped metrics in Semua", () => {
    render(createElement(OperationalModule, {
      scope: allScope,
      metrics: [{
        key: "active",
        label: "Aktif",
        value: "2",
        scope: metricScope,
        definition: {
          key: "active",
          title: "Aktif",
          formula: "Bilangan.",
          source: "Rekod.",
          dateBasis: "Tarikh pesanan",
        },
        filterLabel: "Aktif",
        matchedRowIds: rows.map((row) => row.id),
      }],
      title: "Pesanan terkini",
      columns: [{ key: "order", label: "Pesanan" }],
      rows,
    }));

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Syarikat" })).toBeTruthy();
    expect(within(table).getByText("Salam Land")).toBeTruthy();
    expect(within(table).getByText("Bumi Hayat")).toBeTruthy();
    expect(screen.getByText("salam-land, bumi-hayat · 30 hari")).toBeTruthy();
  });

  it("filters rows by the resolved unit ID and omits the redundant company column", () => {
    const unitScope: BusinessUnitReadScope = {
      kind: "UNIT",
      queryValue: "salam-land",
      businessUnitId: "unit-salam",
      businessUnitCode: "salam-land",
      access: access[0],
      writable: true,
    };
    render(createElement(OperationalModule, {
      scope: unitScope,
      metrics: [],
      title: "Pesanan terkini",
      columns: [{ key: "order", label: "Pesanan" }],
      rows,
    }));
    expect(screen.getByText("SL-1")).toBeTruthy();
    expect(screen.queryByText("BH-1")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Syarikat" })).toBeNull();
  });

  it("visibly applies an allowlisted metric population and renders its definition", () => {
    const metrics = createDemoModuleMetrics({
      scope: allScope,
      capability: "order.read",
      modulePath: "/orders",
      dateBasis: "Tarikh pesanan",
      periodLabel: "30 hari",
      rows,
      metrics: [{
        key: "salam",
        label: "Salam",
        filterLabel: "Pesanan Salam Land",
        definition: { formula: "Bilangan pesanan Salam Land.", source: "Rekod pesanan." },
        matches: (row) => row.businessUnitCode === "salam-land",
      }],
    });
    render(createElement(OperationalModule, {
      scope: allScope,
      metrics,
      activeMetricKey: "salam",
      activeDefinitionKey: "salam",
      title: "Pesanan terkini",
      columns: [{ key: "order", label: "Pesanan" }],
      rows,
    }));

    expect(screen.getByRole("status").textContent).toContain("Tapis: Pesanan Salam Land");
    expect(screen.getByText("SL-1")).toBeTruthy();
    expect(screen.queryByText("BH-1")).toBeNull();
    expect(screen.getByRole("heading", { name: "Definisi Salam" })).toBeTruthy();
    expect(screen.getByText("Bilangan pesanan Salam Land.")).toBeTruthy();
    expect(screen.getByText("Rekod pesanan.")).toBeTruthy();
    expect(screen.getByText("Tarikh pesanan")).toBeTruthy();
  });
});
