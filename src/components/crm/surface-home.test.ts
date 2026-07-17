/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import { SurfaceHome } from "./surface-home";

afterEach(cleanup);

const salamAccess = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["lead.read", "opportunity.read", "task.read", "report.read"],
  capabilityRecordScopes: {},
} as const;
const unitScope: BusinessUnitReadScope = {
  kind: "UNIT",
  queryValue: salamAccess.code,
  businessUnitId: salamAccess.id,
  businessUnitCode: salamAccess.code,
  access: salamAccess,
  writable: true,
};

function home(props: Partial<Parameters<typeof SurfaceHome>[0]> = {}) {
  return createElement(SurfaceHome, {
    surface: "crm",
    demo: true,
    scope: unitScope,
    ...props,
  });
}

describe("SurfaceHome", () => {
  it("preserves the CRM demo dashboard for an explicit local demo viewer", () => {
    render(home());

    expect(screen.getByText("Lead baharu")).toBeTruthy();
    expect(screen.getByText(/Nur Aisyah/)).toBeTruthy();
    expect(screen.queryByText(/Bumi Hayat Printing/)).toBeNull();
    expect(screen.queryByText("Kutipan")).toBeNull();
    expect(screen.getAllByText(/salam-land/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Lihat rekod Lead baharu" }).getAttribute("href"))
      .toBe("/leads?stage=new&bu=salam-land");
    expect(screen.getByRole("link", { name: "Lihat rekod Nilai pipeline" }).getAttribute("href"))
      .toBe("/pipeline?metric=active&bu=salam-land");
    expect(screen.getByRole("link", { name: "Lihat rekod Susulan lewat" }).getAttribute("href"))
      .toBe("/tasks?metric=overdue&bu=salam-land");
    expect(screen.getByText("4 aktif", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: /Menang/ })).toBeNull();
  });

  it("keeps upcoming tasks out of the Hari ini population", () => {
    render(home());

    expect(screen.getByText("Hubungi Nur Aisyah", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Hantar sebut harga Lot C-031", { exact: true })).toBeNull();
  });

  it("renders a truthful CRM empty state without demo authority", () => {
    render(home({ demo: false }));

    expect(screen.getByText("Belum ada data.")).toBeTruthy();
    expect(screen.queryByText("Lead baharu")).toBeNull();
    expect(screen.queryByText("RM1.24j")).toBeNull();
    expect(screen.queryByText(/Nur Aisyah/)).toBeNull();
  });

  it("renders only Tasha's truthful unknown state even when demo fixtures are enabled", () => {
    render(home({ surface: "tasha" }));

    expect(screen.getByText("Data pengecualian belum tersedia.")).toBeTruthy();
    for (const leakedCopy of [
      "Lead baharu",
      "Pipeline",
      "RM1.24j",
      "RM286k",
      "Hari ini",
      "Nur Aisyah",
      "Daniel Wong",
    ]) {
      expect(screen.queryByText(leakedCopy)).toBeNull();
    }
  });

  it("labels cross-company rows and filters each KPI scope by its capability in Semua", () => {
    const bumiAccess = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["membership-bumi"],
      capabilities: ["opportunity.read", "task.read", "report.read"],
    } as const;
    const barakahAccess = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000103",
      name: "Barakah Emas",
      code: "barakah-emas",
      slug: "barakah-emas",
      membershipIds: ["membership-barakah"],
      capabilities: ["finance.read", "task.read", "report.read"],
    } as const;
    const scope: BusinessUnitReadScope = {
      kind: "ALL",
      queryValue: "all",
      units: [salamAccess, bumiAccess, barakahAccess],
      unitIds: [salamAccess.id, bumiAccess.id, barakahAccess.id],
      writable: false,
    };

    render(home({ scope }));

    expect(screen.getAllByText("Salam Land").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bumi Hayat Printing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Barakah Emas").length).toBeGreaterThan(0);
    expect(screen.getByText("salam-land · 30 hari")).toBeTruthy();
    expect(screen.queryByText("salam-land, bumi-hayat, barakah-emas · 30 hari")).toBeNull();
    expect(screen.getByRole("link", { name: "Semua" }).getAttribute("href")).toBe("/tasks?bu=all");
    expect(screen.getByRole("link", { name: "Lihat rekod Lead baharu" }).getAttribute("href"))
      .toBe("/leads?stage=new&bu=all");
    expect(screen.getByRole("link", { name: "Lihat rekod Susulan lewat" }).getAttribute("href"))
      .toBe("/tasks?metric=overdue&bu=all");
    expect(screen.getByRole("link", { name: "Lihat rekod Nilai pipeline" }).getAttribute("href"))
      .toBe("/pipeline?metric=active&bu=all");
    const collectionMetric = screen.getByText("Kutipan").closest("article");
    expect(collectionMetric).not.toBeNull();
    expect(within(collectionMetric!).getByRole("link", { name: "Lihat rekod Kutipan" }).getAttribute("href"))
      .toBe("/finance?metric=collections&bu=all");
  });

  it("aggregates full Semua KPI values from all three authorised per-unit inputs", () => {
    const fullCapabilities = [
      "lead.read",
      "opportunity.read",
      "task.read",
      "finance.read",
      "report.read",
    ];
    const units = [
      salamAccess,
      {
        ...salamAccess,
        id: "00000000-0000-4000-8000-000000000102",
        name: "Bumi Hayat Printing",
        code: "bumi-hayat",
        slug: "bumi-hayat",
      },
      {
        ...salamAccess,
        id: "00000000-0000-4000-8000-000000000103",
        name: "Barakah Emas",
        code: "barakah-emas",
        slug: "barakah-emas",
      },
    ].map((unit) => ({ ...unit, capabilities: fullCapabilities }));
    const scope: BusinessUnitReadScope = {
      kind: "ALL",
      queryValue: "all",
      units,
      unitIds: units.map((unit) => unit.id),
      writable: false,
    };

    render(home({ scope }));

    expect(screen.getByRole("link", { name: "Lihat rekod Lead baharu" }).getAttribute("href"))
      .toBe("/leads?stage=new&bu=all");
    expect(screen.getByRole("link", { name: "Lihat rekod Susulan lewat" }).getAttribute("href"))
      .toBe("/tasks?metric=overdue&bu=all");
    expect(screen.getByRole("link", { name: "Lihat rekod Nilai pipeline" }).getAttribute("href"))
      .toBe("/pipeline?metric=active&bu=all");
    const collectionMetric = screen.getByText("Kutipan").closest("article");
    expect(within(collectionMetric!).getByRole("link", { name: "Lihat rekod Kutipan" }).getAttribute("href"))
      .toBe("/finance?metric=collections&bu=all");
    expect(screen.getByText("7 aktif", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: /Menang/ })).toBeNull();
  });
});
