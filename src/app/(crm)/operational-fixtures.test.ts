import type { ReactNode } from "react";
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

import FinancePage from "./finance/page";
import InventoryPage from "./inventory/page";
import MarketingPage from "./marketing/page";
import OrdersPage from "./orders/page";
import ReportsPage from "./reports/page";
import SettingsPage from "./settings/page";
import TasksPage from "./tasks/page";
import TeamPage from "./team/page";

type Page = (input: {
  searchParams: Promise<{ bu?: string | string[] }>;
}) => ReactNode | Promise<ReactNode>;

const capabilities = [
  "finance.read",
  "inventory.read",
  "marketing.read",
  "order.read",
  "report.read",
  "settings.read",
  "task.read",
  "team.read",
] as const;
const salamAccess = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities,
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
const pageInput = { searchParams: Promise.resolve({ bu: "salam-land" }) };

const operationalPages: Array<{
  name: string;
  Page: Page;
  fixture: string;
  emptyLabel: string;
}> = [
  { name: "finance", Page: FinancePage, fixture: "RM12,500", emptyLabel: "Belum ada transaksi." },
  { name: "inventory", Page: InventoryPage, fixture: "A-118", emptyLabel: "Belum ada rekod inventori." },
  { name: "marketing", Page: MarketingPage, fixture: "Salam Land Julai", emptyLabel: "Belum ada kempen." },
  { name: "orders", Page: OrdersPage, fixture: "SL-2026-0481", emptyLabel: "Belum ada pesanan." },
  { name: "reports", Page: ReportsPage, fixture: "Prestasi jualan", emptyLabel: "Belum ada laporan." },
  { name: "settings", Page: SettingsPage, fixture: "Meta Lead Ads", emptyLabel: "Belum ada integrasi." },
  { name: "tasks", Page: TasksPage, fixture: "Hubungi pelanggan", emptyLabel: "Belum ada tugasan." },
  { name: "team", Page: TeamPage, fixture: "Eksekutif Jualan", emptyLabel: "Belum ada ahli pasukan." },
];

describe("operational fixture boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { demo: false }, scope: unitScope });
  });

  it.each(operationalPages)(
    "$name renders no static operational data for a non-demo viewer",
    async ({ Page, emptyLabel, fixture }) => {
      mocks.canRenderDemoFixtures.mockReturnValue(false);

      const html = renderToStaticMarkup(await Page(pageInput));

      expect(mocks.canRenderDemoFixtures).toHaveBeenCalledWith();
      expect(html).toContain(emptyLabel);
      expect(html).toContain('data-state-kind="empty"');
      expect(html).not.toContain(fixture);
    },
  );

  it("applies the task metric population and definition from allowlisted query keys", async () => {
    const bumiAccess = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["membership-bumi"],
    } as const;
    const barakahAccess = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000103",
      name: "Barakah Emas",
      code: "barakah-emas",
      slug: "barakah-emas",
      membershipIds: ["membership-barakah"],
    } as const;
    mocks.canRenderDemoFixtures.mockReturnValue(true);
    mocks.requireScopedPageViewer.mockResolvedValue({
      viewer: { demo: false },
      scope: {
        kind: "ALL",
        queryValue: "all",
        units: [salamAccess, bumiAccess, barakahAccess],
        unitIds: [salamAccess.id, bumiAccess.id, barakahAccess.id],
        writable: false,
      },
    });

    const html = renderToStaticMarkup(await TasksPage({
      searchParams: Promise.resolve({
        bu: "all",
        metric: "overdue",
        definition: "overdue",
      }),
    }));

    expect(html).toContain("Tapis: Susulan lewat · 2 rekod");
    expect(html).toContain("Bilangan tugasan berstatus lewat.");
    expect(html).toContain("Hubungi pelanggan");
    expect(html).toContain("Tamatkan pegangan");
    expect(html).not.toContain("Semak bukti bayaran");
    expect(html).not.toContain("Hantar sebut harga");
  });

  it.each(operationalPages)(
    "$name preserves its fixtures for the explicit demo viewer",
    async ({ Page, fixture }) => {
      mocks.canRenderDemoFixtures.mockReturnValue(true);

      const html = renderToStaticMarkup(await Page(pageInput));

      expect(html).toContain(fixture);
      expect(html).not.toContain("Bumi Hayat Printing");
      expect(html).not.toContain("Barakah Emas");
    },
  );

  it.each(operationalPages)(
    "$name labels every synthetic row in Semua",
    async ({ Page }) => {
      const bumiAccess = {
        ...salamAccess,
        id: "00000000-0000-4000-8000-000000000102",
        name: "Bumi Hayat Printing",
        code: "bumi-hayat",
        slug: "bumi-hayat",
        membershipIds: ["membership-bumi"],
      } as const;
      const barakahAccess = {
        ...salamAccess,
        id: "00000000-0000-4000-8000-000000000103",
        name: "Barakah Emas",
        code: "barakah-emas",
        slug: "barakah-emas",
        membershipIds: ["membership-barakah"],
      } as const;
      const allScope: BusinessUnitReadScope = {
        kind: "ALL",
        queryValue: "all",
        units: [salamAccess, bumiAccess, barakahAccess],
        unitIds: [salamAccess.id, bumiAccess.id, barakahAccess.id],
        writable: false,
      };
      mocks.canRenderDemoFixtures.mockReturnValue(true);
      mocks.requireScopedPageViewer.mockResolvedValue({ viewer: { demo: false }, scope: allScope });

      const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ bu: "all" }) }));

      expect(html).toContain("Salam Land");
      expect(html).toContain("Bumi Hayat Printing");
      expect(html).toContain("Barakah Emas");
      expect(html).toContain("Syarikat");
    },
  );
});
